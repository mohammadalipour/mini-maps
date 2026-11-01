export interface StoredTile {
  body: Buffer;
  contentEncoding?: string;
  etag?: string;
}

export interface VectorLayer {
  id: string;
  fields: Record<string, string>;
  minzoom?: number;
  maxzoom?: number;
}

/** Written last by the publish step; pointing at a new version is a single atomic PUT. */
export interface TilesetManifest {
  id: string;
  name: string;
  version: number;
  minzoom: number;
  maxzoom: number;
  bounds: [number, number, number, number];
  center?: [number, number, number];
  attribution?: string;
  vector_layers: VectorLayer[];
}

export interface TileStore {
  getTile(tilesetId: string, version: number, z: number, x: number, y: number): Promise<StoredTile | null>;
  getManifest(tilesetId: string): Promise<TilesetManifest | null>;
}

export const tileKey = (tilesetId: string, version: number, z: number, x: number, y: number) =>
  `tilesets/${tilesetId}/v${version}/${z}/${x}/${y}.mvt`;

export const manifestKey = (tilesetId: string) => `tilesets/${tilesetId}/manifest.json`;

export function parseManifest(raw: Buffer): TilesetManifest {
  const value: unknown = JSON.parse(raw.toString('utf8'));
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as TilesetManifest).id !== 'string' ||
    !Number.isInteger((value as TilesetManifest).version) ||
    !Array.isArray((value as TilesetManifest).vector_layers)
  ) {
    throw new Error('Invalid tileset manifest');
  }
  return value as TilesetManifest;
}

const GZIP_MAGIC = [0x1f, 0x8b];

export const isGzipped = (body: Buffer) => body[0] === GZIP_MAGIC[0] && body[1] === GZIP_MAGIC[1];
