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
- Disabled EventBridge schedule for future sync jobs.
- CloudWatch log groups and basic alarms.

This is intentionally more complete than a static hosting setup. The prototype needs a private relational database, worker execution, secrets, and audit/security foundations from day one. Keeping those resources in one CDK stack makes the system easier to reproduce in another AWS account.

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

## First sync-worker check

The EventBridge schedule is disabled by default. Invoke the worker manually after migrations:

```bash
aws lambda invoke \
  --profile TARGET_PROFILE \
  --function-name SYNC_WORKER_FUNCTION_NAME \
  --payload '{"source":"phase0-manual","dryRun":true}' \
  /tmp/zcg-sync-output.json

cat /tmp/zcg-sync-output.json
```

Expected result includes a successful `syncRunId` and, when the snapshot bucket is configured, an S3 snapshot key.

## Required follow-up before stakeholder use

- Attach a custom domain and redeploy with the final `betterAuthUrl`.
- Configure SES identity verification and set `SES_FROM_EMAIL` if email delivery should use SES instead of development logging.
- Invoke the migration runner.
- Confirm bootstrap admin sign-in.
- Confirm `/admin` is denied without auth and accessible with the bootstrap admin.
- Decide whether the ALB should be fronted by CloudFront/WAF before broader access.
