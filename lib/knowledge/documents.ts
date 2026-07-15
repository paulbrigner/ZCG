import crypto from "node:crypto";
import { query } from "@/lib/db";

const generatedBy = "grant_knowledge_index_v1";
const contentMaxChars = 24000;
const forumChunkMaxChars = 6000;
const forumPostSegmentMaxChars = 3000;
const forumPostsPerWindow = 5;
const normalizedForumPostBatchSize = 10;
const chunkedForumSourceKinds = new Set(["forum_link", "forum_meeting_minutes", "forum_update_topic"]);
const sourceRecordBatchSize = 10;
const writeBatchSize = 15;

type GrantKnowledgeSourceRecord = {
  id: string;
  source_kind: string;
  source_id: string;
  source_url: string | null;
  title: string | null;
  summary: string | null;
  raw_payload: string | null;
  metadata: string | null;
  relationship_role?: string | null;
};

type GrantKnowledgeApplicationRow = {
  id: string;
  canonical_key: string;
  title: string;
  applicant_name: string | null;
  normalized_status: string;
  requested_amount_usd: string | null;
  github_issue_number: string | null;
  github_issue_url: string | null;
  source_summary: string | null;
  github_labels: string | null;
  updated_at: string;
  sources: GrantKnowledgeSourceRecord[];
  forumTopics: GrantKnowledgeForumTopic[];
  decisionMentions: GrantKnowledgeDecisionMention[];
  reconciliationIssues: GrantKnowledgeReconciliationIssue[];
};

type GrantKnowledgeApplicationBaseRow = Omit<
  GrantKnowledgeApplicationRow,
  "sources" | "forumTopics" | "decisionMentions" | "reconciliationIssues"
>;

export type GrantKnowledgeForumPost = {
  postId: string;
  postNumber: number | null;
  replyToPostNumber: number | null;
  username: string | null;
  displayName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  plainText: string;
  permalink: string;
};

export type GrantKnowledgeForumTopic = {
  discourseTopicId: string | null;
  topicId: string;
  canonicalUrl: string;
  title: string;
  sourceRecordId: string | null;
  referencedUrls: string[];
  referencedPostNumbers: number[];
  relationshipRoles: string[];
  reportedPostCount: number | null;
  streamPostCount: number | null;
  coverageComplete: boolean;
  coverageCapped: boolean;
  dataSource: "normalized" | "legacy" | "merged";
  posts: GrantKnowledgeForumPost[];
};

type GrantKnowledgeNormalizedForumTopicRow = {
  discourse_topic_id: string;
  topic_id: string;
  canonical_url: string;
  title: string | null;
  source_record_id: string | null;
  referenced_urls: string;
  referenced_post_numbers: string;
  relationship_roles: string;
  reported_post_count: string | number | null;
  stream_post_count: string | number | null;
  coverage_complete: boolean;
  coverage_capped: boolean;
  posts: string;
};

type GrantKnowledgeNormalizedForumPostRow = {
  post_id: string;
  post_number: string | number | null;
  reply_to_post_number: string | number | null;
  username: string | null;
  display_name: string | null;
  created_at_source: string | null;
  updated_at_source: string | null;
  plain_text: string;
  permalink: string;
};

type GrantKnowledgeDecisionMention = {
  id: string;
  source_record_id: string;
  meeting_date: string | null;
  meeting_title: string;
  topic_url: string;
  candidate_title: string;
  normalized_decision: string;
  decision_text: string | null;
  rationale_text: string | null;
  speaker_notes: string | null;
  match_method: string;
  confidence: string;
};

type GrantKnowledgeReconciliationIssue = {
  id: string;
  issue_type: string;
  severity: string;
  summary: string;
  details: string;
  status: string;
  source_record_id: string | null;
  updated_at: string;
};

type KnowledgeDocumentInput = {
  documentKey: string;
  applicationId: string;
  sourceRecordId: string | null;
  documentKind: string;
  title: string;
  applicantName: string | null;
  sourceKind: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  normalizedStatus: string | null;
  requestedAmountUsd: string | null;
  content: string;
  contentHash: string;
  metadata: Record<string, unknown>;
};

export type GrantKnowledgeIndexResult = {
  ok: true;
  applicationsSeen: number;
  documentsIndexed: number;
  staleDocumentsRemoved: number;
};

export type GrantKnowledgeRefreshOptions = {
  applicationIds?: readonly string[];
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizedApplicationIds(applicationIds: readonly string[] | undefined) {
  if (!applicationIds?.length) {
    return null;
  }

  const normalized = applicationIds.map((applicationId) => applicationId.trim());
  const invalidApplicationId = normalized.find((applicationId) => !uuidPattern.test(applicationId));

  if (invalidApplicationId !== undefined) {
    throw new Error(`Invalid grant application ID: ${invalidApplicationId || "(empty)"}`);
  }

  return [...new Set(normalized)];
}

function parseJsonRecord(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string | null): unknown[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function numberOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveIntegerOrNull(value: unknown) {
  const parsed = numberOrNull(value);
  return parsed !== null && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function booleanValue(value: unknown) {
  return value === true || value === "true";
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForumText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hashContent(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function collectStringValues(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    const text = compactWhitespace(value);
    return text ? [text] : [];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringValues(entry, depth + 1));
  }

  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => {
      const values = collectStringValues(entry, depth + 1);
      return values.map((entryValue) => `${key}: ${entryValue}`);
    });
  }

  return [];
}

function uniqueLines(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const text = typeof value === "string" ? compactWhitespace(value) : "";

    if (!text || seen.has(text)) {
      continue;
    }

    seen.add(text);
    output.push(text);
  }

  return output;
}

function truncateContent(value: string) {
  if (value.length <= contentMaxChars) {
    return value;
  }

  return `${value.slice(0, contentMaxChars - 120)}\n\n[Content truncated for retrieval index.]`;
}

function sourceLabel(source: GrantKnowledgeSourceRecord) {
  return `${source.source_kind}:${source.source_id}`;
}

