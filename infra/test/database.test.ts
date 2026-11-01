import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { ApiStack } from '../lib/api-stack';
import { DatabaseStack } from '../lib/database-stack';
import { NetworkStack } from '../lib/network-stack';
import { PipelineStack } from '../lib/pipeline-stack';
import { StorageStack } from '../lib/storage-stack';

let db: Template;
let pipeline: Template;
let api: Template;
let assembly: ReturnType<App['synth']>;

beforeAll(() => {
  const app = new App();
  const network = new NetworkStack(app, 'Network');
  const storage = new StorageStack(app, 'Storage');
  const database = new DatabaseStack(app, 'Database', { vpc: network.vpc });
  const pipelineStack = new PipelineStack(app, 'Pipeline', {
    vpc: network.vpc,
    rawBucket: storage.rawBucket,
    tilesBucket: storage.tilesBucket,
    database,
  });
  const apiStack = new ApiStack(app, 'Api', { vpc: network.vpc, tilesBucket: storage.tilesBucket, database });
  db = Template.fromStack(database);
  pipeline = Template.fromStack(pipelineStack);
  api = Template.fromStack(apiStack);
  assembly = app.synth(); // throws on cyclic cross-stack references
});

function containerDefinition(template: Template) {
  const [taskDef] = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  return taskDef?.Properties.ContainerDefinitions[0];
}

describe('DatabaseStack', () => {
  it('runs a small, private, encrypted Postgres 17', () => {
    db.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^17\\.'),
      DBInstanceClass: 'db.t4g.micro',
      PubliclyAccessible: false,
      StorageEncrypted: true,
      MultiAZ: false,
      AllocatedStorage: '20',
    });
  });

  it('lives in the isolated subnets', () => {
    db.hasResourceProperties('AWS::RDS::DBSubnetGroup', {
      SubnetIds: Match.arrayWith([Match.objectLike({ 'Fn::ImportValue': Match.stringLikeRegexp('isolated') })]),
    });
  });

  it('only accepts Postgres traffic from the tile builder and the API', () => {
    const rules = [pipeline, api, db].flatMap((t) =>
      Object.values(t.findResources('AWS::EC2::SecurityGroupIngress', { Properties: { FromPort: 5432 } })),
    );
    expect(rules).toHaveLength(2);
    for (const rule of rules) expect(rule.Properties).toHaveProperty('SourceSecurityGroupId');
  });

  it('synthesizes without dependency cycles', () => {
    expect(assembly.stacks.map((s) => s.stackName).sort()).toEqual(['Api', 'Database', 'Network', 'Pipeline', 'Storage']);
  });
});

describe.each([
  ['tile builder', () => pipeline],
  ['API', () => api],
])('%s container', (_name, template) => {
  it('gets the endpoint as environment and credentials from Secrets Manager', () => {
    const container = containerDefinition(template());
    const envNames = container.Environment.map((e: { Name: string }) => e.Name);
    expect(envNames).toEqual(expect.arrayContaining(['DB_HOST', 'DB_PORT', 'DB_NAME']));
    expect(container.Secrets.map((s: { Name: string }) => s.Name).sort()).toEqual(['DB_PASSWORD', 'DB_USER']);
    expect(JSON.stringify(container.Environment)).not.toContain('PASSWORD');
  });
});
