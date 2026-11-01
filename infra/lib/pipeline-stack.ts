import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import type { DatabaseStack } from './database-stack';

export interface PipelineStackProps extends StackProps {
  readonly vpc: ec2.IVpc;
  readonly rawBucket: s3.IBucket;
  readonly tilesBucket: s3.IBucket;
  /** Optional email for pipeline failure alerts. */
  readonly alertEmail?: string;
  /** When set, the tile builder also loads features into PostGIS. */
  readonly database?: DatabaseStack;
}

const PIPELINE_DIR = path.join(__dirname, '../../pipeline');

/**
 * Write path (docs/adr/0005):
 *   S3 raw upload -> EventBridge -> Step Functions:
 *     Validate (Lambda) -> BuildTiles (ECS Fargate, tippecanoe) -> exit code check -> Publish (Lambda)
 *   Any failure -> SNS alert -> Fail. A CloudWatch alarm on failed executions also pages SNS.
 *
 * Everything here is pay-per-use: idle cost is ~$0.
 */
export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);
    const { vpc, rawBucket, tilesBucket } = props;

    const alerts = new sns.Topic(this, 'PipelineAlerts', { displayName: 'Mini Maps pipeline alerts' });
    if (props.alertEmail) alerts.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));

    // --- Lambdas (Python, ARM64, boto3 comes with the runtime) -----------------------------
    const lambdaCode = lambda.Code.fromAsset(path.join(PIPELINE_DIR, 'lambdas'), {
      exclude: ['__pycache__', '*.pyc'],
    });
    const pythonFunction = (name: string, handler: string, props: Partial<lambda.FunctionProps>) =>
      new lambda.Function(this, name, {
        runtime: lambda.Runtime.PYTHON_3_13,
        architecture: lambda.Architecture.ARM_64,
        code: lambdaCode,
        handler,
        timeout: Duration.minutes(1),
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        ...props,
      });

    const validateFn = pythonFunction('ValidateFunction', 'validate.handler', { memorySize: 1024 });
    rawBucket.grantRead(validateFn);

    const publishFn = pythonFunction('PublishFunction', 'publish.handler', {
      memorySize: 256,
      environment: { TILES_BUCKET: tilesBucket.bucketName },
    });
    tilesBucket.grantRead(publishFn);
    tilesBucket.grantPut(publishFn, 'tilesets/*/manifest.json');

    // --- Tile builder (ECS Fargate task, tippecanoe) ----------------------------------------
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    const builderTask = new ecs.FargateTaskDefinition(this, 'TileBuilderTask', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      // x86: tippecanoe compiles natively on CI runners and Intel laptops. A batch job runs for
      // about a minute, so ARM's ~20% saving is worth less than faster, simpler builds.
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const db = props.database?.containerConfig();
    const builderContainer = builderTask.addContainer('tile-builder', {
      image: ecs.ContainerImage.fromAsset(path.join(PIPELINE_DIR, 'tile_builder'), {
        platform: Platform.LINUX_AMD64,
      }),
      environment: { TILES_BUCKET: tilesBucket.bucketName, ...db?.environment },
      secrets: db?.secrets,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'tile-builder',
        logGroup: new logs.LogGroup(this, 'TileBuilderLogs', {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      }),
    });
    rawBucket.grantRead(builderTask.taskRole);
    tilesBucket.grantPut(builderTask.taskRole, 'tilesets/*');

    // Outbound only (S3, ECR, logs). Public IP instead of a NAT gateway, see docs/adr/0003.
    const builderSecurityGroup = new ec2.SecurityGroup(this, 'TileBuilderSecurityGroup', {
      vpc,
      description: 'Tile builder tasks: outbound only',
    });
    props.database?.allowConnectionsFrom(this, 'PostgresFromTileBuilder', builderSecurityGroup, 'Tile builder loads features');

    // --- State machine -------------------------------------------------------------------
    const notifyFailure = new tasks.SnsPublish(this, 'NotifyFailure', {
      topic: alerts,
      subject: 'Mini Maps pipeline failed',
      message: sfn.TaskInput.fromText(
        sfn.JsonPath.format(
          'Execution {} failed. State: {}',
          sfn.JsonPath.executionId,
          sfn.JsonPath.jsonToString(sfn.JsonPath.objectAt('$')),
        ),
      ),
      resultPath: sfn.JsonPath.DISCARD,
    }).next(new sfn.Fail(this, 'Failed', { error: 'PipelineFailed' }));

    const validate = new tasks.LambdaInvoke(this, 'Validate', {
      lambdaFunction: validateFn,
      outputPath: '$.Payload',
    }).addCatch(notifyFailure, { resultPath: '$.error' });

    const buildTiles = new tasks.EcsRunTask(this, 'BuildTiles', {
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      cluster,
      taskDefinition: builderTask,
      launchTarget: new tasks.EcsFargateLaunchTarget({ platformVersion: ecs.FargatePlatformVersion.LATEST }),
      assignPublicIp: true,
      subnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [builderSecurityGroup],
      containerOverrides: [
        {
          containerDefinition: builderContainer,
          environment: [
            { name: 'SOURCE_BUCKET', value: sfn.JsonPath.stringAt('$.sourceBucket') },
            { name: 'SOURCE_KEY', value: sfn.JsonPath.stringAt('$.sourceKey') },
            { name: 'TILESET_ID', value: sfn.JsonPath.stringAt('$.tilesetId') },
            // Container env values must be strings; States.Format turns the number into one.
            { name: 'VERSION', value: sfn.JsonPath.format('{}', sfn.JsonPath.stringAt('$.version')) },
          ],
        },
      ],
      taskTimeout: sfn.Timeout.duration(Duration.minutes(30)),
      resultSelector: { 'exitCode.$': '$.Containers[0].ExitCode' },
      resultPath: '$.build',
    })
      .addRetry({ errors: ['ECS.AmazonECSException'], interval: Duration.seconds(30), maxAttempts: 2, backoffRate: 2 })
      .addCatch(notifyFailure, { resultPath: '$.error' });

    const publish = new tasks.LambdaInvoke(this, 'Publish', {
      lambdaFunction: publishFn,
      outputPath: '$.Payload',
    })
      .addRetry({ errors: ['ConcurrentPublishError'], interval: Duration.seconds(2), maxAttempts: 3, backoffRate: 2 })
      .addCatch(notifyFailure, { resultPath: '$.error' });

    const definition = validate
      .next(buildTiles)
      .next(
        new sfn.Choice(this, 'Build succeeded?')
          .when(sfn.Condition.numberEquals('$.build.exitCode', 0), publish)
          .otherwise(notifyFailure),
      );

    const stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.hours(1),
      logs: {
        destination: new logs.LogGroup(this, 'StateMachineLogs', {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ERROR,
      },
    });

    // --- Trigger: new GeoJSON in uploads/ ----------------------------------------------------
    new events.Rule(this, 'OnUpload', {
      description: 'Start the tile pipeline when GeoJSON lands in uploads/',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [rawBucket.bucketName] },
          object: { key: [{ wildcard: 'uploads/*.geojson' }] },
        },
      },
      targets: [
        new targets.SfnStateMachine(stateMachine, {
          input: events.RuleTargetInput.fromObject({
            bucket: events.EventField.fromPath('$.detail.bucket.name'),
            key: events.EventField.fromPath('$.detail.object.key'),
            time: events.EventField.time,
          }),
        }),
      ],
    });

    // Catches what the state machine's own Catch cannot: timeouts and aborted executions.
    stateMachine
      .metricFailed({ period: Duration.minutes(5), statistic: cloudwatch.Stats.SUM })
      .createAlarm(this, 'FailedExecutionsAlarm', {
        alarmDescription: 'Tile pipeline execution failed. See RUNBOOK.md',
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(new cwActions.SnsAction(alerts));

    new CfnOutput(this, 'StateMachineArn', { value: stateMachine.stateMachineArn });
  }
}
