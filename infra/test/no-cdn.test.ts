import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { ApiStack } from '../lib/api-stack';
import { NetworkStack } from '../lib/network-stack';
import { StorageStack } from '../lib/storage-stack';

// `-c cdn=false`: for accounts where CloudFront isn't available (docs/adr/0008).
let api: Template;

beforeAll(() => {
  const app = new App();
  const network = new NetworkStack(app, 'Network');
  const storage = new StorageStack(app, 'Storage');
  const stack = new ApiStack(app, 'Api', {
    vpc: network.vpc,
    tilesBucket: storage.tilesBucket,
    cdn: false,
  });
  api = Template.fromStack(stack);
});

describe('ApiStack without a CDN', () => {
  it('creates no CloudFront resources', () => {
    api.resourceCountIs('AWS::CloudFront::Distribution', 0);
    api.resourceCountIs('AWS::CloudFront::VpcOrigin', 0);
    api.resourceCountIs('AWS::CloudFront::CachePolicy', 0);
  });

  it('uses a public load balancer open on port 80 only', () => {
    api.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internet-facing' });
    api.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Public ALB (no CDN)',
      SecurityGroupIngress: [Match.objectLike({ CidrIp: '0.0.0.0/0', FromPort: 80, ToPort: 80 })],
    });
  });

  it('still only lets the ALB talk to the tasks', () => {
    const rules = Object.values(api.findResources('AWS::EC2::SecurityGroupIngress', { Properties: { FromPort: 3000 } }));
    expect(rules).toHaveLength(1);
    expect(rules[0]?.Properties).toHaveProperty('SourceSecurityGroupId');
  });

  it('tells the API its public URL is the ALB over HTTP', () => {
    const [taskDefinition] = Object.values(api.findResources('AWS::ECS::TaskDefinition'));
    const env = JSON.stringify(taskDefinition?.Properties.ContainerDefinitions[0].Environment);
    expect(env).toContain('"Name":"PUBLIC_BASE_URL"');
    expect(env).toContain('http://');
    expect(env).toContain('DNSName');
  });

  it('keeps the alarms and drops CloudFront from the dashboard', () => {
    api.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    const [dashboard] = Object.values(api.findResources('AWS::CloudWatch::Dashboard'));
    expect(JSON.stringify(dashboard?.Properties.DashboardBody)).not.toContain('AWS/CloudFront');
  });
});
