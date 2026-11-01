# 0006: PostGIS on RDS for bbox feature queries

**Status:** accepted

## Context
Tiles are good for drawing a map, but clients also ask questions about the data, such as "which features are in this area?". That needs a spatial index over the original geometries, not the simplified, clipped shapes inside tiles.

## Decision
- **RDS Postgres 17 + PostGIS** (`db.t4g.micro`, 20 GB gp3, single-AZ, encrypted) in the isolated subnets, with no public access.
- The **tile builder** (ECS) loads the GeoJSON features into `features` for every build, keyed by `(tileset_id, version)`, with a GiST index on `geom`. Loading runs in one transaction that first deletes the same version, so retries are idempotent. Concurrent builds apply the schema under an advisory lock.
- **`GET /v1/tilesets/{id}/features?bbox=w,s,e,n&limit=n`** returns GeoJSON for **the version that `manifest.json` points to** (`ST_Intersects` with `ST_MakeEnvelope`). It is cached for 60 s, like TileJSON.
- Credentials come from **Secrets Manager**, injected by ECS into the containers. Connections use TLS and verify the server certificate against the RDS CA bundle (`sslmode=verify-full`).

## Why
- **One source of truth for "current".** The manifest already decides which version is live. Querying by that version means tiles and features switch together on publish, and there is no second pointer in the database that could drift.
- **No NAT gateway and no VPC interface endpoints.** Only the ECS tasks talk to the database: the tile builder writes, and the API reads. They already reach Secrets Manager through their public IP. The Lambdas never need database access, so they stay outside the VPC.
- **The firewall rules live in the client stacks** (`DatabaseStack.allowConnectionsFrom`). Clients depend on the database for its endpoint, so putting the rules in the database stack would create a cross-stack dependency cycle.
- **Optional (`-c database=true`).** The database costs about $15 a month while it exists. Without it, the pipeline skips loading and the endpoint answers `503`.

## Consequences / follow-ups
- The API uses the admin user. Production would use a read-only role for the API and a writer role for the tile builder.
- Old versions stay in the table until a cleanup job deletes versions older than the current one, together with the S3 cleanup.
- The GiST index is on `geom` alone. With many large tilesets, partitioning by `tileset_id` (or a composite index with `btree_gist`) keeps queries fast.
- To remove the database: deploy Pipeline and Api **without** the flag first (this drops their references), then destroy `MiniMaps-Database`.
