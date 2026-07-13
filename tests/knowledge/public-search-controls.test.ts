import assert from "node:assert/strict";
import test from "node:test";
import {
  consumePublicSemanticSearchAllowance,
  getPublicKnowledgeSearchControlStatus,
  getPublicKnowledgeSearchTelemetry,
  publicKnowledgeSearchClientHash,
  publicSearchControlTestHooks,
  recordPublicKnowledgeSearchTelemetry,
  type PublicSearchQueryExecutor
} from "../../lib/knowledge/public-search-controls";

test("hashes the public client address without retaining the raw address", () => {
  const firstHeaders = new Headers({ "x-forwarded-for": "10.0.0.2, 203.0.113.9" });
  const sameHeaders = new Headers({ "x-forwarded-for": "203.0.113.9" });
  const otherHeaders = new Headers({ "x-forwarded-for": "203.0.113.10" });
  const first = publicKnowledgeSearchClientHash(firstHeaders, "test-secret");

  assert.equal(first, publicKnowledgeSearchClientHash(sameHeaders, "test-secret"));
  assert.notEqual(first, publicKnowledgeSearchClientHash(otherHeaders, "test-secret"));
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(first, /203\.0\.113\.9/);
});

test("uses proxy client-address headers in a stable order", () => {
  assert.equal(
    publicSearchControlTestHooks.publicClientAddress(new Headers({
      "x-forwarded-for": "198.51.100.5, 10.0.0.1",
      "cf-connecting-ip": "198.51.100.6",
      "x-real-ip": "198.51.100.7"
    })),
    "10.0.0.1"
  );
  assert.equal(
    publicSearchControlTestHooks.publicClientAddress(new Headers({ "cf-connecting-ip": "198.51.100.6" })),
    "198.51.100.6"
  );
  assert.equal(publicSearchControlTestHooks.publicClientAddress(new Headers()), "unknown");
});

test("consumes client-minute and UTC-day allowance in one atomic query", { concurrency: false }, async () => {
  const previousClientLimit = process.env.ZCG_PUBLIC_SEMANTIC_PER_CLIENT_PER_MINUTE;
  const previousDailyLimit = process.env.ZCG_PUBLIC_SEMANTIC_DAILY_LIMIT;
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const queryExecutor: PublicSearchQueryExecutor = async (sql, values = []) => {
    calls.push({ sql, values });
    return {
      rows: [{ client_allowed: true, global_allowed: true }],
      rowCount: 1
    };
  };

  try {
    process.env.ZCG_PUBLIC_SEMANTIC_PER_CLIENT_PER_MINUTE = "7";
    process.env.ZCG_PUBLIC_SEMANTIC_DAILY_LIMIT = "321";
    const allowance = await consumePublicSemanticSearchAllowance({
      clientHash: "hashed-client",
      now: new Date("2026-07-13T14:27:42.987Z"),
      queryExecutor
    });

    assert.deepEqual(allowance, { allowed: true, reason: null });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /client_allowance/);
    assert.match(calls[0].sql, /global_allowance/);
    assert.match(calls[0].sql, /request_count < \$3::integer/);
    assert.match(calls[0].sql, /request_count < \$5::integer/);
    assert.deepEqual(calls[0].values, [
      "hashed-client",
      "2026-07-13T14:27:00.000Z",
      7,
      "2026-07-13T00:00:00.000Z",
      321
    ]);
  } finally {
    if (previousClientLimit === undefined) {
      delete process.env.ZCG_PUBLIC_SEMANTIC_PER_CLIENT_PER_MINUTE;
    } else {
      process.env.ZCG_PUBLIC_SEMANTIC_PER_CLIENT_PER_MINUTE = previousClientLimit;
    }

    if (previousDailyLimit === undefined) {
      delete process.env.ZCG_PUBLIC_SEMANTIC_DAILY_LIMIT;
    } else {
      process.env.ZCG_PUBLIC_SEMANTIC_DAILY_LIMIT = previousDailyLimit;
    }
  }
});

test("distinguishes client and global limit exhaustion", () => {
  assert.deepEqual(
    publicSearchControlTestHooks.allowanceFromRow({ client_allowed: false, global_allowed: false }),
    { allowed: false, reason: "client" }
  );
  assert.deepEqual(
    publicSearchControlTestHooks.allowanceFromRow({ client_allowed: true, global_allowed: false }),
    { allowed: false, reason: "global" }
  );
});

test("records only aggregate anonymous-search dimensions", async () => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const queryExecutor: PublicSearchQueryExecutor = async (sql, values = []) => {
    calls.push({ sql, values });
    return { rows: [], rowCount: 1 };
  };

  await recordPublicKnowledgeSearchTelemetry({
    requestedMode: "hybrid",
    servedMode: "keyword",
    outcome: "rate_limited_fallback",
    queryExecutor
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, ["hybrid", "keyword", "rate_limited_fallback"]);
  assert.doesNotMatch(calls[0].sql, /query_text|client_hash|scope_key/i);
});

test("maps aggregate telemetry and current public quota status", { concurrency: false }, async () => {
  const previousClientLimit = process.env.ZCG_PUBLIC_SEMANTIC_PER_CLIENT_PER_MINUTE;
  const previousDailyLimit = process.env.ZCG_PUBLIC_SEMANTIC_DAILY_LIMIT;
  const telemetryExecutor: PublicSearchQueryExecutor = async () => ({
    rows: [{
      usage_date: "2026-07-13",
      requested_mode: "semantic",
      served_mode: "semantic",
      outcome: "served",
      request_count: "4",
      last_seen_at: "2026-07-13T15:00:00.000Z"
    }],
    rowCount: 1
  });
  const statusExecutor: PublicSearchQueryExecutor = async () => ({
    rows: [{ request_count: "12" }],
    rowCount: 1
  });

  try {
    process.env.ZCG_PUBLIC_SEMANTIC_PER_CLIENT_PER_MINUTE = "8";
    process.env.ZCG_PUBLIC_SEMANTIC_DAILY_LIMIT = "700";
    assert.deepEqual(await getPublicKnowledgeSearchTelemetry({ queryExecutor: telemetryExecutor }), [{
      usageDate: "2026-07-13",
      requestedMode: "semantic",
      servedMode: "semantic",
      outcome: "served",
      requestCount: 4,
      lastSeenAt: "2026-07-13T15:00:00.000Z"
    }]);
    assert.deepEqual(await getPublicKnowledgeSearchControlStatus({ queryExecutor: statusExecutor }), {
      perClientMinuteLimit: 8,
      dailyLimit: 700,
      dailySemanticRequests: 12
    });
  } finally {
    if (previousClientLimit === undefined) {
      delete process.env.ZCG_PUBLIC_SEMANTIC_PER_CLIENT_PER_MINUTE;
    } else {
      process.env.ZCG_PUBLIC_SEMANTIC_PER_CLIENT_PER_MINUTE = previousClientLimit;
    }

    if (previousDailyLimit === undefined) {
      delete process.env.ZCG_PUBLIC_SEMANTIC_DAILY_LIMIT;
    } else {
      process.env.ZCG_PUBLIC_SEMANTIC_DAILY_LIMIT = previousDailyLimit;
    }
  }
});
