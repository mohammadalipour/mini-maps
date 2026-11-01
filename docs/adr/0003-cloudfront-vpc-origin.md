# 0003: CloudFront VPC origin to an internal ALB, no NAT gateway

**Status:** accepted

## Context
The API must only be reachable through CloudFront, both for caching and so that clients cannot bypass the edge. The project should also cost close to nothing.

## Options
1. Public ALB that checks a secret header added by CloudFront. Traffic between CloudFront and the ALB goes over the internet (HTTP without a custom domain), the ALB pays for public IPv4 addresses, and the secret has to be managed.
2. Public ALB restricted to CloudFront's managed prefix list. It needs a lookup at synth time and takes up most of a security group's rule quota.
3. **Internal ALB behind a CloudFront VPC origin.** The ALB has no public address at all.

## Decision
Option 3. The ALB lives in isolated subnets. Its security group accepts port 80 only from inside the VPC, which is where the CloudFront VPC origin's network interfaces live.

Fargate tasks run in public subnets with a public IP but accept traffic only from the ALB's security group. This lets them pull images from ECR and send logs without a NAT gateway (about $33/month each). S3 traffic goes through a free gateway endpoint.

## Consequences
- There is nothing public to attack apart from CloudFront.
- The ALB has no public IPv4 addresses to pay for.
- Production would move tasks to private subnets with VPC interface endpoints or NAT, and add HTTPS to the origin once there is a domain and certificate.
