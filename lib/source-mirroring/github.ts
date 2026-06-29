import type { GitHubMirrorConfig, SourceMirrorResult, SourceMirrorRecord } from "./types";

type GitHubLabel = {
  name?: string;
};

type GitHubIssue = {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  user?: {
    login?: string;
    html_url?: string;
  };
  labels?: GitHubLabel[];
  pull_request?: unknown;
};

const DEFAULT_OWNER = "ZcashCommunityGrants";
const DEFAULT_REPO = "zcashcommunitygrants";

function labelsFor(issue: GitHubIssue) {
  return (issue.labels ?? [])
    .map((label) => label.name)
    .filter((label): label is string => Boolean(label));
}

function issueSummary(issue: GitHubIssue) {
  const body = issue.body?.replace(/\s+/g, " ").trim() ?? "";
  return body.length > 240 ? `${body.slice(0, 237)}...` : body;
}

export async function mirrorGitHubIssues(config: GitHubMirrorConfig = {}): Promise<SourceMirrorResult> {
  const owner = config.owner ?? process.env.ZCG_GITHUB_OWNER ?? DEFAULT_OWNER;
  const repo = config.repo ?? process.env.ZCG_GITHUB_REPO ?? DEFAULT_REPO;
  const token = config.token ?? process.env.GITHUB_TOKEN ?? process.env.ZCG_GITHUB_TOKEN;
  const maxPages = Number(config.maxPages ?? process.env.ZCG_GITHUB_MAX_PAGES ?? 10);
  const fetchedAt = new Date().toISOString();
  const issues: GitHubIssue[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);
    url.searchParams.set("state", "all");
    url.searchParams.set("sort", "created");
    url.searchParams.set("direction", "asc");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "zcg-grants-prototype",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub issue mirror failed: ${response.status} ${response.statusText}`);
    }

    const pageIssues = (await response.json()) as GitHubIssue[];
    const issueOnlyRecords = pageIssues.filter((issue) => !issue.pull_request);
    issues.push(...issueOnlyRecords);

    if (pageIssues.length < 100) {
      break;
    }
  }

  const records: SourceMirrorRecord[] = issues.map((issue) => ({
    sourceKind: "github_issue",
    sourceId: `${owner}/${repo}#${issue.number}`,
    sourceUrl: issue.html_url,
    sourceUpdatedAt: issue.updated_at,
    title: issue.title,
    summary: issueSummary(issue),
    rawPayload: issue as unknown as Record<string, unknown>,
    metadata: {
      owner,
      repo,
      number: issue.number,
      state: issue.state,
      labels: labelsFor(issue),
      author: issue.user?.login ?? null,
      closedAt: issue.closed_at
    }
  }));

  return {
    sourceKind: "github_issues",
    sourceId: `${owner}/${repo}`,
    sourceUrl: `https://github.com/${owner}/${repo}/issues`,
    rawPayload: {
      fetchedAt,
      owner,
      repo,
      issueCount: records.length,
      issues
    },
    records,
    metadata: {
      fetchedAt,
      owner,
      repo,
      issueCount: records.length
    }
  };
}