function buildApplicationSummaryDocument(row: GrantKnowledgeApplicationRow): KnowledgeDocumentInput {
  const sourceSummary = parseJsonRecord(row.source_summary);
  const githubLabelValues = collectStringValues(parseJsonArray(row.github_labels));
  const lines = uniqueLines([
    `Grant application: ${row.title}`,
    row.applicant_name ? `Applicant: ${row.applicant_name}` : null,
    `Status: ${row.normalized_status}`,
    githubLabelValues.length ? `GitHub labels: ${githubLabelValues.join(" | ")}` : null,
    row.requested_amount_usd ? `Requested amount USD: ${row.requested_amount_usd}` : null,
    row.github_issue_number ? `GitHub issue: ${row.github_issue_number}` : null,
    row.github_issue_url ? `GitHub URL: ${row.github_issue_url}` : null,
    ...collectStringValues(sourceSummary)
  ]);
  const content = truncateContent(lines.join("\n"));

  return {
    documentKey: `application:${row.id}:summary`,
    applicationId: row.id,
    sourceRecordId: null,
    documentKind: "application_summary",
    title: row.title,
    applicantName: row.applicant_name,
    sourceKind: "canonical_application",
    sourceId: row.canonical_key,
    sourceUrl: row.github_issue_url,
    normalizedStatus: row.normalized_status,
    requestedAmountUsd: row.requested_amount_usd,
    content,
    contentHash: hashContent(content),
    metadata: {
      generatedBy,
      canonicalKey: row.canonical_key,
      updatedAt: row.updated_at
    }
  };
}

type GrantKnowledgeGithubLabel = {
  name: string;
  category: string | null;
  status: string | null;
  milestoneNumber: number | null;
};

function githubLabels(value: string | null): GrantKnowledgeGithubLabel[] {
  return parseJsonArray(value)
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }

      const record = entry as Record<string, unknown>;
      const name = stringValue(record.name);

      return name
        ? {
            name,
            category: stringValue(record.category),
            status: stringValue(record.status),
            milestoneNumber: positiveIntegerOrNull(record.milestoneNumber)
          }
        : null;
    })
    .filter((entry): entry is GrantKnowledgeGithubLabel => Boolean(entry));
}

function comparisonOutcomeSignals(row: GrantKnowledgeApplicationRow) {
  const sourceSummary = parseJsonRecord(row.source_summary);
  const signalKeys = Object.keys(sourceSummary)
    .filter((key) => /(?:decision|status|paid|disburs|milestone|complete|outcome|result)/i.test(key))
    .sort((left, right) => left.localeCompare(right));
  const sourceSignals = signalKeys.flatMap((key) =>
    collectStringValues(sourceSummary[key]).map((value) => `${key}: ${value}`)
  );
  const workflowSignals = githubLabels(row.github_labels)
    .filter((label) =>
      ["milestone", "payment", "decision", "completion", "terminal"].includes(label.category ?? "") ||
      /(?:approved|declined|complete|cancelled|withdrawn|paid|payment)/i.test(label.status ?? label.name)
    )
    .map((label) => [
      label.name,
      label.status ? `status ${label.status}` : null,
      label.milestoneNumber ? `milestone ${label.milestoneNumber}` : null
    ].filter(Boolean).join(" — "));

  return {
    sourceSignals: uniqueLines(sourceSignals).slice(0, 12),
    workflowSignals: uniqueLines(workflowSignals).slice(0, 12),
    sourceSignalKeys: signalKeys
  };
}

function buildApplicationComparisonSummaryDocument(
  row: GrantKnowledgeApplicationRow
): KnowledgeDocumentInput {
  const signals = comparisonOutcomeSignals(row);
  const decisionLines = row.decisionMentions.flatMap((mention) => [
    `Committee decision${mention.meeting_date ? ` (${mention.meeting_date})` : ""}: ${mention.normalized_decision}`,
    mention.rationale_text ? `Committee rationale: ${mention.rationale_text}` : null,
    mention.decision_text ? `Recorded decision: ${mention.decision_text}` : null,
    `Decision source: ${mention.topic_url}`
  ]);
  const lines = uniqueLines([
    `Comparable grant: ${row.title}`,
    row.applicant_name ? `Applicant: ${row.applicant_name}` : null,
    `Recorded outcome/status: ${row.normalized_status}`,
    row.requested_amount_usd ? `Requested amount USD: ${row.requested_amount_usd}` : null,
    row.github_issue_url ? `Application source: ${row.github_issue_url}` : null,
    ...signals.workflowSignals.map((signal) => `Workflow outcome signal: ${signal}`),
    ...signals.sourceSignals.map((signal) => `Documented outcome signal: ${signal}`),
    ...decisionLines
  ]);
  const content = truncateContent(lines.join("\n"));

  return {
    documentKey: `application:${row.id}:comparison-summary`,
    applicationId: row.id,
    sourceRecordId: row.decisionMentions[0]?.source_record_id ?? null,
    documentKind: "application_comparison_summary",
    title: `${row.title} — comparison summary`,
    applicantName: row.applicant_name,
    sourceKind: "canonical_application",
    sourceId: row.canonical_key,
    sourceUrl: row.github_issue_url ?? row.decisionMentions[0]?.topic_url ?? null,
    normalizedStatus: row.normalized_status,
    requestedAmountUsd: row.requested_amount_usd,
    content,
    contentHash: hashContent(content),
    metadata: {
      generatedBy,
      canonicalKey: row.canonical_key,
      decisionMentionIds: row.decisionMentions.map((mention) => mention.id),
      decisionSourceUrls: [...new Set(row.decisionMentions.map((mention) => mention.topic_url))],
      outcomeSignalKeys: signals.sourceSignalKeys,
      workflowOutcomeSignals: signals.workflowSignals,
      updatedAt: row.updated_at
    }
  };
}

