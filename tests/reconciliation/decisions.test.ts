import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { pool } from "../../lib/db";
import {
  createReconciliationDecision,
  reconciliationDecisionKey,
  type ReconciliationDecisionType
} from "../../lib/reconciliation/decisions";

type PortableDecision = {
  decision_key: string;
  decision_type: ReconciliationDecisionType;
  status: string;
  source_kind: string | null;
  source_id: string | null;
  canonical_type: string;
  canonical_key: string | null;
  related_canonical_key: string | null;
  relationship_type: string | null;
  field_name: string | null;
  field_value: unknown;
  rationale: string;
  confidence: string;
  evidence: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

function queryResult(rows: unknown[] = [], rowCount = rows.length) {
  return {
    command: "",
    oid: 0,
    fields: [],
    rowCount,
    rows
  };
}

async function migratedPortableDecisions() {
  const portable = JSON.parse(
    await fs.readFile("data/reconciliation-decisions.json", "utf8")
  ) as { decisions: PortableDecision[] };

  return portable.decisions.filter(
    (decision) =>
      decision.source_kind === "google_sheet_row" &&
      decision.evidence?.stableIdentityMigration === "grant_platform_link_v1"
  );
}

function keyForPortableDecision(decision: PortableDecision) {
  return reconciliationDecisionKey({
    decisionType: decision.decision_type,
    sourceKind: decision.source_kind,
    sourceId: decision.source_id,
    canonicalType: decision.canonical_type,
    canonicalKey: decision.canonical_key,
    relatedCanonicalKey: decision.related_canonical_key,
    relationshipType: decision.relationship_type,
    fieldName: decision.field_name,
    fieldValue: decision.field_value,
    reconciliationIssueId: null
  });
}

test("portable stable-Sheet decisions use the exact save-path decision key", async () => {
  const decisions = await migratedPortableDecisions();

  assert.equal(decisions.length, 3);
  for (const decision of decisions) {
    assert.equal(decision.decision_key, keyForPortableDecision(decision));
  }
});

test("re-saving a migrated stable-Sheet decision updates its existing key instead of creating a duplicate", async (t) => {
  const decision = (await migratedPortableDecisions())[0];
  assert.ok(decision);

  const previousDatabaseDriver = process.env.DATABASE_DRIVER;
  delete process.env.DATABASE_DRIVER;
  t.after(() => {
    if (previousDatabaseDriver === undefined) {
      delete process.env.DATABASE_DRIVER;
    } else {
      process.env.DATABASE_DRIVER = previousDatabaseDriver;
    }
  });

  const storedDecisions = new Map<string, PortableDecision>([
    [decision.decision_key, decision]
  ]);
  let auditAction: string | null = null;
  let savedKey: string | null = null;

  t.mock.method(pool, "query", async (text: string, values: readonly unknown[] = []) => {
    if (/from reconciliation_decisions\s+where decision_key = \$1/.test(text)) {
      const existing = storedDecisions.get(String(values[0]));
      return queryResult(existing ? [existing] : []);
    }

    if (text.includes("insert into reconciliation_decisions (")) {
      savedKey = String(values[0]);
      storedDecisions.set(savedKey, {
        ...decision,
        decision_key: savedKey,
        decision_type: values[1] as ReconciliationDecisionType,
        source_kind: values[2] as string | null,
        source_id: values[3] as string | null,
        canonical_type: String(values[4]),
        canonical_key: values[5] as string | null,
        related_canonical_key: values[6] as string | null,
        relationship_type: values[7] as string | null,
        field_name: values[8] as string | null
      });
      return queryResult([{ id: "00000000-0000-4000-8000-000000000001" }], 1);
    }

    if (text.includes("affected_count")) {
      return queryResult([{ affected_count: "0" }], 1);
    }

    if (text.includes("insert into audit_events")) {
      auditAction = String(values[1]);
      return queryResult([{ id: "00000000-0000-4000-8000-000000000002" }], 1);
    }

    throw new Error(`Unexpected reconciliation decision query: ${text}`);
  });

  const result = await createReconciliationDecision(
    {
      decisionType: decision.decision_type,
      sourceKind: decision.source_kind,
      sourceId: decision.source_id,
      canonicalType: decision.canonical_type,
      canonicalKey: decision.canonical_key,
      relatedCanonicalKey: decision.related_canonical_key,
      relationshipType: decision.relationship_type,
      fieldName: decision.field_name,
      fieldValue: decision.field_value,
      rationale: decision.rationale,
      confidence: Number(decision.confidence),
      evidence: decision.evidence
    },
    "00000000-0000-4000-8000-000000000003"
  );

  assert.equal(result.decisionKey, decision.decision_key);
  assert.equal(savedKey, decision.decision_key);
  assert.equal(storedDecisions.size, 1);
  assert.equal(auditAction, "reconciliation.decision.updated");
});
