import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import {
  corpusEventWorkerTestHooks,
  createCorpusEventHandler,
  type CorpusEventWorkerDependencies,
  type SqsRecord
} from "../../workers/corpus-event-worker";
import type { CorpusWebhookMessage } from "../../workers/webhook-ingress-worker";
import { GitHubPullRequestTargetError } from "../../lib/source-mirroring/github";

const now = "2026-07-15T14:00:00.000Z";
const appExisting = "11111111-1111-4111-8111-111111111111";
const appTargeted = "22222222-2222-4222-8222-222222222222";
const appForum = "33333333-3333-4333-8333-333333333333";
const forumUrl = "https://forum.zcashcommunity.com/t/example-topic/555";

type Query = { text: string; values: readonly unknown[] };

class FakeClient {
  queries: Query[] = [];
  leaseActive = false;
  githubApplicationIds = [appExisting];
  forumContexts: Array<Array<{ url: string | null; application_id: string | null }>> = [];
  mirroredForumUrls: string[] = [];
  idempotency = new Map<string, Record<string, unknown>>();
  ended = false;
  syncRunCount = 0;

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<pg.QueryResult<T>> {
    this.queries.push({ text, values });

    if (text.includes("locked_until > now()") && text.includes("idempotency_keys")) {
      return this.result(this.leaseActive
        ? [{ locked_until: "2026-07-15T15:00:00.000Z", result: { owner: "full-refresh" } }]
        : []);
    }

    if (text.startsWith("insert into idempotency_keys")) {
      const key = String(values[0]);

      if (key === "corpus-refresh:pipeline:v1") {
        if (this.leaseActive) {
          this.idempotency.set(key, {
            owner: "full-refresh",
            ownerKind: "full_refresh"
          });
          return this.result([]);
        }

        const payload = JSON.parse(String(values[3])) as Record<string, unknown>;
        this.idempotency.set(key, payload);
        return this.result([{
          locked_until: "2026-07-15T14:30:00.000Z",
          result: payload
        }]);
      }

      const existing = this.idempotency.get(key);

      if (existing?.status === "completed" || existing?.status === "processing") {
        return this.result([]);
      }

      const payload = JSON.parse(String(values[3])) as Record<string, unknown>;
      this.idempotency.set(key, payload);
      return this.result([{ result: payload }]);
    }

    if (text.includes("select result") && text.includes("idempotency_keys")) {
      const existing = this.idempotency.get(String(values[0]));
      return this.result(existing ? [{ result: existing }] : []);
    }

    if (text.includes("result->>'ownerKind' as owner_kind")) {
      const existing = this.idempotency.get(String(values[0]));
      return this.result(existing
        ? [{
            locked_until: "2026-07-15T15:00:00.000Z",
            owner_kind: existing.ownerKind ?? null
          }]
        : []);
    }

    if (text.startsWith("update idempotency_keys")) {
      const key = String(values[0]);
      const payload = JSON.parse(String(values[2])) as Record<string, unknown>;
      this.idempotency.set(key, payload);
      return this.result([], 1);
    }

    if (text.startsWith("insert into sync_runs")) {
      this.syncRunCount += 1;
      return this.result([{ id: `sync-${this.syncRunCount}` }]);
    }

    if (text.includes("sr.source_kind = 'github_issue'") && text.includes("application_id")) {
      return this.result(this.githubApplicationIds.map((application_id) => ({ application_id })));
    }

    if (text.includes("metadata->>'mirrorKind'") && text.includes("source_id = any")) {
      return this.result(this.mirroredForumUrls.map((source_id) => ({ source_id })));
    }

    if (text.includes("from discourse_topics dt") && text.includes("union")) {
      return this.result(this.forumContexts.shift() ?? []);
    }

    if (text.startsWith("delete from source_records")) {
      return this.result([], 1);
    }

    if (text.startsWith("delete from idempotency_keys")) {
      this.idempotency.delete(String(values[0]));
      return this.result([], 1);
    }

    return this.result([]);
  }