function buildSourceDocument(
  row: GrantKnowledgeApplicationRow,
  source: GrantKnowledgeSourceRecord
): KnowledgeDocumentInput {
  const raw = parseJsonRecord(source.raw_payload);
  const metadata = parseJsonRecord(source.metadata);
  const rawValues = collectStringValues(raw);
  const lines = uniqueLines([
    `Grant application: ${row.title}`,
    row.applicant_name ? `Applicant: ${row.applicant_name}` : null,
    `Status: ${row.normalized_status}`,
    row.requested_amount_usd ? `Requested amount USD: ${row.requested_amount_usd}` : null,
    `Source: ${sourceLabel(source)}`,
    source.source_url ? `Source URL: ${source.source_url}` : null,
    source.title ? `Source title: ${source.title}` : null,
    source.summary ? `Source summary: ${source.summary}` : null,
    ...rawValues
  ]);
  const content = truncateContent(lines.join("\n"));

  return {
    documentKey: `application:${row.id}:source:${source.id}`,
    applicationId: row.id,
    sourceRecordId: source.id,
    documentKind: source.source_kind,
    title: source.title ?? row.title,
    applicantName: row.applicant_name,
    sourceKind: source.source_kind,
    sourceId: source.source_id,
    sourceUrl: source.source_url,
    normalizedStatus: row.normalized_status,
    requestedAmountUsd: row.requested_amount_usd,
    content,
    contentHash: hashContent(content),
    metadata: {
      generatedBy,
      sourceMetadata: metadata,
      canonicalKey: row.canonical_key
    }
  };
}

function buildDecisionDocument(
  row: GrantKnowledgeApplicationRow,
  mention: GrantKnowledgeDecisionMention
): KnowledgeDocumentInput {
  const speakerNotes = collectStringValues(JSON.parse(mention.speaker_notes ?? "[]"));
  const lines = uniqueLines([
    `Grant application: ${row.title}`,
    row.applicant_name ? `Applicant: ${row.applicant_name}` : null,
    `Status: ${row.normalized_status}`,
    `Decision evidence: ZCG meeting minutes`,
    mention.meeting_date ? `Meeting date: ${mention.meeting_date}` : null,
    `Meeting title: ${mention.meeting_title}`,
    `Referenced proposal: ${mention.candidate_title}`,
    `Normalized decision: ${mention.normalized_decision}`,
    mention.decision_text ? `Decision text: ${mention.decision_text}` : null,
    mention.rationale_text ? `Committee rationale: ${mention.rationale_text}` : null,
    speakerNotes.length ? `Committee notes: ${speakerNotes.join(" | ")}` : null,
    `Match method: ${mention.match_method}`,
    `Match confidence: ${mention.confidence}`,
    `Source URL: ${mention.topic_url}`
  ]);
  const content = truncateContent(lines.join("\n"));

  return {
    documentKey: `application:${row.id}:decision:${mention.id}`,
    applicationId: row.id,
    sourceRecordId: mention.source_record_id,
    documentKind: "decision_minutes",
    title: `${row.title} - decision minutes`,
    applicantName: row.applicant_name,
    sourceKind: "forum_meeting_minutes",
    sourceId: mention.topic_url,
    sourceUrl: mention.topic_url,
    normalizedStatus: row.normalized_status,
    requestedAmountUsd: row.requested_amount_usd,
    content,
    contentHash: hashContent(content),
    metadata: {
      generatedBy,
      decisionMentionId: mention.id,
      normalizedDecision: mention.normalized_decision,
      meetingDate: mention.meeting_date,
      canonicalKey: row.canonical_key
    }
  };
}

function buildReconciliationIssueDocument(
  row: GrantKnowledgeApplicationRow,
  issue: GrantKnowledgeReconciliationIssue
): KnowledgeDocumentInput {
  const details = collectStringValues(parseJsonRecord(issue.details));
  const lines = uniqueLines([
    `Grant application: ${row.title}`,
    row.applicant_name ? `Applicant: ${row.applicant_name}` : null,
    `Status: ${row.normalized_status}`,
    `Open reconciliation issue: ${issue.issue_type}`,
    `Issue severity: ${issue.severity}`,
    `Issue workflow status: ${issue.status}`,
    `Issue summary: ${issue.summary}`,
    ...details
  ]);
  const content = truncateContent(lines.join("\n"));

  return {
    documentKey: `application:${row.id}:reconciliation:${issue.id}`,
    applicationId: row.id,
    sourceRecordId: issue.source_record_id,
    documentKind: "reconciliation_issue",
    title: `${row.title} - reconciliation issue`,
    applicantName: row.applicant_name,
    sourceKind: "reconciliation_issue",
    sourceId: issue.id,
    sourceUrl: null,
    normalizedStatus: row.normalized_status,
    requestedAmountUsd: row.requested_amount_usd,
    content,
    contentHash: hashContent(content),
    metadata: {
      generatedBy,
      reconciliationIssueId: issue.id,
      issueType: issue.issue_type,
      severity: issue.severity,
      workflowStatus: issue.status,
      updatedAt: issue.updated_at,
      canonicalKey: row.canonical_key
    }
  };
}

function forumCoordinates(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    const segments = parsed.pathname.split("/").filter(Boolean);

    if (parsed.hostname !== "forum.zcashcommunity.com" || segments[0] !== "t") {
      return null;
    }

    const slug = segments[1];
    const topicId = (segments[2] ?? slug)?.match(/^\d+/)?.[0] ?? null;

    if (!topicId || !slug) {
      return null;
    }

    const postNumber = positiveIntegerOrNull(segments[3]);
    const canonicalPath = slug === topicId ? `/t/${topicId}` : `/t/${slug}/${topicId}`;

    return {
      topicId,
      postNumber,
      canonicalUrl: `${parsed.protocol}//${parsed.host}${canonicalPath}`
    };
  } catch {
    return null;
  }
}

function forumPostPermalink(canonicalUrl: string, postNumber: number | null) {
  return postNumber ? `${canonicalUrl.replace(/\/+$/, "")}/${postNumber}` : canonicalUrl;
}

function forumPostKey(post: GrantKnowledgeForumPost) {
  return post.postId ? `id:${post.postId}` : `number:${post.postNumber ?? "unknown"}`;
}

function preferredForumPost(
  left: GrantKnowledgeForumPost | undefined,
  right: GrantKnowledgeForumPost
) {
  if (!left) {
    return right;
  }

  const leftUpdated = left.updatedAt ?? left.createdAt ?? "";
  const rightUpdated = right.updatedAt ?? right.createdAt ?? "";

  if (rightUpdated !== leftUpdated) {
    return rightUpdated > leftUpdated ? right : left;
  }

  if (right.plainText.length !== left.plainText.length) {
    return right.plainText.length > left.plainText.length ? right : left;
  }

  return right.permalink.localeCompare(left.permalink) < 0 ? right : left;
}

function sortedForumPosts(posts: GrantKnowledgeForumPost[]) {
  return [...posts].sort((left, right) =>
    (left.postNumber ?? Number.MAX_SAFE_INTEGER) - (right.postNumber ?? Number.MAX_SAFE_INTEGER) ||
    left.postId.localeCompare(right.postId)
  );
}

