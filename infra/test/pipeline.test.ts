import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { NetworkStack } from '../lib/network-stack';
import { PipelineStack } from '../lib/pipeline-stack';
import { StorageStack } from '../lib/storage-stack';

let pipeline: Template;
let storage: Template;
let definition: { States: Record<string, any>; StartAt: string };

beforeAll(() => {
  const app = new App();
  const network = new NetworkStack(app, 'Network');
  const storageStack = new StorageStack(app, 'Storage');
  const stack = new PipelineStack(app, 'Pipeline', {
    vpc: network.vpc,
    rawBucket: storageStack.rawBucket,
    tilesBucket: storageStack.tilesBucket,
    alertEmail: 'oncall@example.com',
  });
  pipeline = Template.fromStack(stack);
  storage = Template.fromStack(storageStack);

  const [machine] = Object.values(pipeline.findResources('AWS::StepFunctions::StateMachine'));
  definition = JSON.parse(renderDefinition(machine?.Properties.DefinitionString));
});

/** DefinitionString is an Fn::Join of strings and tokens; tokens are replaced by placeholders. */
function renderDefinition(value: any): string {
  if (typeof value === 'string') return value;
  const [, parts] = value['Fn::Join'];
  return parts.map((part: unknown) => (typeof part === 'string' ? part : 'TOKEN')).join('');
}

describe('StorageStack raw bucket', () => {
  it('sends S3 events to EventBridge', () => {
    storage.hasResourceProperties('Custom::S3BucketNotifications', {
      NotificationConfiguration: { EventBridgeConfiguration: {} },
    });
  });
});

describe('PipelineStack', () => {
  it('runs Validate -> BuildTiles -> check -> Publish', () => {
    expect(definition.StartAt).toBe('Validate');
    expect(definition.States.Validate.Next).toBe('BuildTiles');
    expect(definition.States.BuildTiles.Next).toBe('Build succeeded?');
    expect(definition.States['Build succeeded?'].Choices[0]).toMatchObject({
      Variable: '$.build.exitCode',
      NumericEquals: 0,
      Next: 'Publish',
    });
    expect(definition.States['Build succeeded?'].Default).toBe('NotifyFailure');
  });

  it('waits for the ECS task to finish', () => {
    expect(definition.States.BuildTiles.Resource).toContain('ecs:runTask.sync');
  });

  it('sends every failure to the alert topic', () => {
    for (const state of ['Validate', 'BuildTiles', 'Publish']) {
      expect(definition.States[state].Catch[0].Next).toBe('NotifyFailure');
    }
    expect(definition.States.NotifyFailure.Next).toBe('Failed');
  });

  it('retries conflicting publishes but not invalid input', () => {
    const retries = definition.States.Publish.Retry.flatMap((r: { ErrorEquals: string[] }) => r.ErrorEquals);
    expect(retries).toContain('ConcurrentPublishError');
    const validateRetries = definition.States.Validate.Retry.flatMap((r: { ErrorEquals: string[] }) => r.ErrorEquals);
    expect(validateRetries).not.toContain('InvalidInputError');
  });

  it('starts on GeoJSON uploads to the raw bucket', () => {
    pipeline.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.s3'],
        'detail-type': ['Object Created'],
        detail: { bucket: { name: Match.anyValue() }, object: { key: [{ wildcard: 'uploads/*.geojson' }] } },
      }),
    });
  });

  it('runs Python 3.13 Lambdas on ARM64', () => {
    pipeline.resourcePropertiesCountIs(
      'AWS::Lambda::Function',
      { Runtime: 'python3.13', Architectures: ['arm64'] },
      2,
    );
  });

  it('only lets the publish Lambda write manifests', () => {
    const policies = JSON.stringify(pipeline.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('tilesets/*/manifest.json');
  });

  it('alarms on failed executions', () => {
    pipeline.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ExecutionsFailed',
      Threshold: 1,
      AlarmActions: Match.anyValue(),
    });
    pipeline.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'oncall@example.com' });
  });
});
