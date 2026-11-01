import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PostgresFeatureStore, createPool } from './features/feature-store.js';
import { FsTileStore } from './tiles/fs-tile-store.js';
import { S3TileStore } from './tiles/s3-tile-store.js';

const config = loadConfig();

const tileStore =
  config.tileStore.kind === 's3'
    ? new S3TileStore(new S3Client({}), config.tileStore.bucket)
    : new FsTileStore(path.resolve(config.tileStore.root));

const db = config.database;
const featureStore = db
  ? new PostgresFeatureStore(createPool({ ...db, ca: db.caFile ? readFileSync(db.caFile, 'utf8') : undefined }))
  : undefined;

const app = buildApp({
  tileStore,
  featureStore,
  publicBaseUrl: config.publicBaseUrl,
  manifestCacheTtlMs: config.manifestCacheTtlMs,
  mapboxAccessToken: config.mapboxAccessToken,
  defaultTileset: config.defaultTileset,
  logger: { level: config.logLevel },
});

// ECS sends SIGTERM on deploys and scale-in; finish in-flight requests before exiting.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: config.host, port: config.port });
