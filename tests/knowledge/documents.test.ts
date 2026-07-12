import assert from "node:assert/strict";
import test from "node:test";
import {
  knowledgeDocumentTestHooks,
  type GrantKnowledgeForumTopic
} from "../../lib/knowledge/documents";

type ApplicationRow = Parameters<typeof knowledgeDocumentTestHooks.documentsFromApplication>[0];
type SourceRow = ApplicationRow["sources"][number];

function applicationRow(overrides: Partial<ApplicationRow> = {}): ApplicationRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    canonical_key: "github:123",
    title: "Community Privacy Project",
    applicant_name: "Example Team",
    normalized_status: "under_review",
    requested_amount_usd: "25000",
    github_issue_number: "123",
    github_issue_url: "https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues/123",
    source_summary: "{}",
    github_labels: "[]",
    updated_at: "2026-07-12T10:00:00.000Z",
    sources: [],
    forumTopics: [],
    decisionMentions: [],
    reconciliationIssues: [],
    ...overrides
  };
}

function forumSource({
  id,
  url,
  posts
}: {
  id: string;
  url: string;
  posts: Array<Record<string, unknown>>;
}): SourceRow {
  return {
    id,
    source_kind: "forum_link",
    source_id: url,
    source_url: url,
    title: "Community Privacy Project discussion",
    summary: "Forum discussion",
    raw_payload: JSON.stringify({
      url,
      topic: {
        id: 123,
        title: "Community Privacy Project discussion",
        slug: "community-privacy-project",
        postsCount: 6
      },
      posts
    }),
    metadata: JSON.stringify({
      mirrorKind: "forum_topic",
      topicId: 123,
      postCountReported: 6
    }),
    relationship_role: "primary_forum_thread"
  };
}

test("merges legacy Forum mirrors by topic, de-duplicates posts, and replaces monolithic documents", () => {
  const sources = [
    forumSource({
      id: "00000000-0000-4000-8000-000000000010",
      url: "https://forum.zcashcommunity.com/t/community-privacy-project/123",
      posts: [
        { id: 1001, postNumber: 1, username: "alice", plainText: "Opening proposal." },
        {
          id: 1002,
          postNumber: 2,
          username: "bob",
          updatedAt: "2026-07-10T10:00:00.000Z",
          plainText: "Initial objection."
        }
      ]
    }),
    forumSource({
      id: "00000000-0000-4000-8000-000000000011",
      url: "https://forum.zcashcommunity.com/t/community-privacy-project/123/20",
      posts: [
        {
          id: 1002,
          postNumber: 2,
          username: "bob",
          updatedAt: "2026-07-11T10:00:00.000Z",
          plainText: "Expanded objection with budget and governance detail."
        },
        { id: 1006, postNumber: 6, username: "alice", plainText: "Applicant response." }
      ]
    })
  ];
  const topics = knowledgeDocumentTestHooks.legacyForumTopics(sources);

  assert.equal(topics.length, 1);
  assert.equal(topics[0].canonicalUrl, "https://forum.zcashcommunity.com/t/community-privacy-project/123");
  assert.deepEqual(topics[0].referencedPostNumbers, [20]);
  assert.deepEqual(topics[0].relationshipRoles, ["primary_forum_thread"]);
  assert.deepEqual(topics[0].posts.map((post) => post.postNumber), [1, 2, 6]);
  assert.match(topics[0].posts[1].plainText, /Expanded objection/);

  const documents = knowledgeDocumentTestHooks.documentsFromApplication(applicationRow({
    sources,
    forumTopics: topics
  }));
  const forumDocuments = documents.filter((document) => document.sourceKind === "forum_link");

  assert.equal(documents.some((document) => document.documentKind === "forum_link"), false);
  assert.deepEqual(
    forumDocuments.map((document) => document.documentKind),
    ["forum_topic_overview", "forum_discussion_chunk", "forum_discussion_chunk"]
  );
  assert.deepEqual(
    forumDocuments.slice(1).map((document) => document.documentKey),
    [
      "application:00000000-0000-4000-8000-000000000001:forum:123:posts:1-5",
      "application:00000000-0000-4000-8000-000000000001:forum:123:posts:6-10"
    ]
  );
  assert.equal(
    forumDocuments[1].sourceUrl,
    "https://forum.zcashcommunity.com/t/community-privacy-project/123/1"
  );
  assert.match(forumDocuments[1].content, /Post #2 by bob/);
  assert.doesNotMatch(forumDocuments[1].content, /Grant application:/);
  assert.equal(forumDocuments[1].metadata.coverageComplete, false);
  assert.deepEqual(forumDocuments[1].metadata.relationshipRoles, ["primary_forum_thread"]);
  assert.deepEqual(forumDocuments[1].metadata.postNumbers, [1, 2]);
});

test("uses stable five-post windows and splits oversized posts without losing their anchor", () => {
  const longParagraph = Array.from({ length: 1800 }, (_, index) => `word${index}`).join(" ");
  const topic: GrantKnowledgeForumTopic = {
    discourseTopicId: "00000000-0000-4000-8000-000000000020",
    topicId: "456",
    canonicalUrl: "https://forum.zcashcommunity.com/t/large-discussion/456",
    title: "Large discussion",
    sourceRecordId: "00000000-0000-4000-8000-000000000021",
    referencedUrls: ["https://forum.zcashcommunity.com/t/large-discussion/456"],
    referencedPostNumbers: [],
    relationshipRoles: ["primary_forum_thread"],
    reportedPostCount: 1,
    streamPostCount: 1,
    coverageComplete: true,
    coverageCapped: false,
    dataSource: "normalized",
    posts: [{
      postId: "9001",
      postNumber: 3,
      replyToPostNumber: null,
      username: "longform",
      displayName: null,
      createdAt: "2026-07-12T10:00:00.000Z",
      updatedAt: null,
      plainText: longParagraph,
      permalink: "https://forum.zcashcommunity.com/t/large-discussion/456/3"
    }]
  };
  const chunks = knowledgeDocumentTestHooks
    .forumDocuments(applicationRow(), topic)
    .filter((document) => document.documentKind === "forum_discussion_chunk");

  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((document) => document.documentKey.includes(":posts:1-5:part:")));
  assert.ok(chunks.every((document) => document.content.length <= 6000));
  assert.ok(chunks.every((document) => document.sourceUrl?.endsWith("/3") === true));
  assert.deepEqual(
    chunks.map((document) => document.metadata.partNumber),
    Array.from({ length: chunks.length }, (_, index) => index + 1)
  );
  assert.ok(chunks.every((document) => document.metadata.partCount === chunks.length));
});

