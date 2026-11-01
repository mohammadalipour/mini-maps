import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';

export interface DatabaseStackProps extends StackProps {
  readonly vpc: ec2.IVpc;
}

/**
 * RDS Postgres + PostGIS for bbox feature queries (docs/adr/0006).
 * On-demand: ~$15/month while it exists, so it is only created with `-c database=true`.
 */
export class DatabaseStack extends Stack {
  readonly instance: rds.DatabaseInstance;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    this.instance = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17_9 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      publiclyAccessible: false,
      credentials: rds.Credentials.fromGeneratedSecret('minimaps_admin'),
      databaseName: 'minimaps',
      allocatedStorage: 20,
      maxAllocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false,
      backupRetention: Duration.days(1),
      enablePerformanceInsights: false,
      // Demo project: the data is rebuilt by the pipeline. Production would snapshot and protect it.
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
      deleteAutomatedBackups: true,
    });

    new CfnOutput(this, 'Endpoint', { value: this.instance.dbInstanceEndpointAddress });
  }

  /**
   * Lets `peer` reach Postgres. The ingress rule is created in the caller's stack, so this stack
   * never depends on its clients (which depend on it for the endpoint): no cross-stack cycle.
   */
  allowConnectionsFrom(scope: Construct, id: string, peer: ec2.ISecurityGroup, description: string): void {
    new ec2.CfnSecurityGroupIngress(scope, id, {
      groupId: this.instance.connections.securityGroups[0]!.securityGroupId,
      sourceSecurityGroupId: peer.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      description,
    });
  }

  /** Environment and secrets for an ECS container that connects to this database. */
  containerConfig(): { environment: Record<string, string>; secrets: Record<string, ecs.Secret> } {
    const secret = this.instance.secret!;
    return {
      environment: {
        DB_HOST: this.instance.dbInstanceEndpointAddress,
        DB_PORT: this.instance.dbInstanceEndpointPort,
        DB_NAME: 'minimaps',
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(secret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(secret, 'password'),
      },
    };
  }
}
