# 0005: Tile pipeline on Step Functions, Lambda and ECS

**Status:** accepted

## Context
Uploaded GeoJSON has to become versioned vector tiles (see 0002) without anyone running scripts by hand. Builds can take from seconds to many minutes depending on the data. Failures must be visible, and a broken build must never replace a working tileset.

## Decision
```
S3 raw: uploads/{tileset}.geojson
  -> EventBridge (Object Created, uploads/*.geojson)
  -> Step Functions (Standard)
       Validate    Lambda (Python)      reject bad input early, pick version = upload time (YYYYMMDDHHMMSS)
       BuildTiles  ECS Fargate (.sync)  tippecanoe -> tilesets/{id}/v{n}/..., metadata.json last
       Choice      exit code == 0?
       Publish     Lambda (Python)      write manifest.json (the "current version" pointer)
  any error -> SNS alert -> Fail
CloudWatch alarm on ExecutionsFailed -> same SNS topic
```

## Why these pieces
- **Step Functions** gives retries, timeouts, error routing and a visual history of each run, without code that manages workflows. Standard workflows are free for the first 4,000 state transitions a month, and one run uses about 6.
- **Lambda** handles the short steps (validate, publish). It starts fast, costs nothing while idle, and boto3 comes with the runtime, so there is no packaging step.
- **ECS Fargate** runs tippecanoe. Lambda has a 15-minute limit, limited disk, and can't run arbitrary binaries easily. Fargate gives 20 GB of disk and no time limit, and is billed per second.
- **EventBridge** rather than S3 notifications calling Lambda directly: filtering (prefix and suffix) happens in configuration, and the state machine starts directly with no glue code.

## Correctness
- **Version = upload time.** It is unique per upload, increases over time, and does not change when Step Functions retries a step, so retries are idempotent. Two uploads to the same tileset within the same second would collide. That is acceptable here; production would add the S3 version ID.
- **Tiles before pointer.** Tiles are written first, then `metadata.json`, then `manifest.json` in the publish step. Clients never see a version that is only partly uploaded.
- **No rollback by a slow run.** Publish skips its write if the current manifest is already newer. It uses an S3 conditional write (`If-Match` on the ETag, or `If-None-Match: *` when no manifest exists yet), so two runs can't overwrite each other. On a conflict it raises `ConcurrentPublishError`, which Step Functions retries.
- **Exit code check.** The Choice state checks the container's exit code explicitly instead of trusting that the task stopped cleanly.
- **Invalid input is not retried.** `InvalidInputError` goes straight to the alert. Lambda service errors and ECS capacity errors are retried with backoff.

## Consequences
- The tile builder runs on x86. tippecanoe compiles natively on CI runners and Intel laptops, and a build that takes about a minute gains little from ARM pricing.
- Validation reads the whole file in Lambda, so it is limited to 50 MB. Larger inputs would be validated inside the ECS task, or with streaming.
- Old versions stay in S3 until a cleanup job or lifecycle rule removes them. That is a follow-up.
