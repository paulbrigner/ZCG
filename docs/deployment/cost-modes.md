# ZCG deployment cost modes

Date: 2026-07-01

This document describes the stage-aware cost model for `ZcgPrototypeStack` in
`us-east-1` under the `zodldashboard` AWS profile.

The stack now has two explicit modes:

- `prototype-low-cost`: reduce idle spend during the prototype phase while
  keeping the private backend and sync-first migration path intact.
- `production-ready`: keep the full private ECS/Fargate, ALB, private database,
  NAT egress, logs, health checks, alarms, and scaling posture available for
  stakeholder or production-style use.

Both modes keep the cost allocation tags:

- `Project=ZCG`
- `Environment=prototype`
- `Application=zcg`
- `Repository=paulbrigner/ZCG`
- `ManagedBy=Codex`

The stack also adds `CostMode=<mode>` so cost reports can distinguish the active
operating posture.

## Current deployed architecture

The current ZCG prototype is split across:

- Amplify SSR web tier for `https://zcg.pgpz.org`.
- CDK backend stack `ZcgPrototypeStack`.
- Aurora PostgreSQL Serverless v2 cluster with RDS Data API enabled.
- Private S3 snapshot bucket for source mirror snapshots.
- Secrets Manager secrets for database and Better Auth.
- Lambda migration runner and sync worker in the VPC.
- Signature-verifying webhook ingress, encrypted source-event queue and
  dead-letter queue, and a targeted corpus-event worker.
- Optional ECS/Fargate web tier and optional public ALB.
- VPC with private database subnets and NAT egress when deployed workers need
  public internet access.

The Amplify web tier uses the CDK-created compute role and talks to Aurora
through the RDS Data API. That lets the prototype stay reachable at
`zcg.pgpz.org` even when the optional ECS web service and ALB are removed in
low-cost mode.

## Prototype low-cost mode

Use this mode while the system is still a personal or internal prototype with
no real external user traffic.

Default behavior:

- ECS/Fargate web service is not deployed.
- Application Load Balancer is not deployed.
- Aurora Serverless v2 minimum capacity is `0` ACU.
- Aurora auto-pause is enabled with `dbAutoPauseSeconds=900`.
- Aurora maximum capacity defaults to `1` ACU.
- Container Insights is disabled.
- CloudWatch log retention defaults to 7 days.
- Nonessential alarms are disabled.
- Lambda workers remain deployed.
- The hybrid refresh receiver and event queue remain deployed; they are idle and
  request-authenticated until source callbacks are registered.
- The low-volume Step Functions pipeline for the daily 3:00 AM Eastern source refresh and the hourly embedding catch-up remain enabled.
- One NAT gateway remains deployed because the current sync worker needs public
  internet egress for GitHub and Google Sheet mirroring.

Deploy or diff:

```bash
AWS_PROFILE=zodldashboard AWS_REGION=us-east-1 npm run infra:diff:prototype-low-cost
AWS_PROFILE=zodldashboard AWS_REGION=us-east-1 npm run infra:deploy:prototype-low-cost
```

Equivalent raw CDK command:

```bash
AWS_PROFILE=zodldashboard AWS_REGION=us-east-1 npm run infra:deploy -- \
  -c costMode=prototype-low-cost \
  -c environment=prototype \
  -c removalPolicy=retain \
  -c deletionProtection=true \
  -c sesFromEmail=no-reply@pgpz.org
```

This is the safest low-cost default because it avoids always-on web compute and
ALB charges while preserving the deployed sync-first worker path.

## Optional ECS web tier in prototype mode

If the ECS runtime is needed temporarily, re-enable it through CDK context:

```bash
AWS_PROFILE=zodldashboard AWS_REGION=us-east-1 npm run infra:deploy -- \
  -c costMode=prototype-low-cost \
  -c enableWebService=true \
  -c webDesiredCount=1 \
  -c removalPolicy=retain \
  -c deletionProtection=true \
  -c sesFromEmail=no-reply@pgpz.org
```

Pause the ECS service after testing:

```bash
AWS_PROFILE=zodldashboard AWS_REGION=us-east-1 npm run infra:pause-web
```

Resume a deployed ECS service:

```bash
AWS_PROFILE=zodldashboard AWS_REGION=us-east-1 npm run infra:resume-web -- 1
```

If the low-cost deployment removed the ECS service entirely, `infra:resume-web`
prints the CDK deploy command needed to recreate it.

## ALB optional path

The ALB can be omitted for prototype-only ECS testing:

```bash
AWS_PROFILE=zodldashboard AWS_REGION=us-east-1 npm run infra:deploy -- \
  -c costMode=prototype-low-cost \
  -c enableWebService=true \
  -c enableAlb=false \
  -c webIngressCidr=YOUR_PUBLIC_IP/32 \
  -c webDesiredCount=1 \
  -c removalPolicy=retain \
  -c deletionProtection=true \
  -c sesFromEmail=no-reply@pgpz.org
```

