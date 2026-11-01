# 0007: API observability: ALB metrics for alarms, aggregated app metrics for routes

**Status:** accepted

## Context
The read path must tell us quickly when users are affected, and which part is at fault: CloudFront, load balancer, app or storage. We are on-call for it. Observability cost has to stay flat as traffic grows.

## Decision
**Alarms use the ALB's built-in metrics** (free, one-minute resolution), notify SNS on alarm and on recovery, and link to the runbook:
| Alarm | Condition |
|---|---|
| `HighLatency` | target response time p99 > 500 ms in 3 of 5 minutes |
| `HighErrorRate` | (target 5xx + ALB 5xx) / requests > 1% in 3 of 5 minutes |
| `NoHealthyTasks` | healthy targets < 1 for 2 minutes; missing data counts as breaching |

**Per-route app metrics** (`MiniMaps/Api`, dimension `Route` = tiles | tilejson | features | viewer | other):
`Latency` (histogram), `Requests`, `Errors5xx`. The API aggregates them in memory and calls `PutMetricData` **once a minute per task**. Latency is sent as `Values` + `Counts` in buckets about 20% wide, so CloudWatch can still compute p50 and p99.

**A dashboard** (`MiniMaps-Api`) shows CloudFront requests and 5xx rate, ALB latency and errors, per-route p99 and traffic, and ECS CPU, memory and healthy tasks.

## Why
- **ALB metrics for alarms:** they exist even when the app is crashing or not publishing, and they cost nothing.
- **Aggregated, not per-request:** a log line per request (EMF) costs money in proportion to traffic. At billions of requests that is a real bill. One `PutMetricData` call per minute per task costs the same whatever the traffic. The trade-off is 1-minute granularity and about 10% bucket error on latency, which is fine for alarms and trends.
- **Low-cardinality dimensions:** route *patterns* mapped to a fixed set of names, never raw URLs or tileset IDs. Every distinct dimension value is a billed custom metric.
- **CloudFront only on the dashboard:** its metrics live in us-east-1, and alarms must be in the same region as their metric. A us-east-1 alarm stack would be the next step.

## Consequences
- About 12 custom metrics (4 routes × 3) plus 4 alarms and 1 dashboard. That is mostly inside the free tier and under $1 a month beyond it, and only while the API stack exists.
- The `IAM` policy allows `cloudwatch:PutMetricData` only for the `MiniMaps/Api` namespace.
- The last partial minute is flushed on SIGTERM, so deploys and scale-in don't lose data.
