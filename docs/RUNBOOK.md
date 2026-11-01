# Runbook

What to do when an alert fires. Every alarm description links here.

## Tile pipeline failed (`FailedExecutionsAlarm` or "Mini Maps pipeline failed" email)

**Impact:** a new tileset version was not published. **Clients are not affected.** The API keeps serving the previous version, because the manifest is only written after a successful build.

1. Open the failed execution. The alert email contains its ID, or run:
   ```bash
   aws stepfunctions list-executions --state-machine-arn <StateMachineArn> --status-filter FAILED --max-items 5
   ```
2. In the console graph, find the red step and read `$.error` (`Error` and `Cause`).
3. Use the step and error to decide what to do:

| Step / error | Likely cause | Action |
|---|---|---|
| Validate / `InvalidInputError` | Bad upload (wrong key, invalid GeoJSON, coordinates out of range, over 50 MB) | Fix the file and upload it again. Nothing to clean up. |
| Validate / `Lambda.*` after retries | Lambda throttling or an outage | Check the Lambda metrics, then re-run (see below). |
| BuildTiles / `ECS.AmazonECSException` | No Fargate capacity, or a bad subnet or security group | Check the ECS service events and re-run. |
| `Build succeeded?` → NotifyFailure | tippecanoe exited with a non-zero code | Read the `/tile-builder` log stream in CloudWatch Logs. Usually bad geometry or running out of memory; raise the task memory if needed. |
| Publish / `MissingTilesError` | The build "succeeded" but uploaded no `metadata.json` | Read the tile builder logs and check its IAM permissions on `tilesets/*`. |
| Publish / `ConcurrentPublishError` after 3 retries | Several runs publishing the same tileset at once | Re-run. Whichever version is newest wins. |
| `States.Timeout` | Build ran for more than an hour | Split the input, or give the task more CPU or memory. |

**Re-run** with the same input. It is idempotent: same version number, same keys.
```bash
aws stepfunctions start-execution --state-machine-arn <StateMachineArn> \
  --input '{"bucket":"<RawBucketName>","key":"uploads/<id>.geojson","time":"<original time>"}'
```

## API alarms (`MiniMaps-Api` dashboard in CloudWatch)

Start on the **MiniMaps-Api** dashboard. It shows CloudFront, the ALB, per-route API metrics and ECS side by side, so you can see quickly which layer is affected.

### `NoHealthyTasks`: no healthy API task behind the load balancer
**Impact:** requests that miss the CloudFront cache fail with 502/503. Cached tiles keep working for up to a year, and TileJSON for up to 60 s.
1. ECS console → `MiniMaps-Api` service → **Events**. Look for failing health checks, image pull errors or `CannotPullContainerError`.
2. Check the `/api` log stream for crashes at start-up (for example a missing environment variable, or a database that can't be reached).
3. If a deploy caused it, the deployment circuit breaker rolls back automatically. Otherwise, redeploy the last good commit.

### `HighErrorRate`: 5xx above 1%
1. On the dashboard, find which **route** has the errors (`API: requests by route`) and whether they come from the ALB (no healthy task) or from the targets (app errors).
2. Search the logs: `fields @timestamp, msg, err.message | filter level >= 50 | sort @timestamp desc` (CloudWatch Logs Insights, `/api` log group).
3. Common causes: S3 permissions (403 from S3 becomes 500), the database is unreachable or timing out (`/features` only), or a bad deploy.

### `HighLatency`: p99 above 500 ms
1. Is it every route or one? `features` hits PostGIS (2 s statement timeout); `tiles` and `tilejson` hit S3.
2. ECS CPU above 80%? Autoscaling adds tasks up to 3. If it is already at 3, raise `maxCapacity`.
3. A cold manifest cache causes a short spike after a deploy. Ignore it if latency recovers within a few minutes.

## Roll back a tileset
Every old version is still in S3. Point the manifest back at the previous version:
```bash
aws s3 cp s3://<TilesBucket>/tilesets/<id>/manifest.json manifest.json
# edit "version" to the previous value; check that tilesets/<id>/v<old>/ exists
aws s3 cp manifest.json s3://<TilesBucket>/tilesets/<id>/manifest.json --content-type application/json
```
Clients pick up the change within about 90 seconds: 60 s TileJSON cache plus 30 s API in-memory cache.