  async end() {
    this.ended = true;
  }

  private result<T extends pg.QueryResultRow>(
    rows: pg.QueryResultRow[],
    rowCount = rows.length
  ): pg.QueryResult<T> {
    return {
      command: "",
      rowCount,
      oid: 0,
      fields: [],
      rows: rows as T[]
    };
  }
}

function githubMessage(
  deliveryId: string,
  eventType: string,
  options: { repository?: string; isPullRequest?: boolean } = {}
): CorpusWebhookMessage {
  return {
    schemaVersion: 1,
    provider: "github",
    deliveryId,
    eventType,
    action: "edited",
    source: {
      repository: options.repository ?? "ZcashCommunityGrants/zcashcommunitygrants",
      issueNumber: 351,
      ...(eventType === "issue_comment" ? { commentId: 991 } : {}),
      ...(options.isPullRequest ? { isPullRequest: true } : {})
    },
    receivedAt: now
  };
}

function discourseMessage(deliveryId: string): CorpusWebhookMessage {
  return {
    schemaVersion: 1,
    provider: "discourse",
    deliveryId,
    eventType: "post",
    action: "post_edited",
    source: { topicId: 555, postId: 991 },
    receivedAt: now
  };
}

function driveMessage(deliveryId: string): CorpusWebhookMessage {
  return {
    schemaVersion: 1,
    provider: "google-drive",
    deliveryId,
    eventType: "drive-notification",
    action: "update",
    source: {
      channelId: "zcg-sheet-channel",
      resourceId: "resource-1",
      fileId: "sheet-file"
    },
    receivedAt: now
  };
}

function sqsRecord(messageId: string, message: CorpusWebhookMessage | string): SqsRecord {
  return {
    messageId,
    body: typeof message === "string" ? message : JSON.stringify(message)
  };
}

function targetedGitHubResult() {
  const issueSourceId = "ZcashCommunityGrants/zcashcommunitygrants#351";

  return {
    sourceKind: "github_issue_target",
    sourceId: issueSourceId,
    sourceUrl: "https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues/351",
    rawPayload: { status: "found" },
    records: [
      {
        sourceKind: "github_issue",
        sourceId: issueSourceId,
        rawPayload: { number: 351 }
      },
      {
        sourceKind: "github_issue_comment",
        sourceId: `${issueSourceId}:comment:991`,
        rawPayload: { id: 991 }
      }
    ],
    target: { sourceKind: "github_issue", sourceId: issueSourceId, status: "found" as const },
    authoritativeScopes: [
      {
        sourceKind: "github_issue_comment",
        sourceIdPrefix: `${issueSourceId}:comment:`,
        currentSourceIds: [`${issueSourceId}:comment:991`]
      }
    ],
    tombstones: []
  };
}

function forumMirrorResult() {
  return {
    sourceKind: "forum_topics",
    sourceId: "forum.zcashcommunity.com",
    sourceUrl: "https://forum.zcashcommunity.com",
    rawPayload: {
      topicCountUnavailable: 0,
      topicErrorCount: 0,
      rateLimitedAt: null
    },
    records: [
      {
        sourceKind: "forum_link",
        sourceId: forumUrl,
        sourceUrl: forumUrl,
        rawPayload: { topic: { id: 555 } }
      }
    ]
  };
}

function stored(recordsSeen: number) {
  return {
    counts: {
      recordsSeen,
      recordsCreated: recordsSeen,
      recordsUpdated: 0,
      recordsSkipped: 0
    },
    snapshotKey: `snapshot-${recordsSeen}.json`,
    normalizedForum: {
      recordsSeen,
      recordsEligible: recordsSeen,
      topicsUpserted: recordsSeen ? 1 : 0,
      completeTopics: recordsSeen ? 1 : 0,
      postsUpserted: recordsSeen,
      postsMarkedDeleted: 0,
      referencesUpserted: recordsSeen
    }
  };
}

