# 0001: Infrastructure as code with AWS CDK (TypeScript)

**Status:** accepted

## Context
All AWS resources must be reproducible and reviewable in pull requests. Terraform and CDK were both options.

## Decision
Use AWS CDK v2 in TypeScript, one CDK app in `infra/`.

## Why
- It is the team's standard tool (named in the Maps API job description), so the code matches how the team works.
- It lives next to the Node.js service in the same language.
- CDK builds and pushes the API's Docker image and Lambda code as part of `cdk deploy`. With Terraform, that is a separate CI step.
- Higher-level constructs give secure defaults (grants, security group wiring) with less code.

## Consequences
- State lives in CloudFormation, so there is no state bucket to manage, but deploys are slower than `terraform apply`.
- Stacks are split by cost profile (see 0004), and cross-stack references go through CloudFormation exports.
