import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { pool } from "../../lib/db";
import { decisionMinutesTestHooks as hooks } from "../../lib/reconciliation/decision-minutes";

const databaseUrl = process.env.ZCG_TEST_DATABASE_URL;
test("retires obsolete derived ownership and retracts superseded assertions without deleting history", {
  skip: databaseUrl ? false : "set ZCG_TEST_DATABASE_URL for isolated PostgreSQL checks", timeout: 60000
}, async t => {
  const client = new pg.Client({ connectionString: databaseUrl });
  const schema = `minutes_${randomUUID().replaceAll("-", "")}`;
  await client.connect();
  try {
    await client.query(`create schema "${schema}"`);
    await client.query(`set search_path to "${schema}", public`);
    for (const file of ["0001_phase0_foundation.sql", "0002_phase1_source_mirroring.sql", "0003_phase2_canonical_reconciliation.sql", "0008_manual_reconciliation_decisions.sql", "0009_source_link_relationship_roles.sql", "0012_grant_decision_minutes.sql", "0017_grant_application_status_history.sql"]) {
      await client.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
    }
    t.mock.method(pool, "query", (text: string, values: unknown[]) => client.query(text, values));
    const oldApp = randomUUID(), currentApp = randomUUID(), manualApp = randomUUID(), source = randomUUID(), ds = randomUUID(), mention = randomUUID();
    for (const id of [oldApp, currentApp, manualApp]) await client.query("insert into grant_applications(id,canonical_key,title,normalized_status) values($1::uuid,$1::text,'Example','approved')", [id]);
    await client.query("insert into source_records(id,source_kind,source_id,raw_payload) values($1,'forum_meeting_minutes','meeting-source','{}')", [source]);
    for (const id of [oldApp, currentApp, manualApp]) await client.query("insert into source_links(source_record_id,canonical_type,canonical_id,relationship_role) values($1,'grant_application',$2,'decision_minutes')", [source, id]);
    await client.query("insert into reconciliation_decisions(decision_key,decision_type,source_kind,source_id,canonical_key,rationale) values('manual','link_source','forum_meeting_minutes','meeting-source',$1,'Explicit whole-source link')", [manualApp]);
    await client.query("insert into grant_decision_sources(id,source_record_id,topic_url,title,meeting_date,parser_version,content_hash) values($1,$2,'url','meeting','2023-01-23','v4','hash')", [ds, source]);
    await client.query("insert into grant_decision_mentions(id,mention_key,decision_source_id,application_id,candidate_title,normalized_decision,review_status,content_hash,metadata) values($1,'mention',$2,$3,'Example','approved','accepted','new-hash','{\"decisionDate\":\"2023-01-25\"}')", [mention, ds, currentApp]);
    const events: string[] = [];
    for (const [app, date, basis, mentionId] of [
      [oldApp, "2023-01-25", "accepted_decision_minutes", mention],
      [currentApp, "2023-01-23", "accepted_decision_minutes", mention],
      [currentApp, "2023-01-25", "accepted_decision_minutes", mention],
      [currentApp, "2023-01-23", "registry", mention],
      [currentApp, "2023-01-25", "accepted_decision_minutes", randomUUID()]
    ]) {
      const id = randomUUID(); events.push(id);
      await client.query(`insert into grant_application_status_events(id,application_id,application_canonical_key,event_type,to_status,provenance,effective_date,evidence_locator,evidence_fingerprint,idempotency_key,evidence)
        values($1::uuid,$2::uuid,$2::text,'historical_assertion','approved','exact',$3,'locator','hash',$1::text,jsonb_build_object('basis',$4::text,'mentionId',$5::text))`, [id, app, date, basis, mentionId]);
    }
    await hooks.retireObsoleteMinuteEvidence();
    assert.deepEqual((await client.query("select canonical_id::text from source_links order by canonical_id")).rows.map(r => r.canonical_id).sort(), [currentApp, manualApp].sort());
    const retractions = (await client.query("select corrects_event_id::text from grant_application_status_events where event_type='retraction'")).rows.map(r => r.corrects_event_id).sort();
    assert.deepEqual(retractions, [events[0], events[1], events[4]].sort());
    assert.equal((await client.query("select count(*)::int as n from grant_application_status_events where event_type='historical_assertion'")).rows[0].n, 5);
    await hooks.retireObsoleteMinuteEvidence();
    assert.equal((await client.query("select count(*)::int as n from grant_application_status_events")).rows[0].n, 8);
    assert.equal((await client.query("select count(*)::int as n from source_records")).rows[0].n, 1);
    assert.equal((await client.query("select count(*)::int as n from grant_applications where normalized_status='approved'")).rows[0].n, 3);
  } finally {
    t.mock.restoreAll();
    await client.query(`drop schema "${schema}" cascade`);
    await client.end();
  }
});
