# Phase 1 source mirroring

Date: 2026-06-29

Phase 1 began the sync-first plan by importing read-only evidence from current
public ZCG source systems. The source boundary remains read-only: the prototype
does not replace intake or write back to any existing system. A separate,
implemented reconciliation layer now derives canonical applications, grants,
links, issues, decision history, and knowledge documents from that evidence.

## Implemented sources

- GitHub issues from `ZcashCommunityGrants/zcashcommunitygrants`.
- GitHub issue comments from those grant issues, including follow-up comments
  that often contain the corresponding forum thread link.
- Google Sheet CSV exports from configured tab gids, defaulting to:
  - `all_grants_tracking:1164534734` for the comprehensive historical list of
    every ZCG proposal/grant considered.
  - `milestone_details:803214474` for milestone, payment, and detail rows.
- Zcash Community Forum topic JSON for discovered forum URLs. The mirror stores
  plain-text post bodies alongside the original cooked Discourse HTML so grant
  knowledge retrieval can use public application/discussion text, not only the
  forum URL.
- Zcash Community Grants Updates category topics from
  `https://forum.zcashcommunity.com/c/grants/zomg-updates/34`. Meeting-minutes
  topics are mirrored as `forum_meeting_minutes`; other category posts are
  mirrored as `forum_update_topic`.

## What the worker records

Each Phase 1 run creates:

- a `sync_runs` row with source, status, counts, and metadata;
- source snapshots in S3 when `SNAPSHOT_BUCKET_NAME` is configured;
- `source_records` rows for each mirrored source object;
- `audit_events` rows for sync completion or failure.

The mirror preserves source-specific raw payloads. Canonical normalization and
reconciliation run as explicit later workflow steps rather than being hidden
inside the importer.

## Historical registry refinement

As of 2026-07-07, reconciliation treats the `ZCG All Grants Tracking` tab
(`gid=1164534734`) as the historical proposal/application registry. Each titled
row in that tab is eligible to become a canonical `grant_applications` record,
including older grants that predate GitHub intake.

The milestone/payment tab (`gid=803214474`) is no longer treated as the
complete application list. Its rows are detail evidence that should attach to an
All Grants registry row or a GitHub application. Payment/detail rows that do not
match the historical registry produce reconciliation issues instead of becoming
canonical applications by default.

The current adapter maps:

- `Proposal Title` -> canonical application title.
- `Applicant(s)` -> applicant/grantee display name.
- `Grant Status` -> normalized status.
- `Grant Platform Link` -> GitHub issue link when it points to GitHub, or a
  legacy proposal-platform source URL otherwise.
- `Forum Link` -> forum source evidence and a public Forum topic mirror target.
- `Date Committee Approved/ Rejected`, `Decision Turnaround Days`, `Country`,
  and `Organization or Individual` -> source summary metadata.

## Normalized FPF milestone and disbursement ledger

As of 2026-07-15, strongly matched rows from the `milestone_details` tab are
also projected into two read-only canonical tables:

- `grant_milestones` stores the milestone label and number/type, grantee,
  category, reporting frequency, the Sheet's `Amount (USD)` row value, estimate text and any
  safely parsed estimate date, FPF grant status, source row, match confidence,
  and linkage method.
- `grant_disbursements` stores only payment evidence explicitly present in the
  row: paid date, ZEC disbursed, USD disbursed, and ZEC/USD rate. The milestone
  row amount is never copied into the disbursed amount.

The projection is deliberately conservative. An automatically generated
source link must meet the strong match threshold, while an active reviewer
`link_source` decision can admit a lower-scoring but confirmed match. Rows that
remain ambiguous continue to produce reconciliation issues and are not shown
as belonging to a grant. Projection updates run after both complete and
targeted grant reconciliation, and obsolete projections are removed within
the reconciled scope.

These records are FPF Sheet ledger evidence, not a complete payment workflow.
The current Sheet fields do not establish that a progress update was accepted,
a payment request was submitted or approved, or an on-chain transaction
settled. Those states remain separate until an authoritative source and durable
cross-source identifiers are available.

## ZCG meeting minutes and decision evidence

As of 2026-07-09, reconciliation treats ZCG meeting minutes as decision
evidence, not merely supporting forum links. The sync worker mirrors the
Community Grants Updates category, stores meeting-minute topics as source
records, and extracts per-application decision mentions into:

