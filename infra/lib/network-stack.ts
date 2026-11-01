import { Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

/**
 * Shared VPC with no NAT gateways (each one is ~$33/month).
 *
 * - public subnets: Fargate tasks (public IP so they can pull images and ship logs)
 * - isolated subnets: internal ALB and, later, RDS; no route to the internet
 * - S3 gateway endpoint (free) keeps S3 traffic inside AWS
 */
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });
  }
}
