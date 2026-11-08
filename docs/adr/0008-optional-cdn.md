# 0008: CloudFront is optional (`-c cdn=false`)

**Status:** accepted

## Context
AWS reviewed this account and decided it is **not eligible for CloudFront yet**. New accounts can be reviewed again after a few paid billing cycles. ECS, Lambda, S3 and Step Functions all work. Without CloudFront, the API stack from ADR 0003 cannot be deployed at all, so the read path cannot be demoed.

## Decision
Add a deploy-time switch: `cdk deploy MiniMaps-Api -c cdn=false`.

| | `cdn=true` (default, ADR 0003) | `cdn=false` |
|---|---|---|
| Entry point | CloudFront → VPC origin → **internal** ALB | **Public** ALB in the public subnets |
| ALB security group | port 80 from the VPC CIDR only | port 80 from `0.0.0.0/0` |
| Client protocol | HTTPS (CloudFront certificate) | HTTP only (no domain or certificate yet) |
| `PUBLIC_BASE_URL` / `ApiUrl` | `https://<distribution>.cloudfront.net` | `http://<alb-dns>` |
| Dashboard | CloudFront + ALB + API + ECS | ALB + API + ECS |

Everything else is the same: the Fargate service, IAM, the alarms (they use ALB metrics, ADR 0007), autoscaling and the tasks' security group, which still accepts traffic only from the ALB. With the default (`cdn=true`), every resource in the synthesized template is unchanged.

## Why
- **Keep the demo honest instead of waiting.** The account constraint is external and will last months. A small, tested switch lets the rest of the system run in AWS now.
- **Keep the target design as the default.** `cdn=true` stays the production design; `cdn=false` is documented as a degraded mode, not a new architecture.
- **Alarms already sit on the ALB**, so on-call coverage is the same in both modes.

## Consequences
- **No edge cache.** Every request reaches the ALB and Fargate. Tiles still send `Cache-Control: immutable`, so browsers cache them, but there is no shared cache. Expect higher latency outside Frankfurt and more load on the tasks (autoscaling 1–3 covers a demo).
- **Plain HTTP.** Fine for public tiles and a public `pk.` Mapbox token, not for anything private. HTTPS needs a domain and an ACM certificate on an HTTPS listener: the next step if this mode lives longer.
- **Wider exposure.** The ALB is reachable from the internet, so there is no edge layer for WAF or DDoS absorption. The `x-amz-cf-id` request-id header is also client-controlled in this mode; it only affects log correlation.
- **Switching modes replaces the ALB** (internal ↔ internet-facing), so the URL changes. Deploy with `cdn=true` once the account is eligible again.
