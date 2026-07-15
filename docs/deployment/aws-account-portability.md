# AWS account portability guide

Date: 2026-06-29

This guide describes the Phase 0 deployment package for moving the ZCG prototype into a new AWS account with low friction.

## Deployment decision

The Phase 0 portable deployment path is CDK-managed AWS infrastructure:

- ECS Fargate service running the Next.js standalone container.
- Public Application Load Balancer.
- Private Aurora PostgreSQL database in a VPC.
- S3 bucket for raw source snapshots and exports.
- Secrets Manager secrets for database credentials and Better Auth.
- Lambda migration runner.
- Lambda sync worker.
- Signed webhook ingress, encrypted SQS queue with a dead-letter queue, and a
  single-concurrency targeted corpus-event worker.
- EventBridge Scheduler source-refresh pipeline and knowledge-embedding schedule.
- CloudWatch log groups and basic alarms.

This is intentionally more complete than a static hosting setup. The prototype needs a private relational database, worker execution, secrets, and audit/security foundations from day one. Keeping those resources in one CDK stack makes the system easier to reproduce in another AWS account.

The stack is stage-aware. Use `costMode=prototype-low-cost` while the system is idle or limited to internal prototype use, and `costMode=production-ready` when the full ECS/ALB/private-service posture is needed. See [Deployment cost modes](cost-modes.md) for the current low-cost and production-ready commands, pause/resume scripts, NAT tradeoffs, and cost estimates.

The repository also includes `amplify.yml` because Amplify remains a familiar sibling-system hosting pattern and is the intended web-tier target for `zcg.pgpz.org`. For DB-backed Phase 0 routes, CDK/ECS remains the safest complete runtime because it can live in the same VPC boundary as private Aurora PostgreSQL.

See [Amplify target for zcg.pgpz.org](amplify-zcg-target.md) for the current target-account/domain assessment and the web-tier/backend split.

## Prerequisites

- AWS CLI configured for the target account.
- Docker available locally for CDK container asset builds.
- Node 24.18.0 available locally.
- Amplify SSR runtime uses AWS-managed Node 24.x for the Node major used during build; it may not report the same minor/patch as local tooling.
- npm 11.
- CDK bootstrap permissions in the target account.
- A planned public URL for `betterAuthUrl` if using a custom domain. Without one, the stack uses its generated ALB URL.

## Local setup

```bash
fnm install 24.18.0
fnm use 24.18.0
npm ci
npm run check
npm run infra:synth
```

If `fnm` is not used, use any runtime manager that honors `.node-version` or `.nvmrc`.

## Bootstrap a target AWS account

```bash
aws sts get-caller-identity --profile TARGET_PROFILE
npx cdk bootstrap aws://ACCOUNT_ID/us-east-1 --profile TARGET_PROFILE
```

Change `us-east-1` if the target account should run elsewhere.

## Deploy

Use explicit context values so the same repo can deploy repeatably into different accounts and environments.

```bash
npm run infra:deploy -- \
  -c costMode=production-ready \
  --profile TARGET_PROFILE \
  -c appName=zcg-prototype \
  -c environment=prototype \
  -c betterAuthUrl=https://prototype.example.org \
  -c bootstrapAdminEmails=admin@example.org \
  -c removalPolicy=retain \
  -c deletionProtection=true
```

For an initial throwaway sandbox, use `-c removalPolicy=destroy -c deletionProtection=false`. Do not use that combination for a stakeholder demo or any environment holding useful data.

If no custom domain is ready, omit `-c betterAuthUrl=...`; the ECS task will use the generated ALB URL emitted as `AppUrl`. When a custom domain is attached later, redeploy with the final URL so Better Auth cookies and redirects use the durable hostname.

For the low-cost prototype posture in the `zodldashboard` account:

```bash
AWS_PROFILE=zodldashboard AWS_REGION=us-east-1 npm run infra:deploy:prototype-low-cost
```

The checked-in deployment helper defaults `SES_FROM_EMAIL` to
`no-reply@pgpz.org` for the current `zodldashboard` prototype account so the
Amplify SSR compute role keeps its SES send permission. Override
`SES_FROM_EMAIL` when deploying into another account or sender identity.

## Run migrations in the deployed account

After deployment, copy the `MigrationRunnerFunctionName` stack output and invoke it:

```bash
aws lambda invoke \
  --profile TARGET_PROFILE \
  --function-name MIGRATION_RUNNER_FUNCTION_NAME \
  /tmp/zcg-migration-output.json

cat /tmp/zcg-migration-output.json
```

Expected result:

```json
{
  "ok": true,
  "applied": ["0000_better_auth.sql", "0001_phase0_foundation.sql"],
  "skipped": []
}
```

Subsequent invocations should skip already-applied migrations.

## Verify the deployed app

Use the `AppUrl` stack output:

```bash
curl APP_URL/api/health
```

Expected result includes:

```json
{
  "ok": true,
  "app": "zcg-grants-prototype",
  "phase": "0"
}
```

## Bootstrap admin access

Set `bootstrapAdminEmails` during deploy. After the first successful Better Auth sign-in for one of those emails, the app grants the `admin` role to that Better Auth principal.

This avoids manual SQL in a new AWS account while keeping authorization in platform-owned tables.

In local development without `SES_FROM_EMAIL`, auth codes are logged by the server process. In a deployed AWS account, verify an SES identity and set `SES_FROM_EMAIL` before expecting email delivery.

## First corpus-refresh check

The source-refresh schedule is enabled when workers are enabled. It starts a
Step Functions pipeline every morning at 3:00 AM in the `America/New_York`
timezone. GitHub issues and Forum topics are processed in bounded batches before
reconciliation and a synchronous knowledge-index rebuild. The pipeline uses a
finite database lease so duplicate schedule delivery or repeated Admin requests
cannot overlap.
Set the CDK context `enableSourceSyncSchedule=false` when a deployment must remain
manual. Start the pipeline once after migrations to verify the path immediately:

```bash
aws stepfunctions start-execution \
  --profile TARGET_PROFILE \
  --state-machine-arn CORPUS_REFRESH_STATE_MACHINE_ARN \
  --name "manual-refresh-$(date -u +%Y%m%dT%H%M%SZ)" \
  --input '{"trigger":"manual","requestedAt":null,"requestedByPrincipalId":null}'
```

Expected output includes an execution ARN. The execution should finish in
`SUCCEEDED`, with a completed `phase1-all` parent run and bounded child runs on
the Telemetry page.

The stack also deploys a dormant hybrid refresh path by default. It does not
receive source events until administrators register the generated callback URLs
and secrets with GitHub, Discourse, or Google Drive. The existing Admin and
3:00 AM full refresh paths stay enabled during that transition. See the
[hybrid corpus refresh runbook](hybrid-corpus-refresh.md) for activation,
verification, access requirements, and rollback.

## Required follow-up before stakeholder use

- Attach a custom domain and redeploy with the final `betterAuthUrl`.
- Configure SES identity verification and set `SES_FROM_EMAIL` if email delivery should use SES instead of development logging.
- Invoke the migration runner.
- Confirm bootstrap admin sign-in.
- Confirm `/dashboard` is denied without auth and accessible with the bootstrap admin.
- Decide whether the ALB should be fronted by CloudFront/WAF before broader access.
