import assert from "node:assert/strict";
import test from "node:test";
import { storeNormalizedForumRecords } from "../../lib/source-mirroring/forum-store";

test("dual-writes a mirrored legacy record into normalized topics, posts, and references", async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });

      if (text.includes("insert into discourse_topics")) {
        return { rows: [{ id: "topic-row-id" }], rowCount: 1 };
      }

      if (text.includes("select id") && text.includes("from source_records")) {
        return { rows: [{ id: "source-row-id" }], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    }
  } as unknown as Parameters<typeof storeNormalizedForumRecords>[0];

  const counts = await storeNormalizedForumRecords(client, {
    syncRunId: "sync-run-id",
    records: [{
      sourceKind: "forum_link",
      sourceId: "https://forum.zcashcommunity.com/t/cypherpunk-policy-dinner/555/2",
      sourceUrl: "https://forum.zcashcommunity.com/t/cypherpunk-policy-dinner/555/2",
      sourceUpdatedAt: "2026-07-12T00:00:00.000Z",
      title: "Cypherpunk Policy Dinner",
      summary: "Forum discussion",
      rawPayload: {
        url: "https://forum.zcashcommunity.com/t/cypherpunk-policy-dinner/555/2",
        topic: {
          id: 555,
          slug: "cypherpunk-policy-dinner",
          title: "Cypherpunk Policy Dinner",
          postsCount: 2,
          streamPostIds: [101, 102]
        },
        coverage: { complete: true, capped: false },
        posts: [
          {
            id: 101,
            postNumber: 1,
            username: "alice",
            createdAt: "2026-07-10T00:00:00.000Z",
            plainText: "Proposal",
            cookedHtml: "<p>Proposal</p>"
          },
          {
            id: 102,
            postNumber: 2,
            username: "bob",
            replyToPostNumber: 1,
            createdAt: "2026-07-11T00:00:00.000Z",
            plainText: "Question",
            cookedHtml: "<p>Question</p>"
          }
        ]
      }
    }]
  });

  assert.deepEqual(counts, {
    recordsSeen: 1,
    recordsEligible: 1,
    topicsUpserted: 1,
    completeTopics: 1,
    postsUpserted: 2,
    postsMarkedDeleted: 0,
    referencesUpserted: 1
  });
  assert.equal(queries.filter((query) => query.text.includes("insert into discourse_posts")).length, 2);
  assert.equal(queries.filter((query) => query.text.includes("insert into discourse_topic_references")).length, 1);
  assert.equal(queries.some((query) => query.text.includes("update discourse_posts")), true);

  const topicInsert = queries.find((query) => query.text.includes("insert into discourse_topics"));
  assert.equal(topicInsert?.values[1], "https://forum.zcashcommunity.com/t/cypherpunk-policy-dinner/555");

  const secondPostInsert = queries.filter((query) => query.text.includes("insert into discourse_posts"))[1];
  assert.equal(secondPostInsert?.values[11], "https://forum.zcashcommunity.com/t/cypherpunk-policy-dinner/555/2");
});

