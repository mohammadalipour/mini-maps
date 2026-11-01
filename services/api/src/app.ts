import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import { type FeatureStore, parseBbox } from './features/feature-store.js';
import type { TileStore, TilesetManifest } from './tiles/tile-store.js';
import { TtlCache } from './ttl-cache.js';
import { viewerHtml } from './viewer.js';

export const MAX_ZOOM = 22;

// Versioned tile URLs never change, so they can be cached for a year (docs/adr/0002).
const TILE_CACHE = 'public, max-age=31536000, immutable';
// Empty tiles get a shorter life in case someone requests a version before it is published.
const EMPTY_TILE_CACHE = 'public, max-age=300';
// TileJSON is the pointer to the current version, so it must refresh quickly.
const TILEJSON_CACHE = 'public, max-age=60';

const MVT_CONTENT_TYPE = 'application/vnd.mapbox-vector-tile';

export const MAX_FEATURES = 1000;

const tilesetIdSchema = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' } as const;

export interface AppOptions {
  tileStore: TileStore;
  /** PostGIS-backed bbox queries; the endpoint answers 503 when not configured. */
  featureStore?: FeatureStore;
  /** Base URL clients use to reach the API (the CloudFront domain in AWS). */
  publicBaseUrl?: string;
  manifestCacheTtlMs?: number;
  /** Public Mapbox token for the /viewer page. */
  mapboxAccessToken?: string;
  defaultTileset?: string;
  logger?: FastifyServerOptions['logger'];
}

export function buildApp({
  tileStore,
  featureStore,
  publicBaseUrl,
  manifestCacheTtlMs = 30_000,
  mapboxAccessToken,
  defaultTileset = 'berlin-landmarks',
  logger = false,
}: AppOptions) {
  const app = Fastify({
    logger,
    // CloudFront's request id, so API logs can be matched with CloudFront logs.
    requestIdHeader: 'x-amz-cf-id',
  });
  const manifests = new TtlCache<TilesetManifest | null>(manifestCacheTtlMs);
  const getManifest = (tilesetId: string) => manifests.getOrLoad(tilesetId, () => tileStore.getManifest(tilesetId));

  app.addHook('onClose', async () => featureStore?.close());

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply
      .code(status)
      .header('cache-control', 'no-store')
      .send({ message: status >= 500 ? 'Internal Server Error' : err.message });
  });

  app.get('/health', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return { status: 'ok' };
  });

  app.get('/', async (_req, reply) => reply.redirect('/viewer'));

  app.get('/viewer', async (_req, reply) =>
    reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(viewerHtml({ accessToken: mapboxAccessToken, defaultTileset })),
  );

  app.get<{ Params: { tilesetId: string } }>(
    '/v1/tilesets/:tilesetId',
    {
      schema: {
        params: { type: 'object', properties: { tilesetId: tilesetIdSchema }, required: ['tilesetId'] },
      },
    },
    async (req, reply) => {
      const { tilesetId } = req.params;
      const manifest = await getManifest(tilesetId);
      if (!manifest) return reply.code(404).header('cache-control', 'no-store').send({ message: 'Tileset not found' });

      reply.header('cache-control', TILEJSON_CACHE);
      return toTileJson(manifest, publicBaseUrl ?? `${req.protocol}://${req.host}`);
    },
  );

  app.get<{ Params: { tilesetId: string }; Querystring: { bbox: string; limit: number } }>(
    '/v1/tilesets/:tilesetId/features',
    {
      schema: {
        params: { type: 'object', properties: { tilesetId: tilesetIdSchema }, required: ['tilesetId'] },
        querystring: {
          type: 'object',
          properties: {
            bbox: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_FEATURES, default: 100 },
          },
          required: ['bbox'],
        },
      },
    },
    async (req, reply) => {
      if (!featureStore) {
        return reply.code(503).header('cache-control', 'no-store').send({ message: 'Feature queries are not enabled' });
      }
      const bbox = parseBbox(req.query.bbox);
      if (!bbox) {
        return reply
          .code(400)
          .header('cache-control', 'no-store')
          .send({ message: 'bbox must be west,south,east,north in degrees' });
      }

      const { tilesetId } = req.params;
      const manifest = await getManifest(tilesetId);
      if (!manifest) return reply.code(404).header('cache-control', 'no-store').send({ message: 'Tileset not found' });

      // Query the version the manifest points to, so tiles and features always switch together.
      const features = await featureStore.query({ tilesetId, version: manifest.version, bbox, limit: req.query.limit });
      reply.header('cache-control', TILEJSON_CACHE).header('x-tileset-version', String(manifest.version));
      return { type: 'FeatureCollection', features };
    },
  );

  app.get<{ Params: { tilesetId: string; version: number; z: number; x: number; y: number } }>(
    '/v1/tiles/:tilesetId/:version/:z/:x/:y.mvt',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            tilesetId: tilesetIdSchema,
            version: { type: 'integer', minimum: 1 },
            z: { type: 'integer', minimum: 0, maximum: MAX_ZOOM },
            x: { type: 'integer', minimum: 0 },
            y: { type: 'integer', minimum: 0 },
          },
          required: ['tilesetId', 'version', 'z', 'x', 'y'],
        },
      },
    },
    async (req, reply) => {
      const { tilesetId, version, z, x, y } = req.params;
      const tilesPerSide = 2 ** z;
      if (x >= tilesPerSide || y >= tilesPerSide) {
        return reply.code(400).header('cache-control', 'no-store').send({ message: 'Tile out of range' });
      }

      const tile = await tileStore.getTile(tilesetId, version, z, x, y);
      if (!tile) return reply.code(204).header('cache-control', EMPTY_TILE_CACHE).send();

      reply.header('content-type', MVT_CONTENT_TYPE).header('cache-control', TILE_CACHE);
      if (tile.contentEncoding) reply.header('content-encoding', tile.contentEncoding);
      if (tile.etag) reply.header('etag', tile.etag);
      return reply.send(tile.body);
    },
  );

  return app;
}

export function toTileJson(manifest: TilesetManifest, baseUrl: string) {
  return {
    tilejson: '3.0.0',
    name: manifest.name,
    version: `${manifest.version}.0.0`,
    scheme: 'xyz',
    tiles: [`${baseUrl}/v1/tiles/${manifest.id}/${manifest.version}/{z}/{x}/{y}.mvt`],
    minzoom: manifest.minzoom,
    maxzoom: manifest.maxzoom,
    bounds: manifest.bounds,
    center: manifest.center,
    attribution: manifest.attribution,
    vector_layers: manifest.vector_layers,
  };
}
