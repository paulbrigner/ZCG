import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { reconciliationDecisionKey } from "../../lib/reconciliation/decisions";
import { grantPlatformSourceId } from "../../lib/source-mirroring/google-sheet";
import { upsertSourceRecords } from "../../lib/source-mirroring/store";
import type { SourceMirrorRecord } from "../../lib/source-mirroring/types";

const testDatabaseUrl = process.env.ZCG_TEST_DATABASE_URL;
const { Client } = pg;

const legacySourceRecordId = "22222222-2222-4222-8222-222222222222";
const applicationId = "33333333-3333-4333-8333-333333333333";
const sourceLinkId = "44444444-4444-4444-8444-444444444444";
const decisionId = "55555555-5555-4555-8555-555555555555";
const snapshotId = "77777777-7777-4777-8777-777777777777";
const initialSyncRunId = "11111111-1111-4111-8111-111111111111";
const changedSyncRunId = "88888888-8888-4888-8888-888888888888";
const revertedSyncRunId = "99999999-9999-4999-8999-999999999999";
const removedSyncRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sheetId = "sheet-one";
const gid = "1164534734";
const legacySourceId = `${sheetId}:${gid}:row:322`;
const grantPlatformLink =
  "https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues/24/";
const stableSourceId = grantPlatformSourceId(sheetId, gid, grantPlatformLink);
const tabUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit?gid=${gid}`;

function checksum(payload: Record<string, unknown>) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function sheetRecord(
  rowNumber: number,
  status: "Submitted" | "Completed"
): SourceMirrorRecord {
  const rawPayload = {
    "Proposal Title": "Test Grant",
    "Grant Platform Link": grantPlatformLink,
    "Grant Status": status
  };

  return {
    sourceKind: "google_sheet_row",
    sourceId: stableSourceId,
    sourceUrl: tabUrl,
    sourceUpdatedAt: null,
    title: "Test Grant",
    summary: `Proposal Title: Test Grant | Grant Status: ${status}`,
    rawPayload,
    metadata: {
      sheetId,
      tabName: "all_grants_tracking",
      gid,
      rowNumber,
      rowLocationSourceId: `${sheetId}:${gid}:row:${rowNumber}`,
      identityStrategy: "grant_platform_link",
      businessIdentifierField: "Grant Platform Link",
      businessIdentifier: grantPlatformLink.replace(/\/+$/, ""),
      businessIdentifierRaw: grantPlatformLink
    }
  };
}

async function migrationSql(file: string) {
  return fs.readFile(path.join(process.cwd(), "migrations", file), "utf8");
}

test(
  "migration 0019 preserves stable Sheet ownership and appends immutable observations",
  {
    skip: testDatabaseUrl
      ? false
      : "set ZCG_TEST_DATABASE_URL to run PostgreSQL migration integration tests",
    timeout: 60_000
  },
  async () => {
    assert.ok(testDatabaseUrl);

    const schema = `zcg_sheet_observation_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = `"${schema}"`;
    const client = new Client({ connectionString: testDatabaseUrl });
    await client.connect();

    try {
      await client.query(`create schema ${quotedSchema}`);
      await client.query(`set search_path to ${quotedSchema}, public`);

      await client.query("begin");
      try {
        for (const file of [
          "0001_phase0_foundation.sql",
          "0002_phase1_source_mirroring.sql",
          "0003_phase2_canonical_reconciliation.sql",
          "0008_manual_reconciliation_decisions.sql"
        ]) {
          await client.query(await migrationSql(file));
        }

        const initial = sheetRecord(322, "Submitted");
        await client.query(
          `insert into sync_runs (id, source, status)
           values ($1, 'google_sheet', 'completed')`,
          [initialSyncRunId]
        );
        await client.query(
          `insert into source_snapshots (
             id, sync_run_id, source_kind, source_id, source_url,
             s3_bucket, s3_key, checksum_sha256
           )
           values ($1, $2, 'google_sheet_csv', $3, $4, 'test-bucket', 'test-key', 'snapshot-a')`,
          [snapshotId, initialSyncRunId, `${sheetId}:${gid}`, tabUrl]
        );
        await client.query(
          `insert into source_records (
             id, source_kind, source_id, source_url, source_updated_at,
             checksum_sha256, raw_snapshot_id, title, summary, raw_payload, metadata
           )
           values (
             $1, 'google_sheet_row', $2, $3, null,
             $4, $5, $6, $7, $8::jsonb, $9::jsonb
           )`,
          [
            legacySourceRecordId,
            legacySourceId,
            tabUrl,
            checksum(initial.rawPayload),
            snapshotId,
            initial.title,
            initial.summary,
            JSON.stringify(initial.rawPayload),
            JSON.stringify({
              sheetId,
              tabName: "all_grants_tracking",
              gid,
              rowNumber: 322
            })
          ]
        );
        await client.query(
          `insert into grant_applications (id, canonical_key, title)
           values ($1, 'github_issue:24', 'Test Grant')`,
          [applicationId]
        );
        await client.query(
          `insert into source_links (
             id, source_record_id, canonical_type, canonical_id
           )
           values ($1, $2, 'grant_application', $3)`,
          [sourceLinkId, legacySourceRecordId, applicationId]
        );
        await client.query(
          `insert into reconciliation_decisions (
             id, decision_key, decision_type, status, source_kind, source_id,
             canonical_type, canonical_key, rationale
           )
           values (
             $1, 'test-link-row-322', 'link_source', 'active',
             'google_sheet_row', $2, 'grant_application', 'github_issue:24',
             'Migration integration test'
           )`,
          [decisionId, legacySourceId]
        );

        await client.query(await migrationSql("0019_stable_sheet_identity_observations.sql"));
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }

      const migrated = await client.query<{
        id: string;
        source_id: string;
        legacy_source_id: string | null;
      }>(
        `select id,
                source_id,
                metadata->>'legacySourceId' as legacy_source_id
           from source_records
          where id = $1`,
        [legacySourceRecordId]
      );
      assert.deepEqual(migrated.rows, [{
        id: legacySourceRecordId,
        source_id: stableSourceId,
        legacy_source_id: legacySourceId
      }]);

      const preservedLink = await client.query(
        `select 1
           from source_links
          where id = $1
            and source_record_id = $2`,
        [sourceLinkId, legacySourceRecordId]
      );
      assert.equal(preservedLink.rowCount, 1);

      const migratedDecision = await client.query<{
        decision_key: string;
        source_id: string;
        legacy_source_id: string | null;
      }>(
        `select decision_key,
                source_id,
                evidence->>'legacySourceId' as legacy_source_id
           from reconciliation_decisions
          where id = $1`,
        [decisionId]
      );
      assert.deepEqual(migratedDecision.rows, [{
        decision_key: reconciliationDecisionKey({
          decisionType: "link_source",
          sourceKind: "google_sheet_row",
          sourceId: stableSourceId,
          canonicalType: "grant_application",
          canonicalKey: "github_issue:24",
          relatedCanonicalKey: null,
          relationshipType: null,
          fieldName: null,
          fieldValue: null,
          reconciliationIssueId: null
        }),
        source_id: stableSourceId,
        legacy_source_id: legacySourceId
      }]);

      const migrationObservations = await client.query<{
        version_number: number;
        source_id: string;
        observation_type: string;
      }>(
        `select version_number, source_id, observation_type
           from source_record_observations
          where source_record_id = $1
          order by version_number`,
        [legacySourceRecordId]
      );
      assert.deepEqual(migrationObservations.rows, [
        {
          version_number: 1,
          source_id: legacySourceId,
          observation_type: "present"
        },
        {
          version_number: 2,
          source_id: stableSourceId,
          observation_type: "present"
        }
      ]);

      const unchanged = await upsertSourceRecords(
        client,
        [sheetRecord(322, "Submitted")],
        null,
        changedSyncRunId
      );
      assert.deepEqual(unchanged, {
        recordsSeen: 1,
        recordsCreated: 0,
        recordsUpdated: 0,
        recordsSkipped: 1
      });

      const changed = await upsertSourceRecords(
        client,
        [sheetRecord(400, "Completed")],
        null,
        changedSyncRunId
      );
      assert.equal(changed.recordsUpdated, 1);

      const reverted = await upsertSourceRecords(
        client,
        [sheetRecord(322, "Submitted")],
        null,
        revertedSyncRunId
      );
      assert.equal(reverted.recordsUpdated, 1);

      await assert.rejects(
        client.query(
          `insert into source_records (
             source_kind, source_id, source_url, checksum_sha256,
             title, summary, raw_payload, metadata
           )
           values (
             'google_sheet_row', $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb
           )`,
          [
            `${sheetId}:${gid}:grant-platform:${"f".repeat(64)}`,
            tabUrl,
            checksum(sheetRecord(322, "Submitted").rawPayload),
            "Duplicate",
            "Duplicate",
            JSON.stringify(sheetRecord(322, "Submitted").rawPayload),
            JSON.stringify({
              sheetId,
              tabName: "all_grants_tracking",
              gid,
              rowNumber: 999,
              identityStrategy: "grant_platform_link"
            })
          ]
        ),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "23505"
      );

      await client.query(
        "select set_config('zcg.sync_run_id', $1, false)",
        [removedSyncRunId]
      );
      await client.query(
        "delete from source_records where id = $1",
        [legacySourceRecordId]
      );

      const lifecycle = await client.query<{
        version_number: number;
        observation_type: string;
        checksum_sha256: string | null;
        sync_run_id: string | null;
        row_number: string | null;
      }>(
        `select version_number,
                observation_type,
                checksum_sha256,
                sync_run_id::text,
                metadata->>'rowNumber' as row_number
           from source_record_observations
          where source_record_id = $1
          order by version_number`,
        [legacySourceRecordId]
      );
      assert.deepEqual(
        lifecycle.rows.map((row) => ({
          version: row.version_number,
          type: row.observation_type,
          syncRunId: row.sync_run_id,
          rowNumber: row.row_number
        })),
        [
          { version: 1, type: "present", syncRunId: initialSyncRunId, rowNumber: "322" },
          { version: 2, type: "present", syncRunId: initialSyncRunId, rowNumber: "322" },
          { version: 3, type: "present", syncRunId: changedSyncRunId, rowNumber: "400" },
          { version: 4, type: "present", syncRunId: revertedSyncRunId, rowNumber: "322" },
          { version: 5, type: "tombstone", syncRunId: removedSyncRunId, rowNumber: "322" }
        ]
      );
      assert.equal(lifecycle.rows[1].checksum_sha256, lifecycle.rows[3].checksum_sha256);
      assert.notEqual(lifecycle.rows[2].checksum_sha256, lifecycle.rows[3].checksum_sha256);

      const retained = await client.query<{
        current_count: number;
        link_count: number;
        observation_count: number;
      }>(
        `select
           (select count(*)::int from source_records where id = $1) as current_count,
           (select count(*)::int from source_links where source_record_id = $1) as link_count,
           (
             select count(*)::int
               from source_record_observations
              where source_record_id = $1
           ) as observation_count`,
        [legacySourceRecordId]
      );
      assert.deepEqual(retained.rows[0], {
        current_count: 0,
        link_count: 0,
        observation_count: 5
      });

      await assert.rejects(
        client.query(
          `update source_record_observations
              set summary = 'mutated'
            where source_record_id = $1
              and version_number = 1`,
          [legacySourceRecordId]
        ),
        /source_record_observations is append-only/
      );
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.query("set search_path to public").catch(() => undefined);
      await client.query(`drop schema if exists ${quotedSchema} cascade`).catch(() => undefined);
      await client.end();
    }
  }
);
