import { GetObjectCommand, NoSuchKey, type S3Client } from '@aws-sdk/client-s3';
import { manifestKey, parseManifest, tileKey, type StoredTile, type TileStore } from './tile-store.js';

export class S3TileStore implements TileStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  getTile(tilesetId: string, version: number, z: number, x: number, y: number) {
    return this.get(tileKey(tilesetId, version, z, x, y));
  }

  async getManifest(tilesetId: string) {
    const object = await this.get(manifestKey(tilesetId));
    return object ? parseManifest(object.body) : null;
  }

  private async get(key: string): Promise<StoredTile | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return null;
      return {
        body: Buffer.from(await res.Body.transformToByteArray()),
        contentEncoding: res.ContentEncoding,
        etag: res.ETag,
      };
    } catch (err) {
      // Needs s3:ListBucket, otherwise S3 answers 403 instead of NoSuchKey for missing keys.
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
  }
}
