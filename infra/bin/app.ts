#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { NetworkStack } from '../lib/network-stack';
import { PipelineStack } from '../lib/pipeline-stack';
import { StorageStack } from '../lib/storage-stack';

const app = new App();

// Pinned to Frankfurt by default; override with CDK_DEPLOY_REGION.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEPLOY_REGION ?? 'eu-central-1',
};

// Always-on stacks: free or close to free.
const network = new NetworkStack(app, 'MiniMaps-Network', { env });
const storage = new StorageStack(app, 'MiniMaps-Storage', { env });
new PipelineStack(app, 'MiniMaps-Pipeline', {
  env,
  vpc: network.vpc,
  rawBucket: storage.rawBucket,
  tilesBucket: storage.tilesBucket,
  alertEmail: app.node.tryGetContext('alertEmail'),
});

// On-demand stack: ALB + Fargate cost money per hour, so deploy it when working or demoing
// and `cdk destroy MiniMaps-Api` afterwards.
new ApiStack(app, 'MiniMaps-Api', {
  env,
  vpc: network.vpc,
  tilesBucket: storage.tilesBucket,
});

Tags.of(app).add('project', 'mini-maps');
