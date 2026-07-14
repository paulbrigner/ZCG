import assert from "node:assert/strict";
import test from "node:test";
import { mirrorGitHubIssues } from "../../lib/source-mirroring/github";

type TestIssue = {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  comments: number;
  comments_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  user: { login: string; html_url: string };
  labels: Array<{ name: string; color: string; description: string }>;
  pull_request?: Record<string, unknown>;
};

const owner = "ZcashCommunityGrants";
const repo = "zcashcommunitygrants";
const apiBase = `https://api.github.com/repos/${owner}/${repo}`;

function issue(number: number): TestIssue {
  return {
    number,
    html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
    title: `Grant application ${number}`,
    body: `Application body for grant ${number}`,
    state: "closed",
    comments: 0,
    comments_url: `${apiBase}/issues/${number}/comments`,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-02T00:00:00Z",
    closed_at: "2025-01-03T00:00:00Z",
    user: {
      login: `applicant-${number}`,
      html_url: `https://github.com/applicant-${number}`
    },
    labels: []
  };
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function jsonResponseWithHeaders(payload: unknown, headers: HeadersInit) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
}

test("fetches a new grant application on page four and retains reconciliation metadata", async () => {
  const issue351: TestIssue = {
    ...issue(351),
    title: "Grant Application - FROST Shielded Multi-Sig SDK: Easy Threshold Custody for Zcash Wallets",
    body: "FROST Shielded Multi-Sig SDK proposal body",
    state: "open",
    comments: 5,
    created_at: "2026-07-10T22:53:58Z",
    updated_at: "2026-07-12T13:53:10Z",
    closed_at: null,
    user: {
      login: "mahmudsudo",
      html_url: "https://github.com/mahmudsudo"
    },
    labels: [
      {
        name: "📋 Grant Application",
        color: "BDB853",
        description: "Validated application"
      },
      {
        name: "👀 Ready For ZCG Review",
        color: "115858",
        description: "Ready for committee evaluation"
      }
    ]
  };
  const pullRequest = {
    ...issue(352),
    title: "Repository maintenance",
    pull_request: { url: `${apiBase}/pulls/352` }
  };
  const issuePages = new Map<number, TestIssue[]>([
    [1, Array.from({ length: 100 }, (_, index) => issue(index + 1))],
    [2, Array.from({ length: 100 }, (_, index) => issue(index + 101))],
    [3, Array.from({ length: 100 }, (_, index) => issue(index + 201))],
    [4, [issue351, pullRequest]]
  ]);
  const issuePageRequests: number[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));

    if (url.pathname === `/repos/${owner}/${repo}/issues`) {
      assert.equal(url.searchParams.get("state"), "all");
      assert.equal(url.searchParams.get("sort"), "created");
      assert.equal(url.searchParams.get("direction"), "asc");
      assert.equal(url.searchParams.get("per_page"), "100");

      const page = Number(url.searchParams.get("page"));
      issuePageRequests.push(page);
      return jsonResponse(issuePages.get(page) ?? []);
    }

    if (url.pathname === `/repos/${owner}/${repo}/issues/351/comments`) {
      assert.equal(url.searchParams.get("per_page"), "100");
      assert.equal(url.searchParams.get("page"), "1");
      return jsonResponse(Array.from({ length: 5 }, (_, index) => ({
        id: 35100 + index,
        html_url: `${issue351.html_url}#issuecomment-${35100 + index}`,
        body: `Committee comment ${index + 1}`,
        created_at: `2026-07-11T0${index}:00:00Z`,
        updated_at: `2026-07-11T0${index}:00:00Z`,
        author_association: "MEMBER",
        user: {
          login: `reviewer-${index + 1}`,
          html_url: `https://github.com/reviewer-${index + 1}`
        }
      })));
    }

    throw new Error(`Unexpected GitHub request: ${url}`);
  }) as typeof fetch;

  try {
    const result = await mirrorGitHubIssues({
      owner,
      repo,
      token: "test-token",
      maxPages: 10,
      commentMaxPages: 10
    });

    assert.deepEqual(issuePageRequests, [1, 2, 3, 4]);
    assert.equal(result.records.some((record) => record.sourceId === `${owner}/${repo}#352`), false);

    const record = result.records.find((candidate) => candidate.sourceId === `${owner}/${repo}#351`);
    assert.ok(record);
    assert.equal(record.sourceKind, "github_issue");
    assert.equal(record.sourceUrl, issue351.html_url);
    assert.equal(record.sourceUpdatedAt, issue351.updated_at);
    assert.equal(record.title, issue351.title);
    assert.equal(record.summary, issue351.body);
    assert.deepEqual(record.metadata, {
      owner,
      repo,
      number: 351,
      state: "open",
      labels: ["📋 Grant Application", "👀 Ready For ZCG Review"],
      labelDetails: issue351.labels,
      author: "mahmudsudo",
      commentCount: 5,
      closedAt: null
    });
    assert.equal(record.rawPayload.created_at, issue351.created_at);

    const comments = result.records.filter(
      (candidate) => candidate.sourceKind === "github_issue_comment"
        && candidate.metadata?.issueNumber === 351
    );
    assert.equal(comments.length, 5);
    assert.equal(comments[0]?.metadata?.issueSourceId, `${owner}/${repo}#351`);
    assert.equal(result.metadata?.issueCount, 301);
    assert.equal(result.metadata?.commentCount, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("starts at a requested page and reports the linked continuation for a bounded batch", async () => {
  const issuePageRequests: Array<{ page: number; pageSize: number }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));

    if (url.pathname === `/repos/${owner}/${repo}/issues`) {
      const page = Number(url.searchParams.get("page"));
      const pageSize = Number(url.searchParams.get("per_page"));
      issuePageRequests.push({ page, pageSize });

      assert.equal(page, 4);
      return jsonResponseWithHeaders([issue(7), issue(8)], {
        link: `<${apiBase}/issues?state=all&per_page=2&page=5>; rel="next"`
      });
    }

    throw new Error(`Unexpected GitHub request: ${url}`);
  }) as typeof fetch;

  try {
    const result = await mirrorGitHubIssues({
      owner,
      repo,
      token: "test-token",
      startPage: 4,
      pageSize: 2,
      maxPages: 1
    });

    assert.deepEqual(issuePageRequests, [{ page: 4, pageSize: 2 }]);
    assert.deepEqual(result.records.map((record) => record.sourceId), [
      `${owner}/${repo}#7`,
      `${owner}/${repo}#8`
    ]);
    assert.equal(result.metadata?.startPage, 4);
    assert.equal(result.metadata?.pageSize, 2);
    assert.equal(result.metadata?.pagesFetched, 1);
    assert.deepEqual(result.metadata?.fetchedPages, [4]);
    assert.equal(result.metadata?.lastPageFetched, 4);
    assert.equal(result.metadata?.hasMore, true);
    assert.equal(result.metadata?.nextPage, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probes after a full bounded page when Link metadata is absent", async () => {
  const issuePageRequests: number[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));

    if (url.pathname === `/repos/${owner}/${repo}/issues`) {
      const page = Number(url.searchParams.get("page"));
      issuePageRequests.push(page);
      return jsonResponse(page === 7 ? [issue(13), issue(14)] : []);
    }

    throw new Error(`Unexpected GitHub request: ${url}`);
  }) as typeof fetch;

  try {
    const result = await mirrorGitHubIssues({
      owner,
      repo,
      token: "test-token",
      startPage: 7,
      pageSize: 2,
      maxPages: 1
    });

    assert.deepEqual(issuePageRequests, [7, 8]);
    assert.equal(result.records.length, 2);
    assert.equal(result.metadata?.pagesFetched, 1);
    assert.deepEqual(result.metadata?.fetchedPages, [7]);
    assert.equal(result.metadata?.lastPageFetched, 7);
    assert.equal(result.metadata?.hasMore, false);
    assert.equal(result.metadata?.nextPage, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