function testHandler(
  client: FakeClient,
  overrides: Partial<CorpusEventWorkerDependencies> = {}
) {
  let ownerCount = 0;
  return createCorpusEventHandler({
    connect: async () => client as unknown as pg.Client,
    now: () => new Date(now),
    randomId: () => `owner-${++ownerCount}`,
    logError: () => undefined,
    ...overrides
  });
}

test("coalesces GitHub issue events into one targeted reconciliation and scoped index refresh", async () => {
  const client = new FakeClient();
  const githubCalls: number[] = [];
  const forumCalls: string[][] = [];
  const storedKinds: string[] = [];
  const indexedApplications: string[][] = [];
  const handler = testHandler(client, {
    mirrorGitHubIssue: async (issueNumber) => {
      githubCalls.push(issueNumber);
      return targetedGitHubResult();
    },
    runTargetedGitHubReconciliation: async ({ githubSourceId, syncRunId }) => {
      assert.equal(githubSourceId, "ZcashCommunityGrants/zcashcommunitygrants#351");
      assert.equal(syncRunId, "sync-1");
      return {
        ok: true,
        requiresFullReconciliation: false,
        githubSourceId,
        applicationIds: [appTargeted],
        discoveredForumUrls: [forumUrl]
      };
    },
    mirrorForumTopics: async (config = {}) => {
      forumCalls.push(config.urls ?? []);
      return forumMirrorResult();
    },
    storeMirrorResult: async (_client, _syncRunId, result) => {
      storedKinds.push(result.sourceKind);
      return stored(result.records.length);
    },
    refreshGrantKnowledgeDocuments: async ({ applicationIds } = {}) => {
      indexedApplications.push([...(applicationIds ?? [])]);
      return {
        ok: true,
        applicationsSeen: applicationIds?.length ?? 0,
        documentsIndexed: 1,
        staleDocumentsRemoved: 0
      };
    }
  });

  const response = await handler({
    Records: [
      sqsRecord("message-1", githubMessage("delivery-1", "issues")),
      sqsRecord("message-2", githubMessage("delivery-2", "issue_comment"))
    ]
  });

  assert.deepEqual(response, { batchItemFailures: [] });
  assert.deepEqual(githubCalls, [351]);
  assert.deepEqual(forumCalls, [[forumUrl]]);
  assert.deepEqual(storedKinds, ["github_issue_target", "forum_topics"]);
  assert.deepEqual(indexedApplications, [[appExisting, appTargeted]]);
  assert.equal(client.syncRunCount, 1);
  assert.equal(client.ended, true);
  assert.equal(
    client.queries.some((query) =>
      query.text.startsWith("delete from source_records") &&
      query.text.includes("not (source_id = any")
    ),
    true
  );
  assert.equal(
    [...client.idempotency.values()].every((value) => value.status === "completed"),
    true
  );
  assert.equal(client.idempotency.has("corpus-refresh:pipeline:v1"), false);
});

test("defers every coalesced message while the full corpus refresh lease is active", async () => {
  const client = new FakeClient();
  client.leaseActive = true;
  let mirrorCalls = 0;
  const handler = testHandler(client, {
    mirrorGitHubIssue: async () => {
      mirrorCalls += 1;
      return targetedGitHubResult();
    }
  });

  const response = await handler({
    Records: [
      sqsRecord("message-1", githubMessage("delivery-1", "issues")),
      sqsRecord("message-2", githubMessage("delivery-2", "issue_comment"))
    ]
  });

  assert.deepEqual(response.batchItemFailures, [
    { itemIdentifier: "message-1" },
    { itemIdentifier: "message-2" }
  ]);
  assert.equal(mirrorCalls, 0);
  assert.equal(client.syncRunCount, 0);
  assert.equal(
    client.queries.some((query) =>
      query.text.startsWith("insert into idempotency_keys") &&
      String(query.values[0]).startsWith("corpus-webhook:")
    ),
    false
  );
});

