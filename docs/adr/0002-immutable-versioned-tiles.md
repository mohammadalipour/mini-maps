# 0002: Immutable, versioned tile URLs

**Status:** accepted

## Context
Tiles are the hottest read path. Most requests should be served by CloudFront without reaching the origin, and publishing new data must never show clients a mix of old and new tiles.

## Decision
- Tiles are stored and served under a version: `tilesets/{id}/v{n}/{z}/{x}/{y}.mvt`. A version is never modified after it is written.
- `tilesets/{id}/manifest.json` points at the current version. Publishing writes all tiles first, then the manifest, in one PUT.
- The TileJSON endpoint (`/v1/tilesets/{id}`) returns tile URLs that include the version, and is cached for 60 s.
- Tile responses use `Cache-Control: public, max-age=31536000, immutable`.
- Empty tiles return `204` with a 5-minute cache, so a request for a version that is not published yet does not leave an empty tile cached for a year.

## Why
- No CloudFront invalidations are needed. A new version simply has new URLs.
- The cache hit ratio stays high, because tile URLs never change.
- Rollback means rewriting the manifest to the previous version, which takes seconds.
- Serving a tile never needs a database lookup. The URL maps straight to an S3 key.

## Consequences
- Old versions use storage until a lifecycle rule or cleanup job removes them.
- Clients that keep a TileJSON for longer than 60 s keep using the old version, which is still valid.
