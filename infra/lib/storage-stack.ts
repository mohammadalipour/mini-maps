import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * Tile storage. Layout (see docs/adr/0002):
 *   tilesets/{id}/manifest.json            current version pointer, short cache
 *   tilesets/{id}/v{n}/{z}/{x}/{y}.mvt     immutable once written
 */
export class StorageStack extends Stack {
  readonly tilesBucket: s3.Bucket;
  /** Source GeoJSON. Uploading uploads/{tileset-id}.geojson starts the pipeline. */
  readonly rawBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const common: s3.BucketProps = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Demo project: everything can be re-uploaded or rebuilt. Production would RETAIN.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    };

    this.tilesBucket = new s3.Bucket(this, 'TilesBucket', {
      ...common,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(1) }],
    });

    this.rawBucket = new s3.Bucket(this, 'RawBucket', {
      ...common,
      eventBridgeEnabled: true,
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
        { prefix: 'uploads/', expiration: Duration.days(90) },
      ],
    });

    new CfnOutput(this, 'TilesBucketName', { value: this.tilesBucket.bucketName });
    new CfnOutput(this, 'RawBucketName', { value: this.rawBucket.bucketName });
  }
}
