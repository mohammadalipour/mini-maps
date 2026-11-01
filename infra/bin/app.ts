#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { DatabaseStack } from '../lib/database-stack';
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

// On-demand (~$15/month): only with `-c database=true`. To remove it, deploy Pipeline and Api
// without the flag first (drops their references), then `cdk destroy MiniMaps-Database`.
const database = [true, 'true'].includes(app.node.tryGetContext('database'))
  ? new DatabaseStack(app, 'MiniMaps-Database', { env, vpc: network.vpc })
  : undefined;

new PipelineStack(app, 'MiniMaps-Pipeline', {
  env,
  vpc: network.vpc,
  rawBucket: storage.rawBucket,
  tilesBucket: storage.tilesBucket,
  alertEmail: app.node.tryGetContext('alertEmail'),
  database,
});

// On-demand stack: ALB + Fargate cost money per hour, so deploy it when working or demoing
// and `cdk destroy MiniMaps-Api` afterwards.
new ApiStack(app, 'MiniMaps-Api', {
  env,
  vpc: network.vpc,
  tilesBucket: storage.tilesBucket,
  database,
});

Tags.of(app).add('project', 'mini-maps');