function legacyForumTopics(sources: GrantKnowledgeSourceRecord[]): GrantKnowledgeForumTopic[] {
  const topics = new Map<string, GrantKnowledgeForumTopic & { postMap: Map<string, GrantKnowledgeForumPost> }>();

  for (const source of sources.filter((entry) => chunkedForumSourceKinds.has(entry.source_kind))) {
    const raw = parseJsonRecord(source.raw_payload);
    const metadata = parseJsonRecord(source.metadata);
    const topic = raw.topic && typeof raw.topic === "object" && !Array.isArray(raw.topic)
      ? (raw.topic as Record<string, unknown>)
      : {};
    const rawUrl = stringValue(raw.url) ?? source.source_url ?? source.source_id;
    const coordinates = forumCoordinates(rawUrl);
    const topicId = String(positiveIntegerOrNull(metadata.topicId) ?? positiveIntegerOrNull(topic.id) ?? coordinates?.topicId ?? "");

    if (!topicId) {
      continue;
    }

    const canonicalUrl = coordinates?.canonicalUrl ?? `https://forum.zcashcommunity.com/t/${topicId}`;
    const current = topics.get(topicId) ?? {
      discourseTopicId: null,
      topicId,
      canonicalUrl,
      title: stringValue(topic.title) ?? stringValue(topic.fancyTitle ?? topic.fancy_title) ?? source.title ?? `Forum topic ${topicId}`,
      sourceRecordId: source.id,
      referencedUrls: [],
      referencedPostNumbers: [],
      relationshipRoles: [],
      reportedPostCount: null,
      streamPostCount: null,
      coverageComplete: false,
      coverageCapped: false,
      dataSource: "legacy" as const,
      posts: [],
      postMap: new Map<string, GrantKnowledgeForumPost>()
    };
    const referenceUrl = source.source_url ?? rawUrl;
    const referenceCoordinates = forumCoordinates(referenceUrl);

    if (referenceUrl) {
      current.referencedUrls.push(referenceUrl);
    }

    if (referenceCoordinates?.postNumber) {
      current.referencedPostNumbers.push(referenceCoordinates.postNumber);
    }

    if (source.relationship_role) {
      current.relationshipRoles.push(source.relationship_role);
    }

    current.sourceRecordId = [current.sourceRecordId, source.id]
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => left.localeCompare(right))[0] ?? null;
    current.reportedPostCount = Math.max(
      current.reportedPostCount ?? 0,
      positiveIntegerOrNull(metadata.postCountReported ?? metadata.post_count_reported) ??
        positiveIntegerOrNull(topic.postsCount ?? topic.posts_count) ??
        0
    ) || null;
    current.streamPostCount = Math.max(
      current.streamPostCount ?? 0,
      positiveIntegerOrNull(metadata.streamPostCount) ?? 0
    ) || null;
    current.coverageCapped ||= booleanValue(metadata.coverageCapped);

    const rawPosts = Array.isArray(raw.posts) ? raw.posts : [];

    for (const [postIndex, postValue] of rawPosts.entries()) {
      if (!postValue || typeof postValue !== "object" || Array.isArray(postValue)) {
        continue;
      }

      const post = postValue as Record<string, unknown>;
      const postNumber = positiveIntegerOrNull(post.postNumber ?? post.post_number);
      const postId = String(positiveIntegerOrNull(post.id ?? post.postId ?? post.post_id) ?? `legacy-${postNumber ?? postIndex + 1}`);
      const plainText = normalizeForumText(stringValue(post.plainText ?? post.plain_text) ?? "");

      if (!plainText) {
        continue;
      }

      const parsed: GrantKnowledgeForumPost = {
        postId,
        postNumber,
        replyToPostNumber: positiveIntegerOrNull(post.replyToPostNumber ?? post.reply_to_post_number),
        username: stringValue(post.username),
        displayName: stringValue(post.name ?? post.displayName ?? post.display_name),
        createdAt: stringValue(post.createdAt ?? post.created_at),
        updatedAt: stringValue(post.updatedAt ?? post.updated_at),
        plainText,
        permalink: stringValue(post.permalink) ?? forumPostPermalink(canonicalUrl, postNumber)
      };
      const key = forumPostKey(parsed);
      current.postMap.set(key, preferredForumPost(current.postMap.get(key), parsed));
    }

    topics.set(topicId, current);
  }

  return [...topics.values()]
    .map(({ postMap, ...topic }) => {
      const posts = sortedForumPosts([...postMap.values()]);
      const expectedPostCount = topic.streamPostCount ?? topic.reportedPostCount;

      return {
        ...topic,
        referencedUrls: [...new Set(topic.referencedUrls)].sort((left, right) => left.localeCompare(right)),
        referencedPostNumbers: [...new Set(topic.referencedPostNumbers)].sort((left, right) => left - right),
        relationshipRoles: [...new Set(topic.relationshipRoles)].sort((left, right) => left.localeCompare(right)),
        coverageComplete: expectedPostCount !== null && posts.length >= expectedPostCount,
        posts
      };
    })
    .sort((left, right) => Number(left.topicId) - Number(right.topicId));
}