- `grant_decision_sources`: one row per mirrored meeting-minutes topic.
- `grant_decision_mentions`: one row per grant/application decision mention.

The parser preserves the meeting source, meeting date, referenced proposal URL,
normalized decision, decision text, committee rationale, speaker notes, match
method, and confidence. Direct URL matches to already-linked GitHub, Sheet, or
Forum evidence are accepted automatically. Low-confidence or unlinked mentions
produce `reconciliation_issues` for review.

Accepted decision mentions are also added to the grant knowledge index as
`decision_minutes` documents so grounded retrieval can answer questions about
committee rationale and recorded outcomes.

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

Mirror the configured Google Sheet tabs:

```bash
DATABASE_URL=postgres://zcg:zcg@localhost:5433/zcg \
  npm run worker:sync -- --source google-sheet
```

Mirror all configured Phase 1 public sources:

```bash
DATABASE_URL=postgres://zcg:zcg@localhost:5433/zcg npm run worker:sync
```

Mirror only explicit Forum topics:

```bash
ZCG_FORUM_TOPIC_URLS=https://forum.zcashcommunity.com/t/example/12345 \
  DATABASE_URL=postgres://zcg:zcg@localhost:5433/zcg \
  npm run worker:sync -- --source forum-topics
```

Mirror the ZCG Updates category:

```bash
DATABASE_URL=postgres://zcg:zcg@localhost:5433/zcg \
  npm run worker:sync -- --source forum-updates
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

aws lambda invoke \
  --profile zodldashboard \
  --region us-east-1 \
  --function-name SYNC_WORKER_FUNCTION_NAME \
  --payload '{"source":"forum-topics","forum":{"urls":["https://forum.zcashcommunity.com/t/example/12345"]}}' \
  /tmp/zcg-forum-sync.json
```

## Deployed refresh orchestration

Direct Lambda invocation remains useful for diagnosis, but normal deployed
operation uses the hybrid orchestration:

| Trigger | Behavior |
| --- | --- |
| GitHub `issues` or `issue_comment` webhook | Signature-verified, queued, and deduplicated update of the configured issue, comments, linked Forum evidence, affected reconciliation, and knowledge documents |
| Discourse topic or post webhook | Signature-verified and queued update only when the topic is already linked to a known grant or mirrored as grant evidence |
| Google Sheet schedule | Every 15 minutes by default, compare deterministic checksums of the configured public CSV tabs; stop without database work when unchanged, or run the Sheet-only workflow when changed |
| Daily schedule | At 3:00 AM `America/New_York`, run the complete bounded GitHub → Sheet → linked Forum → Forum Updates → reconciliation → index workflow |
| Admin **Refresh corpus** | Start the same complete workflow as the daily schedule |

Every mutation path shares one durable corpus lease. Provider deliveries are
buffered in encrypted SQS with a dead-letter queue, and delivery IDs provide
idempotency across provider retries. The changed-Sheet workflow commits its S3
success marker only after mirroring, authoritative pruning, reconciliation,
newly discovered Forum mirroring, and indexing succeed. The first scheduled
Sheet check intentionally bootstraps this marker. Google Drive notifications are
not required and remain dormant.

FPF assignment controls committee-review eligibility. Reconciliation produces
`under_review` from GitHub only when both `Grant Application` and
`Ready For ZCG Review` are present. A Sheet “review” value remains evidence and
creates a warning when those labels are absent; it cannot promote the proposal
into the committee worklist or make it eligible for briefing generation.

See [Hybrid corpus refresh](deployment/hybrid-corpus-refresh.md) for callback
activation, CDK controls, monitoring, cutover, and rollback.

## Configuration

Environment variables and matching CDK context:

- `ZCG_GITHUB_OWNER` / `-c githubOwner=...`
- `ZCG_GITHUB_REPO` / `-c githubRepo=...`
- `ZCG_GITHUB_MAX_PAGES` / `-c githubMaxPages=...`
- `ZCG_GITHUB_COMMENT_MAX_PAGES`
- `ZCG_GITHUB_TOKEN_SECRET_ID` / `-c githubTokenSecretId=...`
- `ZCG_GOOGLE_SHEET_ID` / `-c googleSheetId=...`
- `ZCG_GOOGLE_SHEET_TABS` / `-c googleSheetTabs=name:gid,name2:gid2`
- `ZCG_FORUM_MAX_TOPICS`
- `ZCG_FORUM_MAX_POSTS_PER_TOPIC`
- `ZCG_FORUM_MAX_CATEGORY_PAGES`
- `ZCG_FORUM_FETCH_DELAY_MS`
- `ZCG_FORUM_TOPIC_URLS`
- `ZCG_FORUM_UPDATES_CATEGORY_URL`

