import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { type FeatureStore, parseBbox } from '../src/features/feature-store.js';
import type { TileStore, TilesetManifest } from '../src/tiles/tile-store.js';

const manifest: TilesetManifest = {
  id: 'berlin',
  name: 'Berlin',
  version: 7,
  minzoom: 0,
  maxzoom: 12,
  bounds: [13.3, 52.4, 13.5, 52.6],
  vector_layers: [],
};

const tileStore: TileStore = {
  getTile: async () => null,
  getManifest: async (id) => (id === 'berlin' ? manifest : null),
};

function fakeFeatureStore() {
  return {
    query: vi.fn(async () => [
      { type: 'Feature' as const, id: 0, properties: { name: 'Fernsehturm' }, geometry: { type: 'Point' as const, coordinates: [13.4094, 52.5208] } },
    ]),
    close: vi.fn(async () => {}),
  } satisfies FeatureStore;
}

describe('GET /v1/tilesets/:id/features', () => {
  it('queries the current manifest version and returns GeoJSON', async () => {
    const featureStore = fakeFeatureStore();
    const res = await buildApp({ tileStore, featureStore }).inject('/v1/tilesets/berlin/features?bbox=13.4,52.5,13.42,52.53&limit=10');

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-tileset-version']).toBe('7');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.json()).toMatchObject({ type: 'FeatureCollection', features: [{ properties: { name: 'Fernsehturm' } }] });
    expect(featureStore.query).toHaveBeenCalledWith({ tilesetId: 'berlin', version: 7, bbox: [13.4, 52.5, 13.42, 52.53], limit: 10 });
  });

  it('defaults the limit to 100', async () => {
    const featureStore = fakeFeatureStore();
    await buildApp({ tileStore, featureStore }).inject('/v1/tilesets/berlin/features?bbox=13,52,14,53');
    expect(featureStore.query).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
  });

  it.each([
    ['missing bbox', '/v1/tilesets/berlin/features'],
    ['bad bbox', '/v1/tilesets/berlin/features?bbox=1,2,3'],
    ['limit too high', '/v1/tilesets/berlin/features?bbox=13,52,14,53&limit=5000'],
  ])('rejects %s', async (_case, url) => {
    const featureStore = fakeFeatureStore();
    const res = await buildApp({ tileStore, featureStore }).inject(url);
    expect(res.statusCode).toBe(400);
    expect(featureStore.query).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown tilesets', async () => {
    const res = await buildApp({ tileStore, featureStore: fakeFeatureStore() }).inject('/v1/tilesets/nope/features?bbox=13,52,14,53');
    expect(res.statusCode).toBe(404);
  });

  it('answers 503 when no database is configured', async () => {
    const res = await buildApp({ tileStore }).inject('/v1/tilesets/berlin/features?bbox=13,52,14,53');
    expect(res.statusCode).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('closes the database pool on shutdown', async () => {
    const featureStore = fakeFeatureStore();
    const app = buildApp({ tileStore, featureStore });
    await app.ready();
    await app.close();
    expect(featureStore.close).toHaveBeenCalled();
  });
});

describe('parseBbox', () => {
  it.each([
    ['13.4,52.5,13.42,52.53', [13.4, 52.5, 13.42, 52.53]],
    [' -180 , -90 , 180 , 90 ', [-180, -90, 180, 90]],
  ])('accepts %s', (input, expected) => {
    expect(parseBbox(input)).toEqual(expected);
  });

  it.each(['', '1,2,3', 'a,b,c,d', '13,52,12,53', '13,53,14,52', '-181,0,0,1', '0,-91,1,0', '1,2,3,4,5'])('rejects "%s"', (input) => {
    expect(parseBbox(input)).toBeNull();
  });
});
