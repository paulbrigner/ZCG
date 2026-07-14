# ZCG Phase 0 build checklist

Date: 2026-06-29

This checklist turns the prototype development plan into implementation-facing work. Phase 0 is intentionally narrow: create a deployable, secure foundation before importing source-system data or replacing current workflows.

## Status key

- `[x]` Implemented in the repo.
- `[ ]` Still required before Phase 0 can be called deployed.
- `[~]` Implemented as a scaffold; needs live AWS/account validation.

## Foundation

- [x] Pin Node 24 LTS for local development and deploy packaging.
- [x] Add Next.js 15, React 19, TypeScript app shell.
- [x] Add health endpoint at `/api/health`.
- [x] Add the protected grants dashboard at `/dashboard`; reserve `/admin` for administrative functions.
- [x] Add public projection endpoint at `/api/public/grants`.
- [x] Add Better Auth route handler at `/api/auth/[...all]`.
- [x] Add minimal email-code sign-in UI at `/sign-in`.
- [x] Add build-time defaults so local builds do not require production secrets.
- [x] Keep runtime secrets outside the repo.

## Auth, authorization, and audit

- [x] Use Better Auth for authentication and session handling.
- [x] Keep ZCG authorization in platform-owned tables.
- [x] Add principal, role, permission, role-assignment, and direct permission-grant tables.
- [x] Add bootstrap admin support with `BOOTSTRAP_ADMIN_EMAILS`.
- [x] Add server-side permission helpers.
- [x] Add `audit_events` and `public_audit_events`.
- [x] Record audit events for protected-route authorization checks.
- [x] Add public projection allowlist.
- [x] Add bootstrap admin sign-in path backed by Better Auth email OTP.
- [ ] Enable stronger auth before private records, writebacks, or approval workflows are enabled.

## Database and migration

- [x] Add repeatable SQL migration runner for local/direct database access.
- [x] Add Better Auth generated table migration.
- [x] Add Phase 0 schema migration.
- [x] Add deployed migration-runner Lambda scaffold.
- [x] Add sync-run tables.
- [x] Add source snapshot, source record, source link, reconciliation, and idempotency tables.
- [x] Verify both migrations apply cleanly and skip on a second local Postgres pass.
- [ ] Run the migration runner against the deployed AWS database.
- [ ] Confirm Better Auth tables and platform tables exist in the deployed database.

## Worker and storage

- [x] Add S3 snapshot writer scaffold.
- [x] Add scheduled sync worker Lambda scaffold.
- [x] Run the daily 3:00 AM Eastern source refresh through bounded source batches, reconciliation, and knowledge indexing.
- [x] Add worker-side Secrets Manager database credential loading.
- [x] Verify migration-runner handler applies/skips migrations against local Postgres.
- [x] Verify sync-worker handler records a completed DB-side sync run and audit event locally.
- [ ] Invoke the worker once in the target AWS account and verify a `sync_runs` row plus S3 snapshot.

## Deployment packaging

- [x] Add Dockerfile for Next.js standalone container builds.
- [x] Add CDK app and stack.
- [x] Provision VPC, private Aurora PostgreSQL, S3 snapshot bucket, Secrets Manager secrets, ECS Fargate service, ALB, Lambda workers, EventBridge rule, logs, and alarms.
- [x] Keep the database private inside the VPC.
- [x] Inject database credentials and Better Auth secret from Secrets Manager.
- [x] Output app URL, snapshot bucket, database secret ARN, sync worker name, and migration runner name.
- [~] `npm run infra:synth` succeeds locally.
- [ ] Bootstrap the target AWS account with CDK.
- [ ] Deploy the stack into the target AWS account.
- [ ] Set `betterAuthUrl` to the final custom domain or accepted ALB URL and redeploy if needed.
- [ ] Invoke migration runner in the deployed account.
- [ ] Confirm `/api/health` returns `ok: true` from the deployed URL.

## Verification

- [x] `npm audit --audit-level=moderate` reports no vulnerabilities.
- [x] `npm run lint` passes.
- [x] `npm run typecheck` passes.
- [x] `npm run build` passes.
- [x] `npm run infra:synth` passes.
- [x] Docker image builds locally.
- [x] Container `/api/health` smoke test passes on Node 24.
- [x] Container Better Auth OTP sign-in, bootstrap admin assignment, dashboard access, unauthenticated redirect, and authorization audit event smoke test pass locally.
- [ ] Deployed health check passes.
- [ ] Deployed migration runner succeeds.
- [ ] Bootstrap admin can authenticate and reach `/dashboard`.

## Not in Phase 0

- Source importers for GitHub, Sheets, Discourse, or Jotform.
- Private FPF/KYC/payment-instruction imports.
- Writebacks to GitHub, Discourse, Sheets, or email.
- Applicant intake replacement.
- Public grant directory backed by production source data.
