/**
 * Dev tool: cut a GeoJSON file into vector tiles and publish them, to a local
 * directory (--out) or an S3 bucket (--bucket). Stands in for the Step Functions
 * pipeline until that exists, and uses the same key layout and publish order:
 * tiles first, manifest last.
 *
 *   tsx scripts/seed-tiles.ts --input data.geojson --tileset my-set --out ../../.local-tiles
 *   tsx scripts/seed-tiles.ts --input data.geojson --tileset my-set --bucket <TilesBucketName>
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { FeatureCollection, Position } from 'geojson';
import GeoJSONVT from 'geojson-vt';
import vtpbf from 'vt-pbf';
import { manifestKey, tileKey, type TilesetManifest } from '../src/tiles/tile-store.js';

const { values: args } = parseArgs({
  options: {
    input: { type: 'string' },
    tileset: { type: 'string' },
    layer: { type: 'string', default: 'features' },
    version: { type: 'string', default: '1' },
    minzoom: { type: 'string', default: '0' },
    maxzoom: { type: 'string', default: '14' },
    out: { type: 'string' },
    bucket: { type: 'string' },
  },
});

if (!args.input || !args.tileset || (!args.out && !args.bucket)) {
  console.error('Usage: seed-tiles --input <file.geojson> --tileset <id> (--out <dir> | --bucket <name>)');
  process.exit(1);
}

const tilesetId = args.tileset;
const layer = args.layer;
const version = Number(args.version);
const minzoom = Number(args.minzoom);
const maxzoom = Number(args.maxzoom);

const geojson = JSON.parse(await readFile(args.input, 'utf8')) as FeatureCollection;
const bounds = boundsOf(geojson);
const index = new GeoJSONVT(geojson, { maxZoom: maxzoom, indexMaxZoom: maxzoom, indexMaxPoints: 0 });

const write = args.bucket ? s3Writer(args.bucket) : fsWriter(args.out!);

let count = 0;
for (let z = minzoom; z <= maxzoom; z++) {
  const [minX, maxY] = lonLatToTile(bounds[0], bounds[1], z);
  const [maxX, minY] = lonLatToTile(bounds[2], bounds[3], z);
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const tile = index.getTile(z, x, y);
      if (!tile || tile.features.length === 0) continue;
      const body = vtpbf.fromGeojsonVt({ [layer]: tile }, { version: 2 });
      await write(tileKey(tilesetId, version, z, x, y), body, 'application/vnd.mapbox-vector-tile');
      count++;
    }
  }
}

const manifest: TilesetManifest = {
  id: tilesetId,
  name: tilesetId,
  version,
  minzoom,
  maxzoom,
  bounds,
  center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, Math.min(12, maxzoom)],
  attribution: 'Sample data',
  vector_layers: [{ id: layer, fields: fieldsOf(geojson), minzoom, maxzoom }],
};
// Manifest last: clients only see the new version once all its tiles exist.
await write(manifestKey(tilesetId), Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json');

console.log(`Published ${count} tiles for ${tilesetId} v${version} to ${args.bucket ? `s3://${args.bucket}` : args.out}`);

type Writer = (key: string, body: Uint8Array, contentType: string) => Promise<void>;

function fsWriter(root: string): Writer {
  return async (key, body) => {
    const file = path.join(root, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  };
}

function s3Writer(bucket: string): Writer {
  const s3 = new S3Client({});
  return async (key, body, contentType) => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  };
}

function lonLatToTile(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  const clamp = (v: number) => Math.min(n - 1, Math.max(0, v));
  return [clamp(x), clamp(y)];
}

function boundsOf(fc: FeatureCollection): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (coords: unknown): void => {
    if (typeof (coords as Position)[0] === 'number') {
      const [lon, lat] = coords as Position;
      b[0] = Math.min(b[0], lon!);
      b[1] = Math.min(b[1], lat!);
      b[2] = Math.max(b[2], lon!);
      b[3] = Math.max(b[3], lat!);
    } else {
      (coords as unknown[]).forEach(visit);
    }
  };
  for (const feature of fc.features) {
    if (feature.geometry.type !== 'GeometryCollection') visit(feature.geometry.coordinates);
  }
  return b;
}

function fieldsOf(fc: FeatureCollection): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const feature of fc.features) {
    for (const [key, value] of Object.entries(feature.properties ?? {})) {
      fields[key] = typeof value === 'number' ? 'Number' : typeof value === 'boolean' ? 'Boolean' : 'String';
    }
  }
  return fields;
}
