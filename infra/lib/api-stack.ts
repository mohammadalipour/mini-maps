import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { ApiMonitoring } from './api-monitoring';
import type { DatabaseStack } from './database-stack';

export interface ApiStackProps extends StackProps {
  readonly vpc: ec2.IVpc;
  readonly tilesBucket: s3.IBucket;
  /** When set, the API serves bbox feature queries from PostGIS. */
  readonly database?: DatabaseStack;
  /** Optional email for API alarms. */
  readonly alertEmail?: string;
}

const CONTAINER_PORT = 3000;
const METRICS_NAMESPACE = 'MiniMaps/Api';

/**
 * Read path: CloudFront -> (VPC origin) -> internal ALB -> Fargate (Node.js) -> S3.
 *
 * The ALB is internal, so the only way in from the internet is through CloudFront.
 * See docs/adr/0003 for why this replaces a public ALB + secret header.
 */
export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { vpc, tilesBucket } = props;

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'Internal ALB, reached only by the CloudFront VPC origin',
      allowAllOutbound: false,
    });
    // VPC origin traffic arrives from CloudFront-managed ENIs inside this VPC.
    albSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(80), 'CloudFront VPC origin');

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroup: albSecurityGroup,
    });

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'Mini Maps API',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.VpcOrigin.withApplicationLoadBalancer(alb, {
          // Traffic stays on the AWS network; add HTTPS here once there is a domain + ACM cert.
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
        // The API decides cache lifetimes via Cache-Control; CloudFront just honours them.
        cachePolicy: new cloudfront.CachePolicy(this, 'OriginControlledCache', {
          comment: 'Mini Maps: cache per origin Cache-Control',
          defaultTtl: Duration.seconds(0),
          minTtl: Duration.seconds(0),
          maxTtl: Duration.days(365),
          queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
          enableAcceptEncodingGzip: true,
          enableAcceptEncodingBrotli: true,
        }),
      },
    });
    const publicBaseUrl = `https://${distribution.distributionDomainName}`;

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64, // ~20% cheaper than x86 on Fargate
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const db = props.database?.containerConfig();
    taskDefinition.addContainer('api', {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../../services/api'), {
        platform: Platform.LINUX_ARM64,
      }),
      portMappings: [{ containerPort: CONTAINER_PORT }],
      environment: {
        PORT: String(CONTAINER_PORT),
        TILE_STORE: 's3',
        TILES_BUCKET: tilesBucket.bucketName,
        PUBLIC_BASE_URL: publicBaseUrl,
        METRICS_NAMESPACE,
        ...db?.environment,
      },
      secrets: db?.secrets,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'api',
        logGroup: new logs.LogGroup(this, 'ApiLogs', {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      }),
    });
    tilesBucket.grantRead(taskDefinition.taskRole);
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'], // PutMetricData has no resource ARNs; scoped by namespace instead
        conditions: { StringEquals: { 'cloudwatch:namespace': METRICS_NAMESPACE } },
      }),
    );

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      // No NAT gateway: a public IP lets the task reach ECR and CloudWatch Logs.
      // Its security group only accepts traffic from the ALB.
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      minHealthyPercent: 100,
      circuitBreaker: { rollback: true },
    });

    props.database?.allowConnectionsFrom(this, 'PostgresFromApi', service.connections.securityGroups[0]!, 'API reads features');

    const listener = alb.addListener('Http', { port: 80, open: false });
    const targetGroup = listener.addTargets('Api', {
      port: CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        path: '/health',
        interval: Duration.seconds(15),
        healthyThresholdCount: 2,
      },
    });

    service
      .autoScaleTaskCount({ minCapacity: 1, maxCapacity: 3 })
      .scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60 });

    new ApiMonitoring(this, 'Monitoring', {
      alb,
      targetGroup,
      service,
      distribution,
      metricsNamespace: METRICS_NAMESPACE,
      alertEmail: props.alertEmail,
    });

    new CfnOutput(this, 'ApiUrl', { value: publicBaseUrl });
  }
}
