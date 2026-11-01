import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { StoredTile, TileStore, TilesetManifest } from '../src/tiles/tile-store.js';

const manifest: TilesetManifest = {
  id: 'berlin',
  name: 'Berlin',
  version: 3,
  minzoom: 0,
  maxzoom: 14,
  bounds: [13.3, 52.4, 13.5, 52.6],
  vector_layers: [{ id: 'landmarks', fields: { name: 'String' } }],
};

function fakeStore(tiles: Record<string, StoredTile> = {}) {
  return {
    getManifest: vi.fn(async (id: string) => (id === manifest.id ? manifest : null)),
    getTile: vi.fn(async (id: string, v: number, z: number, x: number, y: number) => tiles[`${id}/${v}/${z}/${x}/${y}`] ?? null),
  } satisfies TileStore;
}

describe('GET /health', () => {
  it('reports ok', async () => {
    const res = await buildApp({ tileStore: fakeStore() }).inject('/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /v1/tilesets/:id', () => {
  it('returns TileJSON pointing at the current, versioned tile URL', async () => {
    const app = buildApp({ tileStore: fakeStore(), publicBaseUrl: 'https://cdn.example.com' });
    const res = await app.inject('/v1/tilesets/berlin');

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.json()).toMatchObject({
      tilejson: '3.0.0',
      tiles: ['https://cdn.example.com/v1/tiles/berlin/3/{z}/{x}/{y}.mvt'],
      vector_layers: manifest.vector_layers,
    });
  });

  it('falls back to the request host when no public URL is configured', async () => {
    const res = await buildApp({ tileStore: fakeStore() }).inject({ url: '/v1/tilesets/berlin', headers: { host: 'localhost:3000' } });
    expect(res.json().tiles[0]).toBe('http://localhost:3000/v1/tiles/berlin/3/{z}/{x}/{y}.mvt');
  });

  it('caches manifests in memory', async () => {
    const store = fakeStore();
    const app = buildApp({ tileStore: store });
    await app.inject('/v1/tilesets/berlin');
    await app.inject('/v1/tilesets/berlin');
    expect(store.getManifest).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for unknown tilesets', async () => {
    const res = await buildApp({ tileStore: fakeStore() }).inject('/v1/tilesets/nope');
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rejects invalid tileset ids', async () => {
    const res = await buildApp({ tileStore: fakeStore() }).inject('/v1/tilesets/Bad_Id');
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/tiles/:id/:version/:z/:x/:y.mvt', () => {
  const body = Buffer.from([0x1a, 0x02]);

  it('serves a tile with an immutable cache header', async () => {
    const app = buildApp({ tileStore: fakeStore({ 'berlin/3/12/2200/1343': { body, etag: '"abc"' } }) });
    const res = await app.inject('/v1/tiles/berlin/3/12/2200/1343.mvt');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.mapbox-vector-tile');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers.etag).toBe('"abc"');
    expect(res.rawPayload).toEqual(body);
  });

  it('passes through gzip encoding from storage', async () => {
    const gz = gzipSync(body);
    const app = buildApp({ tileStore: fakeStore({ 'berlin/3/0/0/0': { body: gz, contentEncoding: 'gzip' } }) });
    const res = await app.inject('/v1/tiles/berlin/3/0/0/0.mvt');
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('answers 204 with a short cache for empty tiles', async () => {
    const res = await buildApp({ tileStore: fakeStore() }).inject('/v1/tiles/berlin/3/5/1/1.mvt');
    expect(res.statusCode).toBe(204);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  it.each([
    ['x outside the zoom level', '/v1/tiles/berlin/3/1/2/0.mvt'],
    ['zoom above the maximum', '/v1/tiles/berlin/3/23/0/0.mvt'],
    ['non-numeric coordinate', '/v1/tiles/berlin/3/1/a/0.mvt'],
    ['version zero', '/v1/tiles/berlin/0/1/0/0.mvt'],
  ])('rejects %s', async (_case, url) => {
    const store = fakeStore();
    const res = await buildApp({ tileStore: store }).inject(url);
    expect(res.statusCode).toBe(400);
    expect(store.getTile).not.toHaveBeenCalled();
  });

  it('hides storage errors behind a 500 that is not cached', async () => {
    const store = fakeStore();
    store.getTile.mockRejectedValueOnce(new Error('S3 is down'));
    const res = await buildApp({ tileStore: store }).inject('/v1/tiles/berlin/3/0/0/0.mvt');
    expect(res.statusCode).toBe(500);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ message: 'Internal Server Error' });
  });
});