test("the corpus event lease can recover any expired shared pipeline lease", async () => {
  const client = new FakeClient();

  const result = await corpusEventWorkerTestHooks.acquireCorpusEventPipelineLease(
    client as unknown as pg.Client,
    {
      owner: "event-owner",
      sourceKey: "github:ZcashCommunityGrants/zcashcommunitygrants#351",
      acquiredAt: now
    }
  );

  const acquisition = client.queries.find((query) =>
    query.text.startsWith("insert into idempotency_keys") &&
    String(query.values[0]) === "corpus-refresh:pipeline:v1"
  );

  assert.equal(result.acquired, true);
  assert.match(acquisition?.text ?? "", /locked_until <= now\(\)/);
  assert.doesNotMatch(
    acquisition?.text ?? "",
    /locked_until <= now\(\)[\s\S]*ownerKind/
  );
});

test("reclaiming an expired full-refresh lease fails its abandoned parent run", async () => {
  const queries: Query[] = [];
  const client = {
    async query(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });

      if (text === "begin" || text === "commit") {
        return { rows: [], rowCount: null };
      }

      if (text.includes("from idempotency_keys") && text.includes("for update")) {
        return {
          rows: [{
            result: {
              owner: "expired-full-refresh",
              ownerKind: "full_refresh",
              parentSyncRunId: "00000000-0000-4000-8000-000000000099"
            },
            reclaimable: true
          }],
          rowCount: 1
        };
      }

      if (text.startsWith("insert into idempotency_keys")) {
        return {
          rows: [{ locked_until: "2026-07-15T14:30:00.000Z", result: {} }],
          rowCount: 1
        };
      }

      if (text.includes("update sync_runs")) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${text}`);
    },
    async end() {}
  } as unknown as pg.Client;

  const result = await corpusEventWorkerTestHooks.acquireCorpusEventPipelineLease(client, {
    owner: "event-recovery-owner",
    sourceKey: "github:ZcashCommunityGrants/zcashcommunitygrants#351",
    acquiredAt: now
  });

  assert.equal(result.acquired, true);
  const abandonedRun = queries.find((query) => query.text.includes("update sync_runs"));
  assert.ok(abandonedRun);
  assert.match(abandonedRun.text, /status = 'failed'/);
  assert.match(abandonedRun.text, /staleLeaseRecoveredBy/);
  assert.deepEqual(abandonedRun.values, [
    "00000000-0000-4000-8000-000000000099",
    "event-recovery-owner",
    "The full corpus refresh lease expired before the workflow finalized."
  ]);
});

test("reclaiming an expired Sheet-refresh lease fails its abandoned parent run", async () => {
  const queries: Query[] = [];
  const client = {
    async query(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });

      if (text === "begin" || text === "commit") {
        return { rows: [], rowCount: null };
      }

      if (text.includes("from idempotency_keys") && text.includes("for update")) {
        return {
          rows: [{
            result: {
              owner: "expired-sheet-refresh",
              ownerKind: "sheet_refresh",
              parentSyncRunId: "00000000-0000-4000-8000-000000000098"
            },
            reclaimable: true
          }],
          rowCount: 1
        };
      }

      if (text.startsWith("insert into idempotency_keys")) {
        return {
          rows: [{ locked_until: "2026-07-15T14:30:00.000Z", result: {} }],
          rowCount: 1
        };
      }

      if (text.includes("update sync_runs")) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${text}`);
    },
    async end() {}
  } as unknown as pg.Client;

  const result = await corpusEventWorkerTestHooks.acquireCorpusEventPipelineLease(client, {
    owner: "event-sheet-recovery-owner",
    sourceKey: "discourse:1234",
    acquiredAt: now
  });

  assert.equal(result.acquired, true);
  const abandonedRun = queries.find((query) => query.text.includes("update sync_runs"));
  assert.deepEqual(abandonedRun?.values, [
    "00000000-0000-4000-8000-000000000098",
    "event-sheet-recovery-owner",
    "The Google Sheet refresh lease expired before the workflow finalized."
  ]);
});