Refresh-orchestration CDK contexts:

- `enableHybridCorpusRefresh` (defaults to the `enableWorkers` value)
- `enableGoogleSheetPollSchedule` (defaults to the `enableWorkers` value)
- `googleSheetPollMinutes` (15 by default; minimum 5)
- `enableSourceSyncSchedule` (defaults to the `enableWorkers` value)
- `githubWebhookSecretId`, `discourseWebhookSecretId`, and the dormant
  `googleDriveChannelTokenSecretId`

`GITHUB_TOKEN`, `ZCG_GITHUB_TOKEN`, or a Secrets Manager secret referenced by
`ZCG_GITHUB_TOKEN_SECRET_ID` should be supplied for reliable GitHub comment
mirroring, since comments require one API request per issue with comments and
anonymous GitHub API rate limits are low. The deployment scripts default to the
secret name `zcg/prototype/github-mirror-token`; override
`GITHUB_TOKEN_SECRET_ID` when deploying into another AWS account or environment.

The secret may contain the raw token string or JSON with a `token`,
`GITHUB_TOKEN`, or `ZCG_GITHUB_TOKEN` field. Use a fine-grained GitHub PAT with
read-only Issues permission for `ZcashCommunityGrants/zcashcommunitygrants`.

Forum mirroring is public and unauthenticated. `phase1-all` discovers Forum
URLs from mirrored GitHub and Sheet payloads, then fetches topic JSON for up to
`ZCG_FORUM_MAX_TOPICS` topics per run. `ZCG_FORUM_MAX_POSTS_PER_TOPIC` limits
post expansion for long discussion threads. `ZCG_FORUM_FETCH_DELAY_MS` adds a
pause between topic requests so the mirror is polite to Discourse rate limits.

## Admin inspection

Mirrored records can be read from the protected endpoint:

```text
/api/admin/source-records
```

That endpoint requires `source:mirror:read`.

Administrators can start a complete deployed refresh from **Admin → Source
corpus → Refresh corpus**. **Rebuild index** is narrower and does not fetch any
source system. Operational `sync_runs`, counts, and failures are available on
`/admin/telemetry`.

## Local verification on 2026-06-29

Against a disposable local Postgres database:

- `github-issues` imported 319 GitHub issue records from `ZcashCommunityGrants/zcashcommunitygrants`.
- A second `github-issues` run skipped all 319 unchanged records.
- `google-sheet` imported 811 records from the default configured sheet tab: 1 tab record plus 810 row records.
- A combined `phase1-all` run saw 1,130 records and skipped all unchanged records.
- `/api/admin/source-records` returned mirrored records through Better Auth and `source:mirror:read`.

## Local verification on 2026-07-07

Against a disposable local Postgres database with the non-vector migrations:

- `google-sheet` imported 1,428 records from the two configured Sheet tabs.
- `all_grants_tracking` contributed 611 titled historical proposal/application
  rows after CSV parsing.
- `reconcile:grants` produced 611 canonical `sheet-all-grants:*`
  applications from the historical registry.
- The run produced 161 funded grant records from approved historical rows.
- 12 payment/detail projects did not match the historical registry and were
  retained as reconciliation issues rather than promoted to canonical
  applications.
- A full unauthenticated GitHub+Sheet local rehearsal was blocked by GitHub API
  rate limits while fetching issue comments; use `GITHUB_TOKEN` or
  `ZCG_GITHUB_TOKEN` for full local public-source reconciliation.

## Next Phase 1 work

- Continue adding known Google Sheet tab gids with stable names where they
  represent distinct evidence classes.
- Add durable cross-source grant and milestone identifiers when the source
  systems expose them, and define separate authoritative progress-update,
  payment-request, approval, and settlement records rather than inferring them
  from milestone ledger fields.
- Monitor provider callbacks, the 15-minute Sheet poll, the event dead-letter
  queue, and daily verification results through several cutover cycles.
- Continue expanding reviewer tools for missing Forum links, unmatched Sheet
  rows, stale statuses, and label/status conflicts.
