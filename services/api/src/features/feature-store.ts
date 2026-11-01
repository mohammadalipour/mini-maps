import pg from 'pg';
import type { Feature, Geometry } from 'geojson';

export type Bbox = [west: number, south: number, east: number, north: number];

export interface FeatureQuery {
  tilesetId: string;
  version: number;
  bbox: Bbox;
  limit: number;
}

export interface FeatureStore {
  query(q: FeatureQuery): Promise<Feature[]>;
  close(): Promise<void>;
}

// Table layout: pipeline/tile_builder/schema.sql. ST_Intersects uses the GiST index on geom.
const QUERY = `
  SELECT feature_index, properties, ST_AsGeoJSON(geom, 6)::json AS geometry
  FROM features
  WHERE tileset_id = $1 AND version = $2
    AND ST_Intersects(geom, ST_MakeEnvelope($3, $4, $5, $6, 4326))
  ORDER BY feature_index
  LIMIT $7`;

interface Row {
  feature_index: number;
  properties: Record<string, unknown>;
  geometry: Geometry;
}

export class PostgresFeatureStore implements FeatureStore {
  constructor(private readonly pool: pg.Pool) {}

  async query({ tilesetId, version, bbox, limit }: FeatureQuery): Promise<Feature[]> {
    const { rows } = await this.pool.query<Row>(QUERY, [tilesetId, version, ...bbox, limit]);
    return rows.map((row) => ({
      type: 'Feature',
      id: row.feature_index,
      properties: row.properties,
      geometry: row.geometry,
    }));
  }

  close() {
    return this.pool.end();
  }
}

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** PEM CA bundle; when set, the server certificate is verified (RDS). */
  ca?: string;
}

export function createPool(config: DatabaseConfig): pg.Pool {
  return new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ca ? { ca: config.ca, rejectUnauthorized: true } : false,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
    // A slow query must not hold a connection and stall the read path.
    statement_timeout: 2_000,
  });
}

/** "west,south,east,north" in degrees, or null if invalid. */
export function parseBbox(value: string): Bbox | null {
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts as Bbox;
  const inRange = [west, east].every((lon) => lon >= -180 && lon <= 180) && [south, north].every((lat) => lat >= -90 && lat <= 90);
  return inRange && west <= east && south <= north ? [west, south, east, north] : null;
}
