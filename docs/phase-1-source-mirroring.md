# Phase 1 source mirroring

Date: 2026-06-29

Phase 1 begins the sync-first plan by importing read-only evidence from current public ZCG source systems. This phase deliberately does not normalize grants, replace intake, or write back to any existing system.

## Implemented sources

- GitHub issues from `ZcashCommunityGrants/zcashcommunitygrants`.
- Google Sheet CSV exports from configured tab gids, defaulting to gid `803214474` from the known ZCG sheet.

## What the worker records

Each Phase 1 run creates:

- a `sync_runs` row with source, status, counts, and metadata;
- source snapshots in S3 when `SNAPSHOT_BUCKET_NAME` is configured;
- `source_records` rows for each mirrored source object;
- `audit_events` rows for sync completion or failure.

The first pass preserves source-specific raw payloads. Canonical grant normalization and reconciliation are intentionally next, not hidden inside the importer.

## Local invocation

Start a local Postgres database and apply migrations:

```bash
docker run --rm --name zcg-phase1-postgres \
  -e POSTGRES_USER=zcg \
  -e POSTGRES_PASSWORD=zcg \
  -e POSTGRES_DB=zcg \
  -p 5433:5432 \
  -d postgres:16-alpine

DATABASE_URL=postgres://zcg:zcg@localhost:5433/zcg npm run db:migrate
```

Mirror GitHub issues:

```bash
DATABASE_URL=postgres://zcg:zcg@localhost:5433/zcg \
  npm run worker:sync -- --source github-issues
```

Mirror the default Google Sheet tab:

```bash
DATABASE_URL=postgres://zcg:zcg@localhost:5433/zcg \
  npm run worker:sync -- --source google-sheet
```

Mirror all configured Phase 1 public sources:

```bash
DATABASE_URL=postgres://zcg:zcg@localhost:5433/zcg npm run worker:sync
```

## Deployed Lambda invocation

After the CDK backend is deployed and migrations have run:

```bash
aws lambda invoke \
  --profile zodldashboard \
  --region us-east-1 \
  --function-name SYNC_WORKER_FUNCTION_NAME \
  --payload '{"source":"github-issues"}' \
  /tmp/zcg-github-sync.json

aws lambda invoke \
  --profile zodldashboard \
  --region us-east-1 \
  --function-name SYNC_WORKER_FUNCTION_NAME \
  --payload '{"source":"google-sheet"}' \
  /tmp/zcg-sheet-sync.json
```

## Configuration

Environment variables and matching CDK context:

- `ZCG_GITHUB_OWNER` / `-c githubOwner=...`
- `ZCG_GITHUB_REPO` / `-c githubRepo=...`
- `ZCG_GITHUB_MAX_PAGES` / `-c githubMaxPages=...`
- `ZCG_GOOGLE_SHEET_ID` / `-c googleSheetId=...`
- `ZCG_GOOGLE_SHEET_TABS` / `-c googleSheetTabs=name:gid,name2:gid2`

`GITHUB_TOKEN` or `ZCG_GITHUB_TOKEN` can be supplied later if anonymous GitHub API rate limits become a blocker.

## Admin inspection

Mirrored records can be read from the protected endpoint:

```text
/api/admin/source-records
```

That endpoint requires `source:mirror:read`.

## Local verification on 2026-06-29

Against a disposable local Postgres database:

- `github-issues` imported 319 GitHub issue records from `ZcashCommunityGrants/zcashcommunitygrants`.
- A second `github-issues` run skipped all 319 unchanged records.
- `google-sheet` imported 811 records from the default configured sheet tab: 1 tab record plus 810 row records.
- A combined `phase1-all` run saw 1,130 records and skipped all unchanged records.
- `/api/admin/source-records` returned mirrored records through Better Auth and `source:mirror:read`.

## Next Phase 1 work

- Add more known Google Sheet tab gids with stable names.
- Add a Discourse topic/post mirror.
- Add reconciliation issue generation for missing forum links, unmatched Sheet rows, stale statuses, and label/status conflicts.
- Add an admin source-mirror UI instead of API-only inspection.
- Define the first canonical grant/application projection from mirrored GitHub issues and Sheet rows.
