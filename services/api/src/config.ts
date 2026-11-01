export type TileStoreConfig = { kind: 's3'; bucket: string } | { kind: 'fs'; root: string };

export interface Config {
  host: string;
  port: number;
  logLevel: string;
  publicBaseUrl?: string;
  manifestCacheTtlMs: number;
  mapboxAccessToken?: string;
  defaultTileset?: string;
  tileStore: TileStoreConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 3000),
    logLevel: env.LOG_LEVEL ?? 'info',
    publicBaseUrl: env.PUBLIC_BASE_URL,
    manifestCacheTtlMs: Number(env.MANIFEST_CACHE_TTL_MS ?? 30_000),
    mapboxAccessToken: env.MAPBOX_ACCESS_TOKEN,
    defaultTileset: env.DEFAULT_TILESET,
    tileStore: loadTileStoreConfig(env),
  };
}

function loadTileStoreConfig(env: NodeJS.ProcessEnv): TileStoreConfig {
  const kind = env.TILE_STORE ?? 's3';
  if (kind === 'fs') return { kind, root: required(env, 'TILE_ROOT') };
  if (kind === 's3') return { kind, bucket: required(env, 'TILES_BUCKET') };
  throw new Error(`TILE_STORE must be "s3" or "fs", got "${kind}"`);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