test("records Drive notifications as requiring a future full refresh without launching one", async () => {
  const client = new FakeClient();
  const handler = testHandler(client);
  const response = await handler({
    Records: [sqsRecord("drive-message", driveMessage("drive-delivery"))]
  });

  assert.deepEqual(response, { batchItemFailures: [] });
  const completion = client.queries.find((query) =>
    query.text.startsWith("update sync_runs") && query.text.includes("status = 'completed'")
  );
  const metadata = JSON.parse(String(completion?.values[5])) as Record<string, unknown>;

  assert.equal(metadata.requiresFullRefresh, true);
  assert.equal(metadata.fullRefreshReason, "google_drive_notification_requires_delta_sheet_sync");
  assert.equal(client.syncRunCount, 1);
});

test("refreshes a known Discourse topic and only its linked applications", async () => {
  const client = new FakeClient();
  client.forumContexts = [
    [{ url: forumUrl, application_id: appForum }],
    [{ url: forumUrl, application_id: appForum }]
  ];
  const forumCalls: string[][] = [];
  const indexedApplications: string[][] = [];
  const handler = testHandler(client, {
    mirrorForumTopics: async (config = {}) => {
      assert.equal(config.maxTopics, 1);
      forumCalls.push(config.urls ?? []);
      return forumMirrorResult();
    },
    storeMirrorResult: async (_client, _syncRunId, result) => stored(result.records.length),
    refreshGrantKnowledgeDocuments: async ({ applicationIds } = {}) => {
      indexedApplications.push([...(applicationIds ?? [])]);
      return {
        ok: true,
        applicationsSeen: applicationIds?.length ?? 0,
        documentsIndexed: 1,
        staleDocumentsRemoved: 0
      };
    }
  });

  const response = await handler({
    Records: [sqsRecord("forum-message", discourseMessage("forum-delivery"))]
  });

  assert.deepEqual(response, { batchItemFailures: [] });
  assert.deepEqual(forumCalls, [[forumUrl]]);
  assert.deepEqual(indexedApplications, [[appForum]]);
});

test("returns only invalid or transiently failed records in the partial batch response", async () => {
  const client = new FakeClient();
  const handler = testHandler(client, {
    mirrorGitHubIssue: async () => {
      throw new Error("GitHub temporarily unavailable");
    }
  });
  const response = await handler({
    Records: [
      sqsRecord("invalid-message", "not-json"),
      sqsRecord("github-message", githubMessage("delivery-failure", "issues")),
      sqsRecord("drive-message", driveMessage("drive-success"))
    ]
  });

  assert.deepEqual(response.batchItemFailures, [
    { itemIdentifier: "invalid-message" },
    { itemIdentifier: "github-message" }
  ]);
  assert.equal(client.idempotency.get("corpus-webhook:github:delivery-failure")?.status, "failed");
  assert.equal(client.idempotency.get("corpus-webhook:google-drive:drive-success")?.status, "completed");
});

test("acknowledges an already completed delivery without repeating source work", async () => {
  const client = new FakeClient();
  client.idempotency.set("corpus-webhook:github:delivery-complete", {
    status: "completed",
    completedAt: now
  });
  let mirrorCalls = 0;
  const handler = testHandler(client, {
    mirrorGitHubIssue: async () => {
      mirrorCalls += 1;
      return targetedGitHubResult();
    }
  });
  const response = await handler({
    Records: [sqsRecord("message-1", githubMessage("delivery-complete", "issues"))]
  });

  assert.deepEqual(response, { batchItemFailures: [] });
  assert.equal(mirrorCalls, 0);
  assert.equal(client.syncRunCount, 0);
});

test("the delivery claim SQL never reacquires a completed delivery", async () => {
  const client = new FakeClient();
  client.idempotency.set("corpus-webhook:github:delivery-complete-sql", {
    status: "completed",
    completedAt: now
  });

  const result = await corpusEventWorkerTestHooks.claimDelivery(
    client as unknown as pg.Client,
    {
      provider: "github",
      deliveryId: "delivery-complete-sql",
      owner: "owner-sql-test",
      now,
      sourceKey: "github:ZcashCommunityGrants/zcashcommunitygrants#351"
    }
  );

  const claim = client.queries.find((query) =>
    query.text.startsWith("insert into idempotency_keys") &&
    String(query.values[0]) === "corpus-webhook:github:delivery-complete-sql"
  );

  assert.equal(result.status, "completed");
  assert.match(
    claim?.text ?? "",
    /result->>'status' is distinct from 'completed'/
  );
});