test("merges legacy base and deep-link fragments across batches, then replaces them with an authoritative stream", async () => {
  const state = {
    topicExists: false,
    reportedPostCount: null as number | null,
    streamPostIds: [] as number[],
    streamAuthoritative: false,
    coverageComplete: false,
    activePosts: new Set<number>(),
    postLastSyncRun: new Map<number, string>(),
    deletedPosts: new Set<number>(),
    references: new Set<string>()
  };
  const client = {
    async query(text: string, values: unknown[] = []) {
      if (text.includes("insert into discourse_topics")) {
        const incomingReportedPostCount = values[7] as number | null;
        const incomingStreamPostIds = JSON.parse(String(values[9])) as number[];
        const incomingCoverageComplete = Boolean(values[10]);
        const authoritative = Boolean(values[17]);
        const streamSnapshot = Boolean(values[18]);
        const existingStreamMatches = JSON.stringify(state.streamPostIds) === JSON.stringify(incomingStreamPostIds);
        const preserveComplete = state.topicExists
          && state.streamAuthoritative
          && (
            !streamSnapshot
            || (!authoritative && existingStreamMatches)
          );

        if (!state.topicExists) {
          state.topicExists = true;
          state.reportedPostCount = incomingReportedPostCount;
          state.streamPostIds = incomingStreamPostIds;
        } else {
          state.reportedPostCount = streamSnapshot
            ? incomingReportedPostCount
            : state.streamAuthoritative
              ? state.reportedPostCount
              : Math.max(state.reportedPostCount ?? 0, incomingReportedPostCount ?? 0) || null;
        }

        state.streamAuthoritative ||= authoritative;
        state.coverageComplete = preserveComplete
          ? state.coverageComplete
          : incomingCoverageComplete;
        return { rows: [{ id: "topic-row-id" }], rowCount: 1 };
      }

      if (text.includes("insert into discourse_posts")) {
        const postId = Number(values[1]);
        state.activePosts.add(postId);
        state.postLastSyncRun.set(postId, String(values[13]));
        state.deletedPosts.delete(postId);
        return { rows: [], rowCount: 1 };
      }

      if (text.includes("with merged_ids as")) {
        const incomingStreamPostIds = JSON.parse(String(values[1])) as number[];
        const authoritative = Boolean(values[2]);
        const syncRunId = String(values[4]);
        const streamSnapshot = Boolean(values[5]);
        state.streamPostIds = streamSnapshot
          ? incomingStreamPostIds
          : state.streamAuthoritative
            ? state.streamPostIds
            : [...new Set([...state.streamPostIds, ...incomingStreamPostIds])].sort((left, right) => left - right);
        const currentStreamPostCount = state.streamPostIds.filter((postId) => (
          state.activePosts.has(postId)
          && (!authoritative || state.postLastSyncRun.get(postId) === syncRunId)
        )).length;
        state.coverageComplete = state.streamPostIds.length > 0
          && currentStreamPostCount === state.streamPostIds.length
          && (
            authoritative
            || (!streamSnapshot && state.streamAuthoritative && state.coverageComplete)
            || (
              !streamSnapshot
              && !state.streamAuthoritative
              && (
                state.reportedPostCount === null
                || state.streamPostIds.length >= state.reportedPostCount
              )
            )
            || (
              streamSnapshot
              && !authoritative
              && state.streamAuthoritative
              && state.coverageComplete
            )
          );
        return {
          rows: [{
            coverage_complete: state.coverageComplete,
            stream_post_ids: state.streamPostIds
          }],
          rowCount: 1
        };
      }

      if (text.includes("update discourse_posts") && text.includes("not (post_id = any")) {
        const currentStreamPostIds = new Set(values[1] as number[]);
        let deleted = 0;

        for (const postId of state.activePosts) {
          if (!currentStreamPostIds.has(postId)) {
            state.activePosts.delete(postId);
            state.deletedPosts.add(postId);
            deleted += 1;
          }
        }

        return { rows: [], rowCount: deleted };
      }

      if (text.includes("select id") && text.includes("from source_records")) {
        return { rows: [{ id: `source:${String(values[1])}` }], rowCount: 1 };
      }

      if (text.includes("insert into discourse_topic_references")) {
        state.references.add(String(values[2]));
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    }
  } as unknown as Parameters<typeof storeNormalizedForumRecords>[0];

  function record(params: {
    sourceId: string;
    postIds: number[];
    streamPostIds?: number[];
    reportedPostCount: number;
    complete: boolean;
    capped?: boolean;
  }) {
    return {
      sourceKind: "forum_link",
      sourceId: params.sourceId,
      sourceUrl: params.sourceId,
      rawPayload: {
        url: params.sourceId,
        topic: {
          id: 555,
          slug: "topic",
          postsCount: params.reportedPostCount,
          ...(params.streamPostIds ? { streamPostIds: params.streamPostIds } : {})
        },
        coverage: { complete: params.complete, capped: params.capped ?? false },
        posts: params.postIds.map((postId) => ({
          id: postId,
          postNumber: postId - 100,
          plainText: `Post ${postId}`
        }))
      }
    };
  }

  await storeNormalizedForumRecords(client, {
    syncRunId: "sync-1",
    records: [record({
      sourceId: "https://forum.zcashcommunity.com/t/topic/555",
      postIds: [101, 102],
      reportedPostCount: 4,
      complete: false
    })]
  });
  assert.deepEqual(state.streamPostIds, [101, 102]);
  assert.equal(state.coverageComplete, false);

  await storeNormalizedForumRecords(client, {
    syncRunId: "sync-2",
    records: [record({
      sourceId: "https://forum.zcashcommunity.com/t/topic/555/3",
      postIds: [103, 104],
      reportedPostCount: 4,
      complete: false
    })]
  });
  assert.deepEqual(state.streamPostIds, [101, 102, 103, 104]);
  assert.equal(state.coverageComplete, true);
  assert.deepEqual(
    [...state.references].sort(),
    [
      "https://forum.zcashcommunity.com/t/topic/555",
      "https://forum.zcashcommunity.com/t/topic/555/3"
    ]
  );

  await storeNormalizedForumRecords(client, {
    syncRunId: "sync-3",
    records: [record({
      sourceId: "https://forum.zcashcommunity.com/t/topic/555",
      postIds: [101, 102, 103],
      streamPostIds: [101, 102, 103],
      reportedPostCount: 4,
      complete: true
    })]
  });
  assert.deepEqual(state.streamPostIds, [101, 102, 103]);
  assert.equal(
    state.coverageComplete,
    true,
    "a fully fetched authoritative stream wins over a stale reported post count"
  );
  assert.deepEqual([...state.deletedPosts], [104]);

  await storeNormalizedForumRecords(client, {
    syncRunId: "sync-capped-observation",
    records: [record({
      sourceId: "https://forum.zcashcommunity.com/t/topic/555",
      postIds: [101, 102],
      streamPostIds: [101, 102, 103],
      reportedPostCount: 3,
      complete: false,
      capped: true
    })]
  });
  assert.deepEqual(state.streamPostIds, [101, 102, 103]);
  assert.equal(
    state.coverageComplete,
    true,
    "a capped category observation must not downgrade a complete capture of the same stream"
  );

  await storeNormalizedForumRecords(client, {
    syncRunId: "sync-stale-legacy",
    records: [record({
      sourceId: "https://forum.zcashcommunity.com/t/topic/555/4",
      postIds: [104],
      reportedPostCount: 4,
      complete: false
    })]
  });
  assert.deepEqual(
    state.streamPostIds,
    [101, 102, 103],
    "a stale legacy fragment must not widen an authoritative stream"
  );
  assert.deepEqual([...state.deletedPosts], [104]);

  await storeNormalizedForumRecords(client, {
    syncRunId: "sync-4",
    records: [record({
      sourceId: "https://forum.zcashcommunity.com/t/topic/555",
      postIds: [101, 102, 103],
      streamPostIds: [101, 102, 103, 104, 105],
      reportedPostCount: 5,
      complete: false
    })]
  });
  assert.deepEqual(state.streamPostIds, [101, 102, 103, 104, 105]);
  assert.equal(state.coverageComplete, false);

  await storeNormalizedForumRecords(client, {
    syncRunId: "sync-5",
    records: [record({
      sourceId: "https://forum.zcashcommunity.com/t/topic/555",
      postIds: [101, 102],
      streamPostIds: [101, 102, 103, 104],
      reportedPostCount: 4,
      complete: false
    })]
  });
  assert.deepEqual(state.streamPostIds, [101, 102, 103, 104]);
  assert.equal(
    state.coverageComplete,
    false,
    "stale posts from a prior sync must not make a failed authoritative refresh look complete"
  );
});
