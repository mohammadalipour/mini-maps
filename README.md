# Mini Maps API

A small but complete version of a map tile platform: an ETL pipeline that turns GeoJSON into vector tiles, and a low-latency read API that serves them through CloudFront. Built with Node.js, Python and native AWS (CDK, ECS, Step Functions, Lambda, S3, RDS, CloudWatch, CloudFront).

## Architecture

```
                 ┌──────────────── read path (built) ────────────────┐
 Client ──► CloudFront ──(VPC origin)──► internal ALB ──► ECS Fargate (Node.js) ──► S3 tiles
             edge cache                                       │
                                                              └── manifest cache (in memory)

                 ┌──────────────── write path (built) ───────────────┐
 uploads/{id}.geojson ──► S3 raw ──► EventBridge ──► Step Functions
     1. Validate    Lambda (Python)         reject bad input, version = upload time
     2. BuildTiles  ECS Fargate (tippecanoe) tiles to tilesets/{id}/v{n}/..., metadata.json last
     3. exit code == 0 ?
     4. Publish     Lambda (Python)         manifest.json via S3 conditional write
     any failure ──► SNS alert ──► Fail        CloudWatch alarm on failed executions ──► SNS

                 ┌──────────────── spatial queries (optional) ───────┐
 BuildTiles also loads features ──► RDS Postgres + PostGIS (per tileset + version)
 GET /v1/tilesets/{id}/features?bbox=… ──► version from manifest ──► ST_Intersects ──► GeoJSON
```

Design decisions are recorded in [docs/adr](docs/adr):
- [0001](docs/adr/0001-cdk-typescript.md) CDK in TypeScript
- [0002](docs/adr/0002-immutable-versioned-tiles.md) Immutable, versioned tile URLs, so no cache invalidations are needed
- [0003](docs/adr/0003-cloudfront-vpc-origin.md) CloudFront VPC origin to an internal ALB, with no NAT gateway
- [0004](docs/adr/0004-stacks-split-by-cost.md) Stacks split by cost profile
- [0005](docs/adr/0005-tile-pipeline.md) Tile pipeline on Step Functions, Lambda and ECS
- [0006](docs/adr/0006-postgis-feature-queries.md) PostGIS on RDS for bbox feature queries
- [0007](docs/adr/0007-api-observability.md) API observability: ALB alarms, per-route metrics, dashboard

When an alert fires, see [docs/RUNBOOK.md](docs/RUNBOOK.md).

## API

| Endpoint | Cache | Notes |
|---|---|---|
| `GET /v1/tilesets/{id}` | 60 s | TileJSON 3.0; tile URLs include the current version |
| `GET /v1/tiles/{id}/{version}/{z}/{x}/{y}.mvt` | 1 year, immutable | `204` for empty tiles (5 min cache) |
| `GET /v1/tilesets/{id}/features?bbox=w,s,e,n&limit=n` | 60 s | GeoJSON from PostGIS for the current version; `503` without a database |
| `GET /health` | none | ALB health check |
| `GET /viewer?tileset={id}` | none | Map page (Mapbox GL JS v3) for any tileset; `/` redirects here |

## Repository layout

```
infra/                 CDK app (Network, Storage, Database, Pipeline, Api stacks) + assertion tests
services/api/          Node.js (Fastify) tile API, Dockerfile, tests, seed script
pipeline/lambdas/      Python Lambdas: validate, publish
pipeline/tile_builder/ Python + tippecanoe ECS task, PostGIS loader + schema, Dockerfile
pipeline/tests/        pytest suite
data/sample/           Small Berlin GeoJSON for local runs
docs/                  ADRs and runbook
```

## Run locally (no AWS needed)

```bash
cd services/api
npm ci
npm run seed:local   # cut data/sample/berlin-landmarks.geojson into tiles under .local-tiles/
npm run dev          # http://localhost:3000
curl localhost:3000/v1/tilesets/berlin-landmarks
curl -o tile.mvt localhost:3000/v1/tiles/berlin-landmarks/1/12/2200/1343.mvt
open http://localhost:3000/viewer   # paste a public Mapbox token (pk.…), or set MAPBOX_ACCESS_TOKEN
```

With PostGIS (for `/features` and the integration tests):

```bash
docker compose up -d --wait postgis      # host port 55432
# add to services/api/.env: DB_HOST=localhost DB_PORT=55432 DB_NAME=minimaps DB_USER=postgres DB_PASSWORD=postgres DB_SSLMODE=disable
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/minimaps
```

Tests (database tests are skipped without `TEST_DATABASE_URL`):

```bash
(cd services/api && npm test)
(cd pipeline && python3 -m venv .venv && .venv/bin/pip install boto3 pytest "psycopg[binary]" && .venv/bin/python -m pytest)
(cd infra && npm ci && npm test && npm run synth)
```

## Deploy to AWS

Prerequisites: AWS CLI v2 with credentials (`aws configure` or `aws sso login`), Docker running, and **an AWS Budget alert set up first**.

```bash
cd infra
npx cdk bootstrap                         # once per account/region (eu-central-1 by default)
npx cdk deploy MiniMaps-Network MiniMaps-Storage
npx cdk deploy MiniMaps-Pipeline -c alertEmail=you@example.com   # builds the tippecanoe image
# optional: add PostGIS (~$15/month) by passing -c database=true to every deploy
npx cdk deploy MiniMaps-Api               # builds the ARM64 image; CloudFront takes ~5-10 min

# Run the pipeline: upload GeoJSON (bucket names are in the Storage stack outputs)
aws s3 cp ../data/sample/berlin-landmarks.geojson s3://<RawBucketName>/uploads/berlin-landmarks.geojson

# Or skip the pipeline and publish tiles directly with the seed script
cd ../services/api
npx tsx scripts/seed-tiles.ts --input ../../data/sample/berlin-landmarks.geojson \
  --tileset berlin-landmarks --layer landmarks --bucket <TilesBucketName>

curl https://<ApiUrl>/v1/tilesets/berlin-landmarks
```

When you are done:

```bash
cd infra && npx cdk destroy MiniMaps-Api
```

## Cost

| Stack | Approx. monthly cost if left running |
|---|---|
| Network (VPC, S3 gateway endpoint) | $0 |
| Storage (S3, small data) | cents |
| Pipeline (Step Functions, Lambda, SNS, 1 alarm; Fargate per run) | ~$0 idle, < $0.01 per run |
| Database (RDS t4g.micro, 20 GB, secret), optional | ~$15 |
| Api (ALB + 1 Fargate ARM task 0.25 vCPU + 1 public IP; 3 alarms, dashboard, ~12 custom metrics) | ~$30 |

There is no NAT gateway. Destroying `MiniMaps-Api` when it is not in use keeps the total to a few dollars.

## Roadmap

- [x] CDK skeleton, network, storage, CloudFront + ALB + Fargate API
- [x] Tile API with versioned, immutable URLs; unit and infrastructure tests; CI
- [x] Step Functions ETL: Python Lambdas + tippecanoe ECS task, SNS alerts, alarm, runbook
- [x] RDS Postgres/PostGIS: features per version + `GET /v1/tilesets/{id}/features?bbox=`
- [x] CloudWatch: per-route API metrics, `MiniMaps-Api` dashboard, latency / 5xx / health alarms → SNS
- [ ] GitHub Actions deploy with OIDC (no long-lived AWS keys)
- [ ] k6 load test and results
- [x] Map viewer page (Mapbox GL JS v3, Standard style, tile boundaries toggle)