test("acknowledges issue-comment events for pull requests without creating retry poison", async () => {
  const client = new FakeClient();
  let reconciliationCalls = 0;
  const handler = testHandler(client, {
    mirrorGitHubIssue: async (issueNumber) => {
      throw new GitHubPullRequestTargetError(issueNumber);
    },
    runTargetedGitHubReconciliation: async () => {
      reconciliationCalls += 1;
      throw new Error("Pull requests must not be reconciled.");
    }
  });
  const response = await handler({
    Records: [sqsRecord("pr-message", githubMessage("pr-delivery", "issue_comment"))]
  });

  assert.deepEqual(response, { batchItemFailures: [] });
  assert.equal(reconciliationCalls, 0);
  assert.equal(client.idempotency.get("corpus-webhook:github:pr-delivery")?.status, "completed");
  const completion = client.queries.find((query) =>
    query.text.startsWith("update sync_runs") && query.text.includes("status = 'completed'")
  );
  const metadata = JSON.parse(String(completion?.values[5])) as Record<string, unknown>;
  assert.equal(metadata.ignored, true);
  assert.equal(metadata.reason, "pull_request_event");
});

test("uses the ingress pull-request discriminator to skip GitHub source work", async () => {
  const client = new FakeClient();
  let mirrorCalls = 0;
  const handler = testHandler(client, {
    mirrorGitHubIssue: async () => {
      mirrorCalls += 1;
      return targetedGitHubResult();
    }
  });
  const response = await handler({
    Records: [
      sqsRecord(
        "pr-message",
        githubMessage("pr-discriminator", "issue_comment", { isPullRequest: true })
      )
    ]
  });

  assert.deepEqual(response, { batchItemFailures: [] });
  assert.equal(mirrorCalls, 0);
  assert.equal(client.idempotency.get("corpus-webhook:github:pr-discriminator")?.status, "completed");
});

test("acknowledges signed events for a different repository without importing it", async () => {
  const client = new FakeClient();
  let mirrorCalls = 0;
  const handler = testHandler(client, {
    mirrorGitHubIssue: async () => {
      mirrorCalls += 1;
      return targetedGitHubResult();
    }
  });
  const response = await handler({
    Records: [
      sqsRecord(
        "other-repo-message",
        githubMessage("other-repo-delivery", "issues", { repository: "someone/else" })
      )
    ]
  });

  assert.deepEqual(response, { batchItemFailures: [] });
  assert.equal(mirrorCalls, 0);
  const completion = client.queries.find((query) =>
    query.text.startsWith("update sync_runs") && query.text.includes("status = 'completed'")
  );
  const metadata = JSON.parse(String(completion?.values[5])) as Record<string, unknown>;
  assert.equal(metadata.reason, "repository_mismatch");
});

test("acknowledges an unknown Discourse topic without expanding the corpus", async () => {
  const client = new FakeClient();
  let mirrorCalls = 0;
  const handler = testHandler(client, {
    mirrorForumTopics: async () => {
      mirrorCalls += 1;
      return forumMirrorResult();
    }
  });
  const response = await handler({
    Records: [sqsRecord("unknown-topic", discourseMessage("unknown-topic-delivery"))]
  });

  assert.deepEqual(response, { batchItemFailures: [] });
  assert.equal(mirrorCalls, 0);
  const completion = client.queries.find((query) =>
    query.text.startsWith("update sync_runs") && query.text.includes("status = 'completed'")
  );
  const metadata = JSON.parse(String(completion?.values[5])) as Record<string, unknown>;
  assert.equal(metadata.ignored, true);
  assert.equal(metadata.reason, "unknown_topic");
});
