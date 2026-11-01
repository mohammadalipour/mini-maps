import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { ApiStack } from '../lib/api-stack';
import { NetworkStack } from '../lib/network-stack';
import { StorageStack } from '../lib/storage-stack';

let api: Template;

beforeAll(() => {
  const app = new App();
  const network = new NetworkStack(app, 'Network');
  const storage = new StorageStack(app, 'Storage');
  const stack = new ApiStack(app, 'Api', {
    vpc: network.vpc,
    tilesBucket: storage.tilesBucket,
    alertEmail: 'oncall@example.com',
  });
  api = Template.fromStack(stack);
});

describe('API alarms', () => {
  it('alarms on p99 latency above 500 ms', () => {
    api.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'TargetResponseTime',
      ExtendedStatistic: 'p99',
      Threshold: 0.5,
      DatapointsToAlarm: 3,
      EvaluationPeriods: 5,
    });
  });

  it('alarms on a 5xx rate above 1%, counting ALB and target errors', () => {
    const [alarm] = Object.values(
      api.findResources('AWS::CloudWatch::Alarm', { Properties: { Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold' } }),
    );
    const metricNames = JSON.stringify(alarm?.Properties.Metrics);
    for (const name of ['RequestCount', 'HTTPCode_Target_5XX_Count', 'HTTPCode_ELB_5XX_Count']) {
      expect(metricNames).toContain(name);
    }
  });

  it('treats missing health data as an outage', () => {
    api.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'HealthyHostCount',
      ComparisonOperator: 'LessThanThreshold',
      TreatMissingData: 'breaching',
    });
  });

  it('notifies the alert topic on alarm and recovery', () => {
    const alarms = Object.values(api.findResources('AWS::CloudWatch::Alarm'));
    expect(alarms).toHaveLength(3);
    for (const alarm of alarms) {
      expect(alarm.Properties.AlarmActions).toHaveLength(1);
      expect(alarm.Properties.OKActions).toHaveLength(1);
    }
    api.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'oncall@example.com' });
  });
});

describe('API dashboard', () => {
  it('shows CloudFront, ALB, per-route and ECS metrics', () => {
    const [dashboard] = Object.values(api.findResources('AWS::CloudWatch::Dashboard'));
    const body = JSON.stringify(dashboard?.Properties.DashboardBody);
    for (const text of ['AWS/CloudFront', 'us-east-1', 'TargetResponseTime', 'MiniMaps/Api', 'CPUUtilization']) {
      expect(body).toContain(text);
    }
  });
});

describe('API metrics publishing', () => {
  it('may only publish to its own namespace', () => {
    api.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'cloudwatch:PutMetricData',
            Condition: { StringEquals: { 'cloudwatch:namespace': 'MiniMaps/Api' } },
          }),
        ]),
      },
    });
  });

  it('tells the container where to publish', () => {
    const [taskDef] = Object.values(api.findResources('AWS::ECS::TaskDefinition'));
    expect(taskDef?.Properties.ContainerDefinitions[0].Environment).toEqual(
      expect.arrayContaining([{ Name: 'METRICS_NAMESPACE', Value: 'MiniMaps/Api' }]),
    );
  });
});