test("does not reintroduce deleted legacy posts after normalized Forum coverage is complete", () => {
  const baseTopic: GrantKnowledgeForumTopic = {
    discourseTopicId: null,
    topicId: "789",
    canonicalUrl: "https://forum.zcashcommunity.com/t/topic/789",
    title: "Topic",
    sourceRecordId: "00000000-0000-4000-8000-000000000040",
    referencedUrls: ["https://forum.zcashcommunity.com/t/topic/789"],
    referencedPostNumbers: [],
    relationshipRoles: ["primary_forum_thread"],
    reportedPostCount: 2,
    streamPostCount: 2,
    coverageComplete: false,
    coverageCapped: false,
    dataSource: "legacy",
    posts: [1, 2, 3].map((postNumber) => ({
      postId: String(7000 + postNumber),
      postNumber,
      replyToPostNumber: null,
      username: "participant",
      displayName: null,
      createdAt: null,
      updatedAt: null,
      plainText: `Legacy post ${postNumber}`,
      permalink: `https://forum.zcashcommunity.com/t/topic/789/${postNumber}`
    }))
  };
  const normalized: GrantKnowledgeForumTopic = {
    ...baseTopic,
    discourseTopicId: "00000000-0000-4000-8000-000000000041",
    coverageComplete: true,
    dataSource: "normalized",
    posts: baseTopic.posts.slice(0, 2)
  };
  const [merged] = knowledgeDocumentTestHooks.mergeForumTopics([normalized], [baseTopic]);

  assert.deepEqual(merged.posts.map((post) => post.postNumber), [1, 2]);
  assert.equal(merged.coverageComplete, true);
});

test("builds a compact deterministic comparison summary with decisions and outcome signals", () => {
  const row = applicationRow({
    normalized_status: "completed",
    source_summary: JSON.stringify({
      sheetPaidAmountUsd: 25000,
      historicalRegistryDecisionDate: "2025-05-04",
      sheetCategory: "Education"
    }),
    github_labels: JSON.stringify([
      { name: "Milestone 1 Complete", category: "milestone", status: "milestone_complete", milestoneNumber: 1 },
      { name: "Grant Complete", category: "completion", status: "grant_complete", milestoneNumber: null }
    ]),
    decisionMentions: [{
      id: "00000000-0000-4000-8000-000000000030",
      source_record_id: "00000000-0000-4000-8000-000000000031",
      meeting_date: "2025-05-04",
      meeting_title: "ZCG meeting",
      topic_url: "https://forum.zcashcommunity.com/t/zcg-meeting/999",
      candidate_title: "Community Privacy Project",
      normalized_decision: "approved",
      decision_text: "The committee approved the request.",
      rationale_text: "The milestones were concrete and the budget was proportionate.",
      speaker_notes: "[]",
      match_method: "exact",
      confidence: "1"
    }]
  });
  const first = knowledgeDocumentTestHooks.buildApplicationComparisonSummaryDocument(row);
  const second = knowledgeDocumentTestHooks.buildApplicationComparisonSummaryDocument(row);

  assert.equal(first.documentKind, "application_comparison_summary");
  assert.equal(first.contentHash, second.contentHash);
  assert.match(first.content, /Recorded outcome\/status: completed/);
  assert.match(first.content, /Workflow outcome signal: Milestone 1 Complete/);
  assert.match(first.content, /sheetPaidAmountUsd: 25000/);
  assert.match(first.content, /Committee rationale: The milestones were concrete/);
  assert.doesNotMatch(first.content, /sheetCategory/);
  assert.deepEqual(first.metadata.decisionMentionIds, ["00000000-0000-4000-8000-000000000030"]);
});