This places the ECS task in a public subnet with a public IP and opens port
`3000` only to `webIngressCidr`. It is cheaper than an ALB for short testing,
but it is not the production-ready posture. Use the helper to find the task URL:

```bash
AWS_PROFILE=zodldashboard AWS_REGION=us-east-1 npm run infra:web-task-url
```

## NAT gateway tradeoff

`prototype-low-cost` intentionally keeps `natGateways=1` while workers are
enabled.

Reason: the current sync worker runs inside the VPC, connects directly to the
private database, and reaches public source systems such as GitHub and Google
Sheets. Removing NAT while keeping that worker would break deployed mirroring.

The stack prevents `natGateways=0` with `enableWorkers=true` for that reason.
The cheaper but more limited posture is:

```bash
AWS_PROFILE=zodldashboard AWS_REGION=us-east-1 npm run infra:deploy -- \
  -c costMode=prototype-low-cost \
  -c enableWorkers=false \
  -c natGateways=0 \
  -c removalPolicy=retain \
  -c deletionProtection=true \
  -c sesFromEmail=no-reply@pgpz.org
```

Only use that when deployed migration and source-sync Lambdas are intentionally
off. It saves the NAT gateway baseline, but it is not the normal sync-first
prototype posture. The better future optimization is to move deployed workers
to an out-of-VPC/Data API write path so they can keep public source egress
without requiring NAT.

## Aurora scale-to-zero support

The deployed Aurora PostgreSQL engine is `16.13`. AWS documents Aurora
PostgreSQL auto-pause support for versions at least `16.3`, `15.7`, `14.12`,
or `13.15`, and CDK `aws-cdk-lib` recognizes `16.13` as supporting Aurora
Serverless v2 auto-pause.

Prototype mode sets:

```text
serverlessV2MinCapacity=0
serverlessV2MaxCapacity=1
serverlessV2AutoPauseDuration=900 seconds
```

Production-ready mode sets:

```text
serverlessV2MinCapacity=0.5
serverlessV2MaxCapacity=2
```

Override either mode with:

```bash
-c dbMinAcu=0.5 -c dbMaxAcu=2
```

## Production-ready mode

Use this when the prototype needs production-style runtime characteristics:

- Private ECS/Fargate web service.
- Internet-facing ALB.
- Private Aurora PostgreSQL.
- NAT egress for private compute.
- Health checks and CloudWatch alarms.
- One-month log retention.
- Container Insights enabled.
- Fargate desired count defaults to 1.
- Aurora minimum capacity defaults to 0.5 ACU and maximum to 2 ACU.

Deploy or diff:

```bash
AWS_PROFILE=zodldashboard AWS_REGION=us-east-1 npm run infra:diff:production-ready
AWS_PROFILE=zodldashboard AWS_REGION=us-east-1 npm run infra:deploy:production-ready
```

This mode keeps the same stateful resources and reintroduces the optional web
runtime without redesigning the backend.

## Backup and destructive-change safety

Before deploying a CDK change that modifies the database configuration, verify
automated snapshots or take a manual snapshot:

```bash
AWS_PROFILE=zodldashboard AWS_REGION=us-east-1 aws rds describe-db-cluster-snapshots \
  --db-cluster-identifier zcgprototypestack-databaseb269d8bb-eks7c49qusdq \
  --snapshot-type automated \
  --query 'reverse(sort_by(DBClusterSnapshots,&SnapshotCreateTime))[0:5].{Id:DBClusterSnapshotIdentifier,Status:Status,Created:SnapshotCreateTime,Type:SnapshotType}' \
  --output json
```

Always run diff before deploy:

```bash
AWS_PROFILE=zodldashboard AWS_REGION=us-east-1 npm run infra:diff:prototype-low-cost
```

Stop before deploying if the diff shows replacement or deletion of any stateful
resource, especially:

- `AWS::RDS::DBCluster`
- `AWS::RDS::DBInstance`
- `AWS::SecretsManager::Secret`
- `AWS::S3::Bucket`

Changing Aurora scaling configuration from `0.5` to `0` should be an in-place
database cluster update, not a database replacement.

## Expected cost impact

Approximate us-east-1 idle baseline before storage, I/O, logs, data transfer,
and Amplify:

| Component | Previous idle posture | Approx monthly fixed cost |
| --- | --- | ---: |
| Aurora Serverless v2 compute | 0.5 ACU minimum | `$43.80` |
| ECS Fargate web task | 0.5 vCPU, 1 GB, always on | `$18.00` |
| Application Load Balancer | Always on, before meaningful LCU usage | `$16.43+` |
| NAT gateway | One gateway, before data processing | `$32.85+` |

Default `prototype-low-cost` removes or pauses the first three items during
idle periods, reducing fixed idle spend by roughly `$78` to `$85` per month
before smaller CloudWatch savings. The NAT gateway remains because it protects
the deployed sync-first worker path.

The additional `enableWorkers=false -c natGateways=0` posture can save another
roughly `$32.85` per month, but deployed sync and migration Lambdas are then
off and must be re-enabled before running source mirroring from AWS.
