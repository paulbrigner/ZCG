import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchCompleteForumTopic,
  groupForumTopicReferences,
  mirrorForumUpdatesCategory,
  normalizeForumTopicUrl,
  parseForumTopicReference,
  type DiscoursePost
} from "../../lib/source-mirroring/forum";

function post(id: number): DiscoursePost {
  return {
    id,
    topic_id: 555,
    post_number: id,
    username: `user-${id}`,
    cooked: `<p>Post ${id}</p>`
  };
}

function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

test("parses canonical topic identity while preserving post-specific references", () => {
  assert.deepEqual(
    parseForumTopicReference("https://forum.zcashcommunity.com/t/cypherpunk-policy-dinner/555/36?u=paul#ignored"),
    {
      topicId: 555,
      slug: "cypherpunk-policy-dinner",
      canonicalUrl: "https://forum.zcashcommunity.com/t/cypherpunk-policy-dinner/555",
      referencedUrl: "https://forum.zcashcommunity.com/t/cypherpunk-policy-dinner/555/36",
      referencedPostNumber: 36
    }
  );
  assert.deepEqual(
    parseForumTopicReference("https://forum.zcashcommunity.com/t/555/36"),
    {
      topicId: 555,
      slug: null,
      canonicalUrl: "https://forum.zcashcommunity.com/t/555",
      referencedUrl: "https://forum.zcashcommunity.com/t/555/36",
      referencedPostNumber: 36
    }
  );
  assert.equal(
    normalizeForumTopicUrl("https://forum.zcashcommunity.com/t/cypherpunk-policy-dinner/555/#post_12"),
    "https://forum.zcashcommunity.com/t/cypherpunk-policy-dinner/555/12"
  );
});

test("groups base and anchored references under one canonical topic fetch", () => {
  const groups = groupForumTopicReferences([
    "https://forum.zcashcommunity.com/t/cypherpunk-policy-dinner/555",
    "https://forum.zcashcommunity.com/t/cypherpunk-policy-dinner/555/36",
    "https://forum.zcashcommunity.com/t/another-topic/777/2"
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups[0]?.map((reference) => reference.referencedPostNumber),
    [null, 36]
  );
});

test("fetches a complete Discourse post stream in batches of 20", async () => {
  const reference = parseForumTopicReference(
    "https://forum.zcashcommunity.com/t/cypherpunk-policy-dinner/555/36"
  )!;
  const stream = Array.from({ length: 45 }, (_, index) => index + 1);
  const batchSizes: number[] = [];
  let initialFetches = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/555.json")) {
      initialFetches += 1;
      return jsonResponse({
        id: 555,
        slug: "cypherpunk-policy-dinner",
        title: "Cypherpunk Policy Dinner",
        posts_count: 45,
        post_stream: {
          stream,
          posts: stream.slice(0, 20).map(post)
        }
      });
    }

    const ids = url.searchParams.getAll("post_ids[]").map(Number);
    batchSizes.push(ids.length);
    return jsonResponse({ post_stream: { posts: ids.map(post) } });
  };

  const topic = await fetchCompleteForumTopic(reference, {
    maxPosts: 1000,
    fetchImpl,
    sleepImpl: async () => undefined
  });

  assert.equal(initialFetches, 1);
  assert.deepEqual(batchSizes, [20, 5]);
  assert.equal(topic?.posts.length, 45);
  assert.equal(topic?.posts.at(-1)?.plainText, "Post 45");
  assert.equal(topic?.coverageComplete, true);
  assert.equal(topic?.coverageCapped, false);
  assert.deepEqual(topic?.missingPostIds, []);
});

test("honors Retry-After before retrying rate-limited requests", async () => {
  const reference = parseForumTopicReference("https://forum.zcashcommunity.com/t/topic/555")!;
  const waits: number[] = [];
  let attempts = 0;
  const fetchImpl: typeof fetch = async () => {
    attempts += 1;

    if (attempts === 1) {
      return jsonResponse({ error: "rate limited" }, 429, { "retry-after": "2" });
    }

    return jsonResponse({
      id: 555,
      posts_count: 1,
      post_stream: { stream: [1], posts: [post(1)] }
    });
  };

  const topic = await fetchCompleteForumTopic(reference, {
    maxPosts: 1000,
    maxAttempts: 2,
    fetchImpl,
    sleepImpl: async (ms) => {
      waits.push(ms);
    },
    randomImpl: () => 0
  });

  assert.equal(topic?.coverageComplete, true);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [2000]);
});