function normalizedForumTopic(row: GrantKnowledgeNormalizedForumTopicRow): GrantKnowledgeForumTopic {
  const posts = parseJsonArray(row.posts)
    .map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }

      const post = value as Record<string, unknown>;
      const plainText = normalizeForumText(stringValue(post.plainText) ?? "");

      if (!plainText) {
        return null;
      }

      return {
        postId: String(post.postId ?? ""),
        postNumber: positiveIntegerOrNull(post.postNumber),
        replyToPostNumber: positiveIntegerOrNull(post.replyToPostNumber),
        username: stringValue(post.username),
        displayName: stringValue(post.displayName),
        createdAt: stringValue(post.createdAt),
        updatedAt: stringValue(post.updatedAt),
        plainText,
        permalink: stringValue(post.permalink) ?? forumPostPermalink(row.canonical_url, positiveIntegerOrNull(post.postNumber))
      } satisfies GrantKnowledgeForumPost;
    })
    .filter((post): post is GrantKnowledgeForumPost => Boolean(post));

  return {
    discourseTopicId: row.discourse_topic_id,
    topicId: row.topic_id,
    canonicalUrl: row.canonical_url,
    title: row.title ?? `Forum topic ${row.topic_id}`,
    sourceRecordId: row.source_record_id,
    referencedUrls: [...new Set(parseJsonArray(row.referenced_urls)
      .map((value) => stringValue(value))
      .filter((value): value is string => Boolean(value)))]
      .sort((left, right) => left.localeCompare(right)),
    referencedPostNumbers: [...new Set(parseJsonArray(row.referenced_post_numbers)
      .map(positiveIntegerOrNull)
      .filter((value): value is number => value !== null))]
      .sort((left, right) => left - right),
    relationshipRoles: [...new Set(parseJsonArray(row.relationship_roles)
      .map((value) => stringValue(value))
      .filter((value): value is string => Boolean(value)))]
      .sort((left, right) => left.localeCompare(right)),
    reportedPostCount: numberOrNull(row.reported_post_count),
    streamPostCount: numberOrNull(row.stream_post_count),
    coverageComplete: row.coverage_complete,
    coverageCapped: row.coverage_capped,
    dataSource: "normalized",
    posts: sortedForumPosts(posts)
  };
}

function mergeForumTopics(
  normalizedTopics: GrantKnowledgeForumTopic[],
  legacyTopics: GrantKnowledgeForumTopic[]
) {
  const merged = new Map(legacyTopics.map((topic) => [topic.topicId, topic]));

  for (const normalized of normalizedTopics) {
    const legacy = merged.get(normalized.topicId);

    if (!legacy) {
      merged.set(normalized.topicId, normalized);
      continue;
    }

    const posts = new Map(legacy.posts.map((post) => [forumPostKey(post), post]));

    for (const post of normalized.posts) {
      const key = forumPostKey(post);
      posts.set(key, preferredForumPost(posts.get(key), post));
    }

    const mergedPosts = normalized.coverageComplete
      ? normalized.posts
      : sortedForumPosts([...posts.values()]);
    const expectedPostCount = normalized.streamPostCount ?? normalized.reportedPostCount ?? legacy.streamPostCount ?? legacy.reportedPostCount;

    merged.set(normalized.topicId, {
      ...normalized,
      sourceRecordId: normalized.sourceRecordId ?? legacy.sourceRecordId,
      referencedUrls: [...new Set([...normalized.referencedUrls, ...legacy.referencedUrls])]
        .sort((left, right) => left.localeCompare(right)),
      referencedPostNumbers: [...new Set([
        ...normalized.referencedPostNumbers,
        ...legacy.referencedPostNumbers
      ])].sort((left, right) => left - right),
      relationshipRoles: [...new Set([...normalized.relationshipRoles, ...legacy.relationshipRoles])]
        .sort((left, right) => left.localeCompare(right)),
      reportedPostCount: normalized.reportedPostCount ?? legacy.reportedPostCount,
      streamPostCount: normalized.streamPostCount ?? legacy.streamPostCount,
      coverageComplete: normalized.coverageComplete || (
        !normalized.coverageCapped && expectedPostCount !== null && mergedPosts.length >= expectedPostCount
      ),
      coverageCapped: normalized.coverageCapped,
      dataSource: "merged",
      posts: mergedPosts
    });
  }

  return [...merged.values()].sort((left, right) => Number(left.topicId) - Number(right.topicId));
}

