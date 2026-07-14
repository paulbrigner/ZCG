# Amplify target for zcg.pgpz.org

Date: 2026-06-29

## Current AWS facts

Read-only checks against the target AWS profile showed:

- The profile resolves to the expected AWS account with sufficient administrative deployment permissions.
- Route53 has a public hosted zone for `pgpz.org`.
- No `zcg.pgpz.org` record currently exists in that hosted zone.
- Existing sibling Amplify apps are in `us-east-1` and use the `WEB_COMPUTE` platform.
- No CloudFront-scope AWS WAF web ACLs are currently present in the account.

## Corrected deployment assumption

Amplify is a strong target for the web tier and `zcg.pgpz.org` custom domain. It can connect a GitHub repo, run the Next.js build, host SSR output, provision the managed CloudFront path, and attach the Route53-managed domain.

Amplify does not remove the need to design the private backend boundary. The Phase 0 app currently talks directly to Postgres through `pg`, and the safest Phase 0 backend package keeps Aurora PostgreSQL private in a VPC. A private VPC database is not automatically reachable from Amplify-hosted SSR compute.

The target should therefore be treated as:

- **Amplify web tier:** public Next.js application at `https://zcg.pgpz.org`.
- **CDK backend tier:** private Aurora PostgreSQL, S3 snapshots, migration runner, sync workers, Secrets Manager secrets, logs, alarms, and IAM roles.
- **Integration boundary to decide before full deploy:** either keep the server app on ECS for DB-backed routes, or refactor Amplify-hosted routes to talk to backend APIs that run inside the VPC.

## WAF/domain note

Amplify can handle the custom domain and managed CloudFront hosting path. AWS WAF support exists for Amplify apps, but it is not a zero-config guarantee. A CloudFront-scope web ACL still needs to be created or selected and associated with the Amplify app when broader access warrants it.

## Recommended AWS identity model

Do not create long-lived IAM users for ZCG unless a specific external system requires one.

Use roles and service identities instead:

- `ZcgAmplifyServiceRole`: Amplify service role for build/deploy logging and controlled AWS access.
- `ZcgAmplifyComputeRole`: optional SSR compute role if the web tier needs to call AWS APIs directly.
- `ZcgCdkDeployRole`: deploy role for CDK backend changes if deployment moves to automation.
- `ZcgRuntimeRole`: role family for worker Lambda/ECS tasks, created by CDK with least-privilege policies.
- `ZCG Operators`: optional IAM Identity Center group/permission set for human operators.

Secrets should live in Secrets Manager or service-managed secrets. Avoid copying durable access keys, provider secrets, or database passwords into Amplify environment variables except when there is no better service-native mechanism.

## First deploy sequence

1. Commit and push the application repo.
2. Create the Amplify app in `us-east-1` connected to `paulbrigner/ZCG`.
3. Attach the `main` branch with Node 24 from `amplify.yml`; local/build tooling pins `24.18.0`, while Amplify SSR compute uses AWS-managed Node 24.x at runtime.
4. Attach `zcg.pgpz.org` from the `pgpz.org` Route53 hosted zone.
5. Set only non-sensitive web environment values in Amplify.
6. Deploy the CDK backend stack in the same account/region.
7. Run migrations with the migration-runner Lambda.
8. Configure Amplify SSR to use the CDK output `AmplifyComputeRoleArn`.
9. Set Amplify runtime variables for Data API mode:
   - `DATABASE_DRIVER=data-api`
   - `DB_CLUSTER_ARN=<DatabaseClusterArn output>`
   - `DB_SECRET_ARN=<DatabaseSecretArn output>`
   - `DB_NAME=zcg`
   - `ZCG_CORPUS_REFRESH_STATE_MACHINE_ARN=<CorpusRefreshStateMachineArn output>`
   - `ZCG_KNOWLEDGE_INDEX_WORKER_FUNCTION_NAME=<KnowledgeIndexWorkerFunctionName output>`
   - `BETTER_AUTH_URL=https://zcg.pgpz.org`
   - `BETTER_AUTH_SECRET=<Secrets Manager-backed or generated strong secret>`
   - `BOOTSTRAP_ADMIN_EMAILS=<initial admin emails>`
10. Verify `/api/health/db`, Better Auth sign-in, `/dashboard`, `/api/admin/source-records`, and an Administrator-triggered **Refresh corpus** run.
11. Create and associate a CloudFront-scope WAF web ACL before wider stakeholder access if public exposure increases.

## Phase 1 implication

Phase 1 source mirroring should be backend-first and read-only. Workers can safely import GitHub and Google Sheet data into private Aurora/S3 regardless of whether the public web tier is later hosted on Amplify, ECS, or a hybrid.

The backend connection spike selected RDS Data API as the Amplify-to-private-Aurora bridge. See [Backend connection spike](backend-connection-spike.md).