test("applies the safety cap without claiming complete coverage", async () => {
  const reference = parseForumTopicReference("https://forum.zcashcommunity.com/t/topic/555")!;
  const stream = Array.from({ length: 50 }, (_, index) => index + 1);
  const batchSizes: number[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/555.json")) {
      return jsonResponse({
        id: 555,
        posts_count: 50,
        post_stream: { stream, posts: stream.slice(0, 20).map(post) }
      });
    }

    const ids = url.searchParams.getAll("post_ids[]").map(Number);
    batchSizes.push(ids.length);
    return jsonResponse({ post_stream: { posts: ids.map(post) } });
  };

  const topic = await fetchCompleteForumTopic(reference, {
    maxPosts: 25,
    fetchImpl,
    sleepImpl: async () => undefined
  });

  assert.deepEqual(batchSizes, [5]);
  assert.equal(topic?.posts.length, 25);
  assert.equal(topic?.coverageComplete, false);
  assert.equal(topic?.coverageCapped, true);
});

test("returns partial progress when a post batch exhausts retries", async () => {
  const reference = parseForumTopicReference("https://forum.zcashcommunity.com/t/topic/555")!;
  const stream = Array.from({ length: 45 }, (_, index) => index + 1);
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/555.json")) {
      return jsonResponse({
        id: 555,
        posts_count: 45,
        post_stream: { stream, posts: stream.slice(0, 20).map(post) }
      });
    }

    return jsonResponse({ error: "temporarily unavailable" }, 503);
  };

  const topic = await fetchCompleteForumTopic(reference, {
    maxPosts: 1000,
    maxAttempts: 1,
    fetchImpl,
    sleepImpl: async () => undefined
  });

  assert.equal(topic?.posts.length, 20);
  assert.equal(topic?.coverageComplete, false);
  assert.equal(topic?.coverageCapped, false);
  assert.equal(topic?.missingPostIds.length, 25);
  assert.equal(topic?.fetchFailures.length, 1);
});

test("discovers normalized update topic URLs without fetching topic bodies", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];

  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    requestedUrls.push(url.toString());

    assert.equal(url.pathname, "/c/grants/zomg-updates/34.json");
    return jsonResponse({
      topic_list: {
        more_topics_url: null,
        topics: [
          { id: 901, slug: "july-grant-update", title: "July grant update" },
          { id: 902, slug: "august-grant-update", title: "August grant update" },
          { id: 903, slug: "september-grant-update", title: "September grant update" }
        ]
      }
    });
  }) as typeof fetch;

  try {
    const result = await mirrorForumUpdatesCategory({
      discoveryOnly: true,
      maxTopics: 2,
      maxCategoryPages: 1
    });

    const selectedTopicUrls = [
      "https://forum.zcashcommunity.com/t/july-grant-update/901",
      "https://forum.zcashcommunity.com/t/august-grant-update/902"
    ];

    assert.equal(requestedUrls.length, 1);
    assert.equal(result.records.length, 0);
    assert.equal(result.rawPayload.discoveryOnly, true);
    assert.equal(result.rawPayload.directUrlMode, false);
    assert.deepEqual(result.rawPayload.selectedTopicUrls, selectedTopicUrls);
    assert.deepEqual(result.rawPayload.urls, selectedTopicUrls);
    assert.deepEqual(result.metadata?.selectedTopicUrls, selectedTopicUrls);
    assert.equal(result.metadata?.topicCountSelected, 2);
    assert.equal(result.metadata?.topicCountMirrored, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports an unavailable updates category as a blocking discovery failure", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response("Not found", {
      status: 404,
      statusText: "Not Found"
    })) as typeof fetch;

  try {
    const result = await mirrorForumUpdatesCategory({
      discoveryOnly: true,
      maxCategoryPages: 3
    });

    assert.equal(result.metadata?.categoryFailureCount, 1);
    assert.deepEqual(result.rawPayload.categoryFailures, [
      {
        url: "https://forum.zcashcommunity.com/c/grants/zomg-updates/34.json",
        error: "Updates category unavailable or not public.",
        kind: "error"
      }
    ]);
    assert.deepEqual(result.rawPayload.urls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps direct forum update URL mode fetching topic bodies", async () => {
  const originalFetch = globalThis.fetch;
  const topicUrl = "https://forum.zcashcommunity.com/t/july-grant-update/901";
  const requestedUrls: string[] = [];

  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    requestedUrls.push(url.toString());
    assert.equal(url.pathname, "/t/july-grant-update/901.json");

    return jsonResponse({
      id: 901,
      slug: "july-grant-update",
      title: "July grant update",
      posts_count: 1,
      post_stream: {
        stream: [90101],
        posts: [{
          id: 90101,
          topic_id: 901,
          post_number: 1,
          username: "grant-author",
          cooked: "<p>Milestone complete.</p>"
        }]
      }
    });
  }) as typeof fetch;

  try {
    const result = await mirrorForumUpdatesCategory({
      discoveryOnly: true,
      urls: [`${topicUrl}/1?ignored=true`]
    });

    assert.equal(requestedUrls.length, 1);
    assert.equal(result.rawPayload.discoveryOnly, false);
    assert.equal(result.rawPayload.directUrlMode, true);
    assert.deepEqual(result.rawPayload.selectedTopicUrls, [topicUrl]);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]?.sourceId, `${topicUrl}/1`);
    assert.equal(result.records[0]?.summary, "Milestone complete.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
