import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { ApiStack } from '../lib/api-stack';
import { NetworkStack } from '../lib/network-stack';
import { StorageStack } from '../lib/storage-stack';

let network: Template;
let storage: Template;
let api: Template;

beforeAll(() => {
  const app = new App();
  const networkStack = new NetworkStack(app, 'Network');
  const storageStack = new StorageStack(app, 'Storage');
  const apiStack = new ApiStack(app, 'Api', {
    vpc: networkStack.vpc,
    tilesBucket: storageStack.tilesBucket,
  });
  network = Template.fromStack(networkStack);
  storage = Template.fromStack(storageStack);
  api = Template.fromStack(apiStack);
});

describe('NetworkStack', () => {
  it('has no NAT gateways', () => {
    network.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  it('routes S3 through a gateway endpoint', () => {
    network.hasResourceProperties('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway' });
  });
});

describe('StorageStack', () => {
  it('keeps the tiles bucket private and TLS-only', () => {
    storage.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    storage.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });
});

describe('ApiStack', () => {
  it('uses an internal load balancer', () => {
    api.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internal' });
  });

  it('reaches the ALB through a CloudFront VPC origin', () => {
    api.resourceCountIs('AWS::CloudFront::VpcOrigin', 1);
    api.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
      }),
    });
  });

  it('runs the API on small ARM64 Fargate tasks', () => {
    api.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '256',
      Memory: '512',
      RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
    });
  });

  it('only lets the ALB talk to the tasks', () => {
    const ingress = api.findResources('AWS::EC2::SecurityGroupIngress', {
      Properties: { FromPort: 3000 },
    });
    const rules = Object.values(ingress);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.Properties).toHaveProperty('SourceSecurityGroupId');
  });

  it('grants the task read-only access to tiles', () => {
    const policies = api.findResources('AWS::IAM::Policy');
    const actions = JSON.stringify(policies);
    expect(actions).toContain('s3:GetObject');
    expect(actions).not.toContain('s3:PutObject');
  });
});
