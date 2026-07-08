import type { GitHubMirrorConfig, SourceMirrorResult, SourceMirrorRecord } from "./types";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

type GitHubLabel = {
  name?: string;
  color?: string | null;
  description?: string | null;
};

type GitHubIssue = {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  comments?: number;
  comments_url?: string;
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

type GitHubIssueComment = {
  id: number;
  html_url: string;
  body: string | null;
  created_at: string;
  updated_at: string;
  author_association?: string;
  user?: {
    login?: string;
    html_url?: string;
  };
};

const DEFAULT_OWNER = "ZcashCommunityGrants";
const DEFAULT_REPO = "zcashcommunitygrants";
const secretsManager = new SecretsManagerClient({});

let cachedSecretToken: string | undefined;

function labelsFor(issue: GitHubIssue) {
  return (issue.labels ?? [])
    .map((label) => label.name)
    .filter((label): label is string => Boolean(label));
}

function labelDetailsFor(issue: GitHubIssue) {
  return (issue.labels ?? [])
    .map((label) => ({
      name: label.name,
      color: label.color ?? null,
      description: label.description ?? null
    }))
    .filter((label): label is { name: string; color: string | null; description: string | null } =>
      Boolean(label.name)
    );
}

function issueSummary(issue: GitHubIssue) {
  const body = issue.body?.replace(/\s+/g, " ").trim() ?? "";
  return body.length > 240 ? `${body.slice(0, 237)}...` : body;
}

function commentSummary(comment: GitHubIssueComment) {
  const body = comment.body?.replace(/\s+/g, " ").trim() ?? "";
  return body.length > 240 ? `${body.slice(0, 237)}...` : body;
}

function githubHeaders(token?: string) {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "zcg-grants-prototype",
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
}

function tokenFromSecretValue(secretValue: string) {
  const trimmed = secretValue.trim();

  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const token = parsed.token ?? parsed.GITHUB_TOKEN ?? parsed.ZCG_GITHUB_TOKEN;

    return typeof token === "string" && token.trim() ? token.trim() : undefined;
  } catch {
    return trimmed;
  }
}

async function githubTokenFromSecretsManager() {
  const secretId = process.env.ZCG_GITHUB_TOKEN_SECRET_ID ?? process.env.ZCG_GITHUB_TOKEN_SECRET_ARN;

  if (!secretId) {
    return undefined;
  }

  if (cachedSecretToken) {
    return cachedSecretToken;
  }

  const response = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
  const secretValue =
    response.SecretString ??
    (response.SecretBinary ? Buffer.from(response.SecretBinary).toString("utf8") : undefined);

  cachedSecretToken = secretValue ? tokenFromSecretValue(secretValue) : undefined;
  return cachedSecretToken;
}

async function fetchIssueComments(params: {
  issue: GitHubIssue;
  owner: string;
  repo: string;
  token?: string;
  maxPages: number;
}) {
  if (!params.issue.comments) {
    return [] as GitHubIssueComment[];
  }

  const comments: GitHubIssueComment[] = [];

  for (let page = 1; page <= params.maxPages; page += 1) {
    const url = new URL(
      params.issue.comments_url ??
        `https://api.github.com/repos/${params.owner}/${params.repo}/issues/${params.issue.number}/comments`
    );
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const response = await fetch(url, {
      headers: githubHeaders(params.token)
    });

    if (!response.ok) {
      throw new Error(
        `GitHub issue comment mirror failed for #${params.issue.number}: ${response.status} ${response.statusText}`
      );
    }

    const pageComments = (await response.json()) as GitHubIssueComment[];
    comments.push(...pageComments);

    if (pageComments.length < 100) {
      break;
    }
  }

  return comments;
}

export async function mirrorGitHubIssues(config: GitHubMirrorConfig = {}): Promise<SourceMirrorResult> {
  const owner = config.owner ?? process.env.ZCG_GITHUB_OWNER ?? DEFAULT_OWNER;
  const repo = config.repo ?? process.env.ZCG_GITHUB_REPO ?? DEFAULT_REPO;
  const token = config.token ?? process.env.GITHUB_TOKEN ?? process.env.ZCG_GITHUB_TOKEN ?? (await githubTokenFromSecretsManager());
  const maxPages = Number(config.maxPages ?? process.env.ZCG_GITHUB_MAX_PAGES ?? 10);
  const commentMaxPages = Number(config.commentMaxPages ?? process.env.ZCG_GITHUB_COMMENT_MAX_PAGES ?? 10);
  const fetchedAt = new Date().toISOString();
  const issues: GitHubIssue[] = [];
  const commentsByIssueNumber = new Map<number, GitHubIssueComment[]>();

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);
    url.searchParams.set("state", "all");
    url.searchParams.set("sort", "created");
    url.searchParams.set("direction", "asc");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const response = await fetch(url, {
      headers: githubHeaders(token)
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

  for (const issue of issues) {
    const comments = await fetchIssueComments({ issue, owner, repo, token, maxPages: commentMaxPages });
    commentsByIssueNumber.set(issue.number, comments);
  }

  const issueRecords: SourceMirrorRecord[] = issues.map((issue) => ({
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
      labelDetails: labelDetailsFor(issue),
      author: issue.user?.login ?? null,
      commentCount: issue.comments ?? 0,
      closedAt: issue.closed_at
    }
  }));
  const commentRecords: SourceMirrorRecord[] = issues.flatMap((issue) => {
    const issueSourceId = `${owner}/${repo}#${issue.number}`;
    return (commentsByIssueNumber.get(issue.number) ?? []).map((comment) => ({
      sourceKind: "github_issue_comment",
      sourceId: `${issueSourceId}:comment:${comment.id}`,
      sourceUrl: comment.html_url,
      sourceUpdatedAt: comment.updated_at,
      title: `Comment on #${issue.number}: ${issue.title}`,
      summary: commentSummary(comment),
      rawPayload: {
        ...comment,
        parentIssue: {
          number: issue.number,
          title: issue.title,
          html_url: issue.html_url,
          source_id: issueSourceId
        }
      } as Record<string, unknown>,
      metadata: {
        owner,
        repo,
        number: issue.number,
        issueNumber: issue.number,
        issueSourceId,
        issueUrl: issue.html_url,
        commentId: comment.id,
        author: comment.user?.login ?? null,
        authorAssociation: comment.author_association ?? null,
        createdAt: comment.created_at
      }
    }));
  });
  const records = [...issueRecords, ...commentRecords];

  return {
    sourceKind: "github_issues",
    sourceId: `${owner}/${repo}`,
    sourceUrl: `https://github.com/${owner}/${repo}/issues`,
    rawPayload: {
      fetchedAt,
      owner,
      repo,
      issueCount: issueRecords.length,
      commentCount: commentRecords.length,
      issues,
      issueComments: Object.fromEntries(commentsByIssueNumber.entries())
    },
    records,
    metadata: {
      fetchedAt,
      owner,
      repo,
      issueCount: issueRecords.length,
      commentCount: commentRecords.length,
      recordCount: records.length
    }
  };
}
