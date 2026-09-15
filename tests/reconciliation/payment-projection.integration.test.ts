import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { milestoneProjectionTestHooks as hooks } from "../../lib/reconciliation/milestones";

const databaseUrl = process.env.ZCG_TEST_DATABASE_URL;

test("PostgreSQL reassigns ledger ownership and recomputes both complete schedules", {
  skip: databaseUrl ? false : "set ZCG_TEST_DATABASE_URL for isolated PostgreSQL validation",
  timeout: 60000
}, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const schema = `zcg_payment_${randomUUID().replaceAll("-", "")}`;
  const oldId = randomUUID();
  const newId = randomUUID();
  const sourceA = randomUUID();
  const sourceB = randomUUID();
  try {
    await client.query(`create schema "${schema}"`);
    await client.query(`set search_path to "${schema}", public`);
    for (const file of ["0001_phase0_foundation.sql", "0002_phase1_source_mirroring.sql",
      "0003_phase2_canonical_reconciliation.sql", "0008_manual_reconciliation_decisions.sql",
      "0018_grant_milestone_disbursements.sql"]) {
      // PostgreSQL 16 supplies gen_random_uuid itself. Avoid racing another
      // schema-isolated test over the database-global extension catalog.
      const sql = (await fs.readFile(`migrations/${file}`, "utf8"))
        .replace("create extension if not exists pgcrypto;", "");
      await client.query(sql);
    }
    for (const id of [oldId, newId]) {
      await client.query("insert into grant_applications(id, canonical_key, title, normalized_status, requested_amount_usd) values ($1::uuid,$1::text,'Example grant','approved',24000)", [id]);
      await client.query("insert into grants(application_id,title,status) values ($1,'Example grant','approved')", [id]);
    }
    for (const [id, owner, amount] of [[sourceA, oldId, 3000], [sourceB, newId, 6000]]) {
      await client.query(`insert into source_records(id,source_kind,source_id,raw_payload,metadata)
        values ($1::uuid,'google_sheet_row',$1::text,$2::jsonb,'{"tabName":"milestone_details"}'::jsonb)`,
      [id, JSON.stringify({Project: "Example grant", Milestone: "1", "Amount (USD)": amount, "ZEC Disbursed": "10"})]);
      await client.query("insert into source_links(source_record_id, canonical_type, canonical_id, confidence) values ($1,'grant_application',$2,1)", [id, owner]);
    }
    const sync = hooks.createSyncGrantMilestoneProjections((sql, values = []) => client.query(sql, [...values]));
    await sync();
    const idsBefore = await client.query("select id::text,source_record_id::text from grant_milestones order by source_record_id");
    assert.equal((await client.query("select approved_amount_usd::text as amount from grants where application_id=$1", [oldId])).rows[0].amount, "3000.00");
    await client.query("delete from source_links where canonical_id=$1", [oldId]);
    await client.query("insert into source_links(source_record_id,canonical_type,canonical_id,confidence) values ($1,'grant_application',$2,1)", [sourceA, newId]);
    const result = await sync({ applicationIds: [oldId] });
    assert.deepEqual(new Set(result.affectedApplicationIds), new Set([oldId, newId]));
    const grants = await client.query("select application_id::text,approved_amount_usd::text from grants");
    assert.equal(grants.rows.find(r => r.application_id === oldId).approved_amount_usd, null);
    assert.equal(grants.rows.find(r => r.application_id === newId).approved_amount_usd, "9000.00");
    assert.deepEqual((await client.query("select id::text,source_record_id::text from grant_milestones order by source_record_id")).rows, idsBefore.rows);
    assert.equal((await client.query("select count(*)::int as n from grant_milestones where application_id=$1", [newId])).rows[0].n, 2);
    assert.equal((await client.query("select count(*)::int as n from grant_disbursements where application_id=$1 and usd_amount is null", [newId])).rows[0].n, 2);
    assert.equal((await client.query("select requested_amount_usd::text from grant_applications where id=$1", [newId])).rows[0].requested_amount_usd, "24000.00");
    assert.equal((await client.query("select count(*)::int as n from source_records")).rows[0].n, 2);
    // Removing a competing link must resolve ambiguity even when no previous
    // milestone projection exists to remember the shared source.
    await client.query("insert into source_links(source_record_id,canonical_type,canonical_id,confidence) values ($1,'grant_application',$2,1)", [sourceA, oldId]);
    assert.equal((await sync({ applicationIds: [oldId] })).ambiguousSourceLinks, 1);
    const priorScope = await hooks.connectedApplicationScope([oldId], (sql, values = []) => client.query(sql, [...values]));
    await client.query("delete from source_links where canonical_id=$1", [oldId]);
    assert.equal((await sync({ applicationIds: priorScope })).ambiguousSourceLinks, 0);
    assert.equal((await client.query("select approved_amount_usd::text as amount from grants where application_id=$1", [newId])).rows[0].amount, "9000.00");
    assert.equal((await client.query("select count(*)::int as n from reconciliation_issues where status='open'")).rows[0].n, 0);
  } finally {
    await client.query(`drop schema if exists "${schema}" cascade`);
    await client.end();
  }
});
