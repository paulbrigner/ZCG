import assert from "node:assert/strict";
import test from "node:test";
import {
  ReconciliationBusyError,
  grantReconciliationTestHooks as hooks
} from "../../lib/reconciliation/grants";

type LeaseRunner = (
  text: string,
  values?: readonly unknown[]
) => Promise<{
  rowCount: number | null;
  rows: Array<Record<string, unknown>>;
}>;

type QueryRecord = {
  text: string;
  values: readonly unknown[];
};

const ownerId = "00000000-0000-4000-8000-000000000001";

test("acquires an expired reconciliation lease and releases only its owner", async () => {
  const queries: QueryRecord[] = [];
  const runQuery: LeaseRunner = async (text, values = []) => {
    queries.push({ text, values });

    if (text.includes("insert into idempotency_keys")) {
      return {
        rowCount: 1,
        rows: [{ locked_until: new Date("2026-07-14T12:30:00.000Z") }]
      };
    }

    if (text.includes("update idempotency_keys")) {
      return { rowCount: 1, rows: [{ key: hooks.grantReconciliationLeaseKey }] };
    }

    throw new Error(`Unexpected query: ${text}`);
  };

  let workCalls = 0;
  const result = await hooks.withGrantReconciliationLease(
    async () => {
      workCalls += 1;
      return "done";
    },
    { ownerId, runQuery }
  );

  assert.equal(result, "done");
  assert.equal(workCalls, 1);
  assert.equal(queries.length, 2);
  assert.match(queries[0].text, /on conflict \(key\) do update/);
  assert.match(queries[0].text, /locked_until <= now\(\)/);
  assert.deepEqual(queries[0].values, [
    hooks.grantReconciliationLeaseKey,
    hooks.grantReconciliationLeaseScope,
    hooks.grantReconciliationLeaseMinutes,
    ownerId
  ]);
  assert.match(queries[1].text, /result->>'ownerId' = \$2::text/);
  assert.deepEqual(queries[1].values, [
    hooks.grantReconciliationLeaseKey,
    ownerId,
    "completed"
  ]);
});

test("rejects a concurrent reconciliation without running destructive work", async () => {
  const queries: QueryRecord[] = [];
  const lockedUntil = "2026-07-14T12:30:00.000Z";
  const runQuery: LeaseRunner = async (text, values = []) => {
    queries.push({ text, values });

    if (text.includes("insert into idempotency_keys")) {
      return { rowCount: 0, rows: [] };
    }

    if (text.includes("select locked_until")) {
      return { rowCount: 1, rows: [{ locked_until: lockedUntil }] };
    }

    throw new Error(`Unexpected query: ${text}`);
  };

  let workCalls = 0;
  await assert.rejects(
    hooks.withGrantReconciliationLease(
      async () => {
        workCalls += 1;
      },
      { ownerId, runQuery }
    ),
    (error: unknown) => {
      assert.equal(error instanceof ReconciliationBusyError, true);
      assert.equal((error as ReconciliationBusyError).busy, true);
      assert.equal((error as ReconciliationBusyError).lockedUntil, lockedUntil);
      return true;
    }
  );

  assert.equal(workCalls, 0);
  assert.equal(queries.length, 2);
  assert.equal(queries.some(({ text }) => text.includes("update idempotency_keys")), false);
});

test("releases the owner lease as failed while preserving the work error", async () => {
  const queries: QueryRecord[] = [];
  const runQuery: LeaseRunner = async (text, values = []) => {
    queries.push({ text, values });

    if (text.includes("insert into idempotency_keys")) {
      return { rowCount: 1, rows: [{ locked_until: "2026-07-14T12:30:00.000Z" }] };
    }

    if (text.includes("update idempotency_keys")) {
      return { rowCount: 1, rows: [{ key: hooks.grantReconciliationLeaseKey }] };
    }

    throw new Error(`Unexpected query: ${text}`);
  };
  const failure = new Error("reconciliation failed");

  await assert.rejects(
    hooks.withGrantReconciliationLease(
      async () => {
        throw failure;
      },
      { ownerId, runQuery }
    ),
    (error: unknown) => error === failure
  );

  assert.deepEqual(queries.at(-1)?.values, [
    hooks.grantReconciliationLeaseKey,
    ownerId,
    "failed"
  ]);
});