function splitForumPostText(value: string, maxChars = forumPostSegmentMaxChars) {
  const parts: string[] = [];
  let remaining = normalizeForumText(value);

  while (remaining.length > maxChars) {
    const minimumBoundary = Math.floor(maxChars * 0.6);
    const newlineBoundary = remaining.lastIndexOf("\n", maxChars);
    const spaceBoundary = remaining.lastIndexOf(" ", maxChars);
    const boundary = Math.max(newlineBoundary, spaceBoundary);
    const splitAt = boundary >= minimumBoundary ? boundary : maxChars;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}

type ForumPostSegment = {
  post: GrantKnowledgeForumPost;
  segmentNumber: number;
  segmentCount: number;
  rendered: string;
};

function forumPostSegments(post: GrantKnowledgeForumPost): ForumPostSegment[] {
  const parts = splitForumPostText(post.plainText);

  return parts.map((part, index) => {
    const author = post.displayName ?? post.username;
    const heading = [
      `Post #${post.postNumber ?? "?"}${author ? ` by ${compactWhitespace(author).slice(0, 160)}` : ""}`,
      post.createdAt ? `Posted: ${post.createdAt}` : null,
      post.replyToPostNumber ? `Reply to post #${post.replyToPostNumber}` : null,
      `Permalink: ${post.permalink.slice(0, 1000)}`,
      parts.length > 1 ? `Post part ${index + 1} of ${parts.length}` : null
    ].filter(Boolean).join("\n");

    return {
      post,
      segmentNumber: index + 1,
      segmentCount: parts.length,
      rendered: `${heading}\n${part}`
    };
  });
}

function forumDocuments(
  row: GrantKnowledgeApplicationRow,
  topic: GrantKnowledgeForumTopic
): KnowledgeDocumentInput[] {
  const commonMetadata = {
    generatedBy,
    canonicalKey: row.canonical_key,
    discourseTopicId: topic.discourseTopicId,
    topicId: topic.topicId,
    canonicalUrl: topic.canonicalUrl,
    referencedUrls: topic.referencedUrls,
    referencedPostNumbers: topic.referencedPostNumbers,
    relationshipRoles: topic.relationshipRoles,
    reportedPostCount: topic.reportedPostCount,
    streamPostCount: topic.streamPostCount,
    indexedPostCount: topic.posts.length,
    coverageComplete: topic.coverageComplete,
    coverageCapped: topic.coverageCapped,
    forumDataSource: topic.dataSource
  };
  const overviewContent = [
    `Forum discussion: ${topic.title}`,
    `Canonical topic: ${topic.canonicalUrl}`
  ].join("\n");
  const overview: KnowledgeDocumentInput = {
    documentKey: `application:${row.id}:forum:${topic.topicId}:overview`,
    applicationId: row.id,
    sourceRecordId: topic.sourceRecordId,
    documentKind: "forum_topic_overview",
    title: `${topic.title} — Forum discussion`,
    applicantName: row.applicant_name,
    sourceKind: "forum_link",
    sourceId: `forum:${topic.topicId}`,
    sourceUrl: topic.canonicalUrl,
    normalizedStatus: row.normalized_status,
    requestedAmountUsd: row.requested_amount_usd,
    content: overviewContent,
    contentHash: hashContent(overviewContent),
    metadata: commonMetadata
  };
  const numberedPosts = topic.posts.map((post, index) => ({
    post,
    effectivePostNumber: post.postNumber ?? index + 1
  }));
  const windows = new Map<number, GrantKnowledgeForumPost[]>();

  for (const { post, effectivePostNumber } of numberedPosts) {
    const windowStart = Math.floor((effectivePostNumber - 1) / forumPostsPerWindow) * forumPostsPerWindow + 1;
    windows.set(windowStart, [...(windows.get(windowStart) ?? []), post]);
  }

  const chunks: KnowledgeDocumentInput[] = [];

  for (const [windowStart, posts] of [...windows.entries()].sort(([left], [right]) => left - right)) {
    const windowEnd = windowStart + forumPostsPerWindow - 1;
    const base = `Forum topic: ${topic.title.slice(0, 500)}\nTopic URL: ${topic.canonicalUrl.slice(0, 1000)}`;
    const segmentGroups: ForumPostSegment[][] = [];
    let current: ForumPostSegment[] = [];
    let currentLength = base.length;

    for (const segment of posts.flatMap(forumPostSegments)) {
      const nextLength = currentLength + segment.rendered.length + 2;

      if (current.length && nextLength > forumChunkMaxChars) {
        segmentGroups.push(current);
        current = [];
        currentLength = base.length;
      }

      current.push(segment);
      currentLength += segment.rendered.length + 2;
    }

    if (current.length) {
      segmentGroups.push(current);
    }

    for (const [partIndex, segments] of segmentGroups.entries()) {
      const partNumber = partIndex + 1;
      const partCount = segmentGroups.length;
      const content = `${base}\n\n${segments.map((segment) => segment.rendered).join("\n\n")}`;
      const postNumbers = [...new Set(segments
        .map((segment) => segment.post.postNumber)
        .filter((value): value is number => value !== null))];
      const postIds = [...new Set(segments.map((segment) => segment.post.postId))];
      const postAnchors = [...new Map(segments.map((segment) => [
        segment.post.postId,
        {
          postId: segment.post.postId,
          postNumber: segment.post.postNumber,
          permalink: segment.post.permalink
        }
      ])).values()];
      const keySuffix = partCount > 1 ? `:part:${partNumber}` : "";

      chunks.push({
        documentKey: `application:${row.id}:forum:${topic.topicId}:posts:${windowStart}-${windowEnd}${keySuffix}`,
        applicationId: row.id,
        sourceRecordId: topic.sourceRecordId,
        documentKind: "forum_discussion_chunk",
        title: `${topic.title} — posts ${windowStart}–${windowEnd}${partCount > 1 ? `, part ${partNumber}` : ""}`,
        applicantName: row.applicant_name,
        sourceKind: "forum_link",
        sourceId: `forum:${topic.topicId}:posts:${windowStart}-${windowEnd}${keySuffix}`,
        sourceUrl: segments[0]?.post.permalink ?? topic.canonicalUrl,
        normalizedStatus: row.normalized_status,
        requestedAmountUsd: row.requested_amount_usd,
        content,
        contentHash: hashContent(content),
        metadata: {
          ...commonMetadata,
          windowStartPostNumber: windowStart,
          windowEndPostNumber: windowEnd,
          partNumber,
          partCount,
          postIds,
          postNumbers,
          postAnchors,
          postSegments: segments.map((segment) => ({
            postId: segment.post.postId,
            postNumber: segment.post.postNumber,
            segmentNumber: segment.segmentNumber,
            segmentCount: segment.segmentCount
          }))
        }
      });
    }
  }

  return [overview, ...chunks];
}

function documentsFromApplication(row: GrantKnowledgeApplicationRow): KnowledgeDocumentInput[] {
  return [
    buildApplicationSummaryDocument(row),
    buildApplicationComparisonSummaryDocument(row),
    ...row.sources
      .filter((source) => !chunkedForumSourceKinds.has(source.source_kind))
      .map((source) => buildSourceDocument(row, source)),
    ...row.forumTopics.flatMap((topic) => forumDocuments(row, topic)),
    ...row.decisionMentions.map((mention) => buildDecisionDocument(row, mention)),
    ...row.reconciliationIssues.map((issue) => buildReconciliationIssueDocument(row, issue))
  ];
}

export const knowledgeDocumentTestHooks = {
  buildApplicationComparisonSummaryDocument,
  documentsFromApplication,
  forumDocuments,
  legacyForumTopics,
  mergeForumTopics,
  splitForumPostText
};

function normalizedForumSchemaUnavailable(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const message = error instanceof Error ? error.message : String(error);

  return code === "42P01" || code === "42703" || /discourse_(?:topics|posts|topic_references).*does not exist/i.test(message);
}

async function fetchNormalizedForumTopicsForApplication(applicationId: string) {
  try {
    const result = await query<GrantKnowledgeNormalizedForumTopicRow>(
      `select dt.id::text as discourse_topic_id,
              dt.topic_id::text,
              dt.canonical_url,
              coalesce(dt.title, dt.fancy_title) as title,
              (
                select min(dtr_source.source_record_id::text)
                  from discourse_topic_references dtr_source
                  join source_links sl_source
                    on sl_source.source_record_id = dtr_source.source_record_id
                 where dtr_source.discourse_topic_id = dt.id
                   and sl_source.canonical_type = 'grant_application'
                   and sl_source.canonical_id = $1
              ) as source_record_id,
              (
                select coalesce(jsonb_agg(dtr_url.referenced_url order by dtr_url.referenced_url), '[]'::jsonb)::text
                  from discourse_topic_references dtr_url
                  join source_links sl_url
                    on sl_url.source_record_id = dtr_url.source_record_id
                 where dtr_url.discourse_topic_id = dt.id
                   and sl_url.canonical_type = 'grant_application'
                   and sl_url.canonical_id = $1
              ) as referenced_urls,
              (
                select coalesce(
                  jsonb_agg(dtr_post.referenced_post_number order by dtr_post.referenced_post_number)
                    filter (where dtr_post.referenced_post_number is not null),
                  '[]'::jsonb
                )::text
                  from discourse_topic_references dtr_post
                  join source_links sl_post
                    on sl_post.source_record_id = dtr_post.source_record_id
                 where dtr_post.discourse_topic_id = dt.id
                   and sl_post.canonical_type = 'grant_application'
                   and sl_post.canonical_id = $1
              ) as referenced_post_numbers,
              (
                select coalesce(
                  jsonb_agg(distinct sl_role.relationship_role)
                    filter (where sl_role.relationship_role is not null),
                  '[]'::jsonb
                )::text
                  from discourse_topic_references dtr_role
                  join source_links sl_role
                    on sl_role.source_record_id = dtr_role.source_record_id
                 where dtr_role.discourse_topic_id = dt.id
                   and sl_role.canonical_type = 'grant_application'
                   and sl_role.canonical_id = $1
              ) as relationship_roles,
              dt.reported_post_count::text,
              dt.stream_post_count::text,
              dt.coverage_complete,
              dt.coverage_capped,
              '[]'::jsonb::text as posts
         from discourse_topics dt
        where exists (
          select 1
            from discourse_topic_references dtr
            join source_links sl on sl.source_record_id = dtr.source_record_id
           where dtr.discourse_topic_id = dt.id
             and sl.canonical_type = 'grant_application'
             and sl.canonical_id = $1
        )
        order by dt.topic_id`,
      [applicationId]
    );

    const topics: GrantKnowledgeForumTopic[] = [];

    for (const row of result.rows) {
      const posts: Array<Record<string, unknown>> = [];
      let offset = 0;

      while (true) {
        const postResult = await query<GrantKnowledgeNormalizedForumPostRow>(
          `select post_id::text,
                  post_number::text,
                  reply_to_post_number::text,
                  username,
                  display_name,
                  created_at_source::text,
                  updated_at_source::text,
                  plain_text,
                  permalink
             from discourse_posts
            where discourse_topic_id = $1
              and deleted_at is null
            order by post_number nulls last, post_id
            limit $2 offset $3`,
          [row.discourse_topic_id, normalizedForumPostBatchSize, offset]
        );

        posts.push(...postResult.rows.map((post) => ({
          postId: post.post_id,
          postNumber: post.post_number,
          replyToPostNumber: post.reply_to_post_number,
          username: post.username,
          displayName: post.display_name,
          createdAt: post.created_at_source,
          updatedAt: post.updated_at_source,
          plainText: post.plain_text,
          permalink: post.permalink
        })));

        if (postResult.rows.length < normalizedForumPostBatchSize) {
          break;
        }

        offset += normalizedForumPostBatchSize;
      }

      topics.push(normalizedForumTopic({ ...row, posts: JSON.stringify(posts) }));
    }

    return topics;
  } catch (error) {
    if (normalizedForumSchemaUnavailable(error)) {
      return [];
    }

    throw error;
  }
}

async function fetchApplicationRows(applicationIds: readonly string[] | null = null) {
  const rows: GrantKnowledgeApplicationRow[] = [];
  let offset = 0;

  while (true) {
    const applicationFilter = applicationIds
      ? `where ga.id in (
           select selected.value::uuid
             from jsonb_array_elements_text($1::jsonb) as selected(value)
         )`
      : "";
    const limitParameter = applicationIds ? 2 : 1;
    const offsetParameter = applicationIds ? 3 : 2;
    const values = applicationIds
      ? [JSON.stringify(applicationIds), sourceRecordBatchSize, offset]
      : [sourceRecordBatchSize, offset];
    const result = await query<GrantKnowledgeApplicationBaseRow>(
      `select ga.id::text,
              ga.canonical_key,
              ga.title,
              ga.applicant_name,
              ga.normalized_status,
              ga.requested_amount_usd::text,
              ga.github_issue_number::text,
              ga.github_issue_url,
              ga.source_summary::text,
              (
                select coalesce(
                  jsonb_agg(
                    jsonb_build_object(
                      'name', gal.label_name,
                      'category', gal.label_category,
                      'status', gal.label_status,
                      'milestoneNumber', gal.milestone_number
                    )
                    order by gal.label_order, gal.label_name
                  ),
                  '[]'::jsonb
                )::text
                  from grant_application_github_labels gal
                 where gal.application_id = ga.id
              ) as github_labels,
              ga.updated_at::text
         from grant_applications ga
        ${applicationFilter}
        order by ga.updated_at desc, ga.id desc
        limit $${limitParameter} offset $${offsetParameter}`,
      values
    );

    for (const row of result.rows) {
      const [sources, normalizedForumTopics, decisionMentions, reconciliationIssues] = await Promise.all([
        fetchSourceRowsForApplication(row.id),
        fetchNormalizedForumTopicsForApplication(row.id),
        fetchDecisionRowsForApplication(row.id),
        fetchReconciliationIssuesForApplication(row.id)
      ]);

      rows.push({
        ...row,
        sources,
        forumTopics: mergeForumTopics(normalizedForumTopics, legacyForumTopics(sources)),
        decisionMentions,
        reconciliationIssues
      });
    }

    if (result.rows.length < sourceRecordBatchSize) {
      break;
    }

    offset += sourceRecordBatchSize;
  }

  return rows;
}

async function fetchReconciliationIssuesForApplication(applicationId: string) {
  const result = await query<GrantKnowledgeReconciliationIssue>(
    `select id::text,
            issue_type,
            severity,
            summary,
            details::text,
            status,
            source_record_id::text,
            updated_at::text
       from reconciliation_issues
      where canonical_type = 'grant_application'
        and canonical_id = $1
        and status in ('open', 'assigned')
      order by case severity when 'error' then 0 when 'warning' then 1 else 2 end,
               updated_at desc,
               id`,
    [applicationId]
  );

  return result.rows;
}

async function fetchDecisionRowsForApplication(applicationId: string) {
  const result = await query<GrantKnowledgeDecisionMention>(
    `select gdm.id::text,
            gds.source_record_id::text,
            gds.meeting_date::text,
            gds.title as meeting_title,
            gds.topic_url,
            gdm.candidate_title,
            gdm.normalized_decision,
            gdm.decision_text,
            gdm.rationale_text,
            gdm.speaker_notes::text,
            gdm.match_method,
            gdm.confidence::text
       from grant_decision_mentions gdm
       join grant_decision_sources gds on gds.id = gdm.decision_source_id
      where gdm.application_id = $1
        and gdm.review_status = 'accepted'
      order by gds.meeting_date desc nulls last, gdm.updated_at desc`,
    [applicationId]
  );

  return result.rows;
}

async function fetchSourceRowsForApplication(applicationId: string) {
  const rows: GrantKnowledgeSourceRecord[] = [];
  let offset = 0;

  while (true) {
    const result = await query<GrantKnowledgeSourceRecord>(
      `select sr.id::text,
              sr.source_kind,
              sr.source_id,
              sr.source_url,
              sr.title,
              sr.summary,
              case
                when sr.source_kind in ('forum_link', 'forum_meeting_minutes', 'forum_update_topic')
                  and sr.metadata->>'mirrorKind' = 'forum_topic'
                  then jsonb_build_object(
                    'url', sr.raw_payload->'url',
                    'jsonUrl', sr.raw_payload->'jsonUrl',
                    'topic', sr.raw_payload->'topic'
                  )::text
                else sr.raw_payload::text
              end as raw_payload,
              sr.metadata::text,
              sl.relationship_role
         from source_links sl
         join source_records sr on sr.id = sl.source_record_id
        where sl.canonical_type = 'grant_application'
          and sl.canonical_id = $1
        order by sr.source_kind, sr.source_id
        limit $2 offset $3`,
      [applicationId, sourceRecordBatchSize, offset]
    );

    rows.push(...result.rows);

    if (result.rows.length < sourceRecordBatchSize) {
      break;
    }

    offset += sourceRecordBatchSize;
  }

  return rows;
}

async function upsertKnowledgeDocuments(documents: KnowledgeDocumentInput[]) {
  for (const batch of chunkArray(documents, writeBatchSize)) {
    const payload = batch.map((document) => ({
      document_key: document.documentKey,
      application_id: document.applicationId,
      source_record_id: document.sourceRecordId,
      document_kind: document.documentKind,
      title: document.title,
      applicant_name: document.applicantName,
      source_kind: document.sourceKind,
      source_id: document.sourceId,
      source_url: document.sourceUrl,
      normalized_status: document.normalizedStatus,
      requested_amount_usd: document.requestedAmountUsd,
      content: document.content,
      content_hash: document.contentHash,
      metadata: document.metadata
    }));

    await query(
      `insert into grant_knowledge_documents (
         document_key,
         application_id,
         source_record_id,
         document_kind,
         title,
         applicant_name,
         source_kind,
         source_id,
         source_url,
         normalized_status,
         requested_amount_usd,
         content,
         content_hash,
         metadata,
         indexed_at,
         updated_at
       )
       select document_key,
              application_id,
              source_record_id,
              document_kind,
              title,
              applicant_name,
              source_kind,
              source_id,
              source_url,
              normalized_status,
              requested_amount_usd,
              content,
              content_hash,
              coalesce(metadata, '{}'::jsonb),
              now(),
              now()
         from jsonb_to_recordset($1::jsonb) as x(
           document_key text,
           application_id uuid,
           source_record_id uuid,
           document_kind text,
           title text,
           applicant_name text,
           source_kind text,
           source_id text,
           source_url text,
           normalized_status text,
           requested_amount_usd numeric,
           content text,
           content_hash text,
           metadata jsonb
         )
       on conflict (document_key)
       do update set application_id = excluded.application_id,
                     source_record_id = excluded.source_record_id,
                     document_kind = excluded.document_kind,
                     title = excluded.title,
                     applicant_name = excluded.applicant_name,
                     source_kind = excluded.source_kind,
                     source_id = excluded.source_id,
                     source_url = excluded.source_url,
                     normalized_status = excluded.normalized_status,
                     requested_amount_usd = excluded.requested_amount_usd,
                     content = excluded.content,
                     content_hash = excluded.content_hash,
                     metadata = excluded.metadata,
                     indexed_at = case
                       when grant_knowledge_documents.content_hash is distinct from excluded.content_hash
                         then now()
                       else grant_knowledge_documents.indexed_at
                     end,
                     updated_at = now()`,
      [JSON.stringify(payload)]
    );
  }
}

async function deleteStaleDocuments(
  documentKeys: string[],
  applicationIds: readonly string[] | null = null
) {
  if (applicationIds) {
    const result = await query(
      `delete from grant_knowledge_documents
        where metadata->>'generatedBy' = $1
          and application_id in (
            select selected.value::uuid
              from jsonb_array_elements_text($2::jsonb) as selected(value)
          )
          and not exists (
            select 1
              from jsonb_array_elements_text($3::jsonb) as retained(value)
             where retained.value = grant_knowledge_documents.document_key
          )`,
      [generatedBy, JSON.stringify(applicationIds), JSON.stringify(documentKeys)]
    );

    return result.rowCount ?? 0;
  }

  if (!documentKeys.length) {
    const result = await query(
      `delete from grant_knowledge_documents
        where metadata->>'generatedBy' = $1`,
      [generatedBy]
    );

    return result.rowCount ?? 0;
  }

  const result = await query(
    `delete from grant_knowledge_documents
      where metadata->>'generatedBy' = $1
        and document_key not in (
          select value
            from jsonb_array_elements_text($2::jsonb) as retained(value)
        )`,
    [generatedBy, JSON.stringify(documentKeys)]
  );

  return result.rowCount ?? 0;
}

export async function refreshGrantKnowledgeDocuments(
  options: GrantKnowledgeRefreshOptions = {}
): Promise<GrantKnowledgeIndexResult> {
  const applicationIds = normalizedApplicationIds(options.applicationIds);
  const applications = await fetchApplicationRows(applicationIds);
  const documents = [
    ...new Map(
      applications
        .flatMap((application) => documentsFromApplication(application))
        .map((document) => [document.documentKey, document])
    ).values()
  ];

  await upsertKnowledgeDocuments(documents);
  const staleDocumentsRemoved = await deleteStaleDocuments(
    documents.map((document) => document.documentKey),
    applicationIds
  );

  return {
    ok: true,
    applicationsSeen: applications.length,
    documentsIndexed: documents.length,
    staleDocumentsRemoved
  };
}
