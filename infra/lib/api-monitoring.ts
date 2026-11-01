import { Duration } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface ApiMonitoringProps {
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  readonly service: ecs.FargateService;
  readonly distribution: cloudfront.Distribution;
  /** Namespace the API publishes per-route metrics to (services/api/src/metrics). */
  readonly metricsNamespace: string;
  readonly alertEmail?: string;
}

const ROUTES = ['tiles', 'tilejson', 'features'] as const;
const MINUTE = Duration.minutes(1);

/**
 * Alarms and a dashboard for the read path (docs/adr/0007).
 *
 * Alarms use the ALB's built-in metrics: free, and they still report when the app is down.
 * The dashboard adds CloudFront (us-east-1 only, so it can't drive alarms here) and the API's
 * per-route metrics.
 */
export class ApiMonitoring extends Construct {
  readonly alerts: sns.Topic;

  constructor(scope: Construct, id: string, props: ApiMonitoringProps) {
    super(scope, id);
    const { alb, targetGroup, service, distribution, metricsNamespace } = props;

    this.alerts = new sns.Topic(this, 'Alerts', { displayName: 'Mini Maps API alerts' });
    if (props.alertEmail) this.alerts.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));
    const notify = new cwActions.SnsAction(this.alerts);

    // --- Metrics ---------------------------------------------------------------------------
    const p99Latency = targetGroup.metrics.targetResponseTime({ statistic: 'p99', period: MINUTE });
    const p50Latency = targetGroup.metrics.targetResponseTime({ statistic: 'p50', period: MINUTE });
    const requests = alb.metrics.requestCount({ period: MINUTE });
    const target5xx = alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: MINUTE });
    const elb5xx = alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: MINUTE });
    const healthyTasks = targetGroup.metrics.healthyHostCount({ statistic: 'Minimum', period: MINUTE });
    // ELB 5xx counts too: with no healthy task the ALB answers 502/503 itself.
    const errorRate = new cloudwatch.MathExpression({
      label: '5xx rate (%)',
      expression: 'IF(requests > 0, 100 * (FILL(target5xx, 0) + FILL(elb5xx, 0)) / requests, 0)',
      usingMetrics: { requests, target5xx, elb5xx },
      period: MINUTE,
    });

    const cloudFrontMetric = (metricName: string, statistic: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/CloudFront',
        metricName,
        dimensionsMap: { DistributionId: distribution.distributionId, Region: 'Global' },
        region: 'us-east-1',
        statistic,
        period: MINUTE,
      });

    const routeMetric = (metricName: string, statistic: string) =>
      ROUTES.map(
        (route) =>
          new cloudwatch.Metric({
            namespace: metricsNamespace,
            metricName,
            dimensionsMap: { Route: route },
            statistic,
            period: MINUTE,
            label: route,
          }),
      );

    // --- Alarms (see docs/RUNBOOK.md) ---------------------------------------------------
    const alarms = [
      p99Latency.createAlarm(this, 'HighLatency', {
        alarmDescription: 'API p99 latency above 500 ms. See RUNBOOK.md',
        threshold: 0.5, // seconds
        evaluationPeriods: 5,
        datapointsToAlarm: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      errorRate.createAlarm(this, 'HighErrorRate', {
        alarmDescription: 'API 5xx rate above 1%. See RUNBOOK.md',
        threshold: 1,
        evaluationPeriods: 5,
        datapointsToAlarm: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      healthyTasks.createAlarm(this, 'NoHealthyTasks', {
        alarmDescription: 'No healthy API task behind the load balancer. See RUNBOOK.md',
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 2,
        // A missing metric here means something is badly wrong, not that all is quiet.
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),
    ];
    for (const alarm of alarms) {
      alarm.addAlarmAction(notify);
      alarm.addOkAction(notify);
    }

    // --- Dashboard -----------------------------------------------------------------------
    const graph = (title: string, left: cloudwatch.IMetric[], right: cloudwatch.IMetric[] = [], width = 8) =>
      new cloudwatch.GraphWidget({ title, left, right, width, height: 6 });

    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'MiniMaps-Api',
      defaultInterval: Duration.hours(3),
      widgets: [
        [new cloudwatch.AlarmStatusWidget({ title: 'Alarms', alarms, width: 24, height: 3 })],
        [
          graph('CloudFront: requests and 5xx %', [cloudFrontMetric('Requests', 'Sum')], [cloudFrontMetric('5xxErrorRate', 'Average')]),
          graph('ALB: latency (s)', [p50Latency, p99Latency]),
          graph('ALB: requests and 5xx %', [requests], [errorRate]),
        ],
        [
          graph('API: p99 latency by route (ms)', routeMetric('Latency', 'p99')),
          graph('API: requests by route', routeMetric('Requests', 'Sum')),
          graph('ECS: CPU / memory (%) and healthy tasks', [
            service.metricCpuUtilization({ period: MINUTE }),
            service.metricMemoryUtilization({ period: MINUTE }),
          ], [healthyTasks]),
        ],
      ],
    });
  }
}
