# 0004: Split stacks by cost profile

**Status:** accepted

## Context
This project runs on a personal AWS account. Some resources cost money every hour (ALB, Fargate, RDS), and others cost almost nothing when idle (S3, CloudFront, Lambda, Step Functions).

## Decision
| Stack | Contents | Lifetime |
|---|---|---|
| `MiniMaps-Network` | VPC, subnets, S3 gateway endpoint | always on, free |
| `MiniMaps-Storage` | tiles bucket | always on, cents |
| `MiniMaps-Api` | CloudFront, internal ALB, ECS Fargate | deploy for work or demos, then destroy |
| later: `MiniMaps-Pipeline` | Step Functions, Lambda, ECS task | always on, pay per run |
| later: `MiniMaps-Database` | RDS Postgres + PostGIS | deploy when needed |

## Consequences
- `npx cdk destroy MiniMaps-Api` brings the hourly cost close to zero without losing data.
- CloudFront takes several minutes to create and delete, so the API stack is slow to cycle. That is acceptable for demos.
- In production all stacks would stay up, and the split would follow ownership and deploy frequency rather than cost.
