import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { isGzipped, manifestKey, parseManifest, tileKey, type StoredTile, type TileStore } from './tile-store.js';

/** Local development store: same key layout as S3, rooted in a directory. */
export class FsTileStore implements TileStore {
  constructor(private readonly root: string) {}

  getTile(tilesetId: string, version: number, z: number, x: number, y: number) {
    return this.read(tileKey(tilesetId, version, z, x, y));
  }

  async getManifest(tilesetId: string) {
    const object = await this.read(manifestKey(tilesetId));
    return object ? parseManifest(object.body) : null;
  }

  private async read(key: string): Promise<StoredTile | null> {
    try {
      const body = await readFile(path.join(this.root, key));
      return { body, contentEncoding: isGzipped(body) ? 'gzip' : undefined };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}
