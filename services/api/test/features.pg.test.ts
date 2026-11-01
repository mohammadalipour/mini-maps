/**
 * Integration test against a real PostGIS. Run `docker compose up -d postgis` and set
 * TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/minimaps (CI does this).
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresFeatureStore } from '../src/features/feature-store.js';

const url = process.env.TEST_DATABASE_URL;
// Same schema the tile builder applies.
const schema = readFileSync(new URL('../../../pipeline/tile_builder/schema.sql', import.meta.url), 'utf8');

describe.skipIf(!url)('PostgresFeatureStore', () => {
  let pool: pg.Pool;
  let store: PostgresFeatureStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await pool.query(schema);
    await pool.query(`DELETE FROM tileset_versions WHERE tileset_id = 'api-test'`);
    await pool.query(`INSERT INTO tileset_versions VALUES ('api-test', 1, 2), ('api-test', 2, 1)`);
    await pool.query(`
      INSERT INTO features (tileset_id, version, feature_index, properties, geom) VALUES
        ('api-test', 1, 0, '{"name":"Brandenburger Tor"}', ST_SetSRID(ST_MakePoint(13.3777, 52.5163), 4326)),
        ('api-test', 1, 1, '{"name":"Fernsehturm"}',       ST_SetSRID(ST_MakePoint(13.4094, 52.5208), 4326)),
        ('api-test', 2, 0, '{"name":"New version"}',       ST_SetSRID(ST_MakePoint(13.4094, 52.5208), 4326))`);
    store = new PostgresFeatureStore(pool);
  });

  afterAll(async () => {
    await pool?.query(`DELETE FROM tileset_versions WHERE tileset_id = 'api-test'`);
    await store?.close();
  });

  it('returns only features inside the bbox, as GeoJSON', async () => {
    const features = await store.query({ tilesetId: 'api-test', version: 1, bbox: [13.4, 52.515, 13.42, 52.53], limit: 10 });
    expect(features).toEqual([
      { type: 'Feature', id: 1, properties: { name: 'Fernsehturm' }, geometry: { type: 'Point', coordinates: [13.4094, 52.5208] } },
    ]);
  });

  it('only reads the requested version', async () => {
    const features = await store.query({ tilesetId: 'api-test', version: 2, bbox: [13, 52, 14, 53], limit: 10 });
    expect(features.map((f) => f.properties?.name)).toEqual(['New version']);
  });

  it('respects the limit', async () => {
    const features = await store.query({ tilesetId: 'api-test', version: 1, bbox: [13, 52, 14, 53], limit: 1 });
    expect(features).toHaveLength(1);
  });
});
