# Backend connection spike

Date: 2026-06-29

## Decision

Use this deployment connection path for the Amplify-hosted web tier:

```text
Amplify SSR at zcg.pgpz.org
  -> Amplify SSR compute role
  -> RDS Data API
  -> private Aurora PostgreSQL
```

This keeps `zcg.pgpz.org` on Amplify while preserving the private database boundary. The database does not need public network access, and the web tier does not need long-lived database credentials.

## Repository changes

- `DATABASE_DRIVER=pg | data-api` selects the runtime database driver.
- `lib/db.ts` routes platform SQL through direct `pg` or RDS Data API.
- `lib/data-api.ts` converts `$1` Postgres placeholders to RDS Data API named parameters and maps Data API result rows.
- `lib/better-auth-data-api-adapter.ts` adds a Better Auth custom adapter over the Data API path.
- `/api/health/db` verifies the configured app runtime can execute SQL.
- CDK now outputs:
  - `DatabaseClusterArn`
  - `DatabaseSecretArn`
  - `AmplifyComputeRoleArn`
- CDK creates an Amplify SSR compute role with RDS Data API and DB-secret read permissions.

## Runtime configuration

For local/ECS/direct Postgres:

```text
DATABASE_DRIVER=pg
DATABASE_URL=postgres://...
```

For Amplify SSR:

```text
DATABASE_DRIVER=data-api
DB_CLUSTER_ARN=<DatabaseClusterArn>
DB_SECRET_ARN=<DatabaseSecretArn>
DB_NAME=zcg
BETTER_AUTH_URL=https://zcg.pgpz.org
BETTER_AUTH_SECRET=<strong secret>
BOOTSTRAP_ADMIN_EMAILS=<initial admin emails>
```

Attach the CDK output `AmplifyComputeRoleArn` as the Amplify SSR compute role.

## Proof required before zcg.pgpz.org launch

After the CDK backend exists in AWS and Amplify is configured with the compute role:

1. `GET /api/health/db` returns `ok: true` with `driver: "data-api"`.
2. Better Auth email OTP can create/read verification rows through Data API.
3. OTP sign-in creates a Better Auth session through Data API.
4. `/dashboard` can upsert the internal principal and grant bootstrap admin through Data API.
5. `/api/admin/source-records` can read mirrored records through Data API.

Until those five checks pass in AWS, the backend connection path should be treated as implemented but not deployment-proven.

## Known limitations

- The Data API adapter intentionally supports the Better Auth operations currently needed by the prototype. It rejects joins for now.
- The adapter uses one SQL statement per Better Auth operation and disables Better Auth adapter transactions for the spike.
- Source mirroring workers still use direct Postgres inside the VPC, which is appropriate for Lambda workers.
