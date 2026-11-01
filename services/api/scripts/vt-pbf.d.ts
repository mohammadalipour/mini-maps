declare module 'vt-pbf' {
  import type { LegacyTile } from 'geojson-vt';

  export function fromGeojsonVt(
    layers: Record<string, LegacyTile>,
    options?: { version?: number; extent?: number },
  ): Uint8Array;
}
