import assert from "node:assert/strict";
import test from "node:test";
import { decisionMinutesTestHooks as hooks } from "../../lib/reconciliation/decision-minutes";

function recordFixture(params: {
  title?: string;
  plainText: string;
  fullText?: string;
  links: Array<{ href: string; text: string }>;
}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    source_kind: "forum_meeting_minutes",
    source_id: "https://forum.zcashcommunity.com/t/meeting/99999",
    source_url: "https://forum.zcashcommunity.com/t/meeting/99999",
    title: params.title ?? "Zcash Community Grants Meeting Minutes 7/24/23",
    summary: null,
    source_updated_at: "2023-07-25T00:00:00.000Z",
    raw_payload: JSON.stringify({
      fullText: params.fullText ?? params.plainText,
      posts: [
        {
          plainText: params.plainText,
          links: params.links.map((link) => ({
            ...link,
            normalizedUrl: link.href
          }))
        }
      ],
      topic: { id: 99999, title: params.title }
    }),
    metadata: JSON.stringify({ topicId: 99999 })
  };
}

test("normalizes explicit outcomes without treating context or voter lists as decisions", () => {
  assert.equal(hooks.normalizeDecisionLine("Mastering of ZKP - Not approved.")?.decision, "declined");
  assert.equal(hooks.normalizeDecisionLine("This proposal is not approved yet.")?.decision, "remains_open");
  assert.equal(
    hooks.normalizeDecisionLine("This should have been filtered and pointed to approved grants.")?.decision,
    "filtered"
  );
  assert.equal(
    hooks.normalizeDecisionLine("Milestone 1 approved, remainder of grant rejected")?.decision,
    "partial_approval"
  );
  assert.equal(
    hooks.normalizeDecisionLine("The grant will be canceled unless KYC is completed."),
    null
  );
  assert.equal(hooks.normalizeDecisionLine("Decline: Hanh, Zerodartz"), null);
  assert.equal(hooks.normalizeDecisionLine("We should not approve without a public comment."), null);
  assert.equal(hooks.normalizeDecisionLine("They should not decline but ask questions."), null);
  assert.equal(
    hooks.normalizeDecisionLine("Jason asked if they should reject it or set up a call."),
    null
  );
  assert.equal(
    hooks.normalizeDecisionLine("Approved 3 (A, B, C), Declined 2 (D, E)")?.decision,
    "approved"
  );
});

test("treats an approval as compatible with later lifecycle cancellation or withdrawal", () => {
  assert.equal(hooks.terminalDecisionConflict("approved", "cancelled"), false);
  assert.equal(hooks.terminalDecisionConflict("approved", "withdrawn"), false);
  assert.equal(hooks.terminalDecisionConflict("approved", "declined"), true);
});

test("treats filtered and declined as compatible negative dispositions", () => {
  assert.equal(hooks.terminalDecisionConflict("declined", "filtered"), false);
  assert.equal(hooks.terminalDecisionConflict("filtered", "declined"), false);
  assert.equal(hooks.terminalDecisionConflict("declined", "approved"), true);
});

test("treats a partial approval as reconciled by an approved funded record", () => {
  assert.equal(hooks.partialDecisionConflict("approved"), false);
  assert.equal(hooks.partialDecisionConflict("active"), false);
  assert.equal(hooks.partialDecisionConflict("completed"), false);
  assert.equal(hooks.partialDecisionConflict("declined"), true);
});

test("uses the first explicit key-takeaway outcome and ignores minority voter lines", () => {
  const section = [
    "Cypherpunk Policy Dinner",
    "Approved",
    "Approve: Gguy, Artkor, DecentralistDan",
    "Decline: Hanh, Zerodartz"
  ].join("\n\n");

  assert.equal(hooks.extractDecision(section, "forward").decision, "approved");
});

test("does not scan beyond the candidate's key-takeaway item", () => {
  const section = [
    "Zchurn's question on KYC and fiscal sponsorship",
    "Jason explained why fiscal sponsorship does not apply.",
    "Alex volunteered to write a response.",
    "A later unrelated request was approved."
  ].join("\n\n");

  assert.equal(hooks.extractDecision(section, "forward", 3).decision, "unknown");
});

test("anchors candidate sections and keeps adjacent proposal outcomes separate", () => {
  const dacadeUrl = "https://forum.zcashcommunity.com/t/dacade/45131";
  const uniffiUrl = "https://forum.zcashcommunity.com/t/uniffi/44904";
  const plainText = [
    "Zcash Community Grants Committee Meeting: July 24, 2023",
    "Key Takeaways:",
    "Open Grant Proposals",
    "Dacade: Peer-to-peer learning community - ZCG will vote on this at their next meeting, as it was too early to vote.",
    "UniFFI Library Addenda - The proposal was approved.",
    "Open Grant Proposals",
    "Dacade: Peer-to-peer learning community - The grant was posted four days ago, so it is too early to vote.",
    "UniFFI Library Addenda - The committee voted to approve this grant."
  ].join("\n\n");
  const parsed = hooks.decisionMentionsFromRecord(
    recordFixture({
      plainText,
      links: [
        { href: dacadeUrl, text: "Dacade: Peer-to-peer learning community" },
        { href: uniffiUrl, text: "UniFFI Library Addenda" }
      ]
    })
  );
  const byTitle = new Map(parsed.mentions.map((mention) => [mention.candidateTitle, mention]));

  assert.equal(byTitle.get("Dacade: Peer-to-peer learning community")?.normalizedDecision, "remains_open");
  assert.equal(byTitle.get("UniFFI Library Addenda")?.normalizedDecision, "approved");
});

test("ignores reply text when parsing a meeting decision", () => {
  const url = "https://forum.zcashcommunity.com/t/n3thack/44444";
  const firstPost = [
    "Zcash Community Grants Meeting: February 6, 2023",
    "Key Takeaways:",
    "Open Grant Proposals",
    "N3THACK - ZCG rejected this grant."
  ].join("\n\n");
  const parsed = hooks.decisionMentionsFromRecord(
    recordFixture({
      title: "Zcash Community Grants Meeting Minutes 2/6/23",
      plainText: firstPost,
      fullText: `${firstPost}\n\nPost #2\nI withdrawn my zec before they suspend it.`,
      links: [{ href: url, text: "N3THACK" }]
    })
  );

  assert.equal(parsed.mentions[0]?.normalizedDecision, "declined");
});

test("takes the meeting date from the title before unrelated body dates", () => {
  assert.equal(
    hooks.extractMeetingDate("ZCG Meeting Minutes 1/23/23", "A follow-up happened on March 18, 2023."),
    "2023-01-23"
  );
  assert.equal(hooks.extractMeetingDate("Meeting 2/30/23", "No valid date"), null);
});

test("extracts stable Discourse topic identity", () => {
  assert.equal(hooks.discourseTopicId("https://forum.zcashcommunity.com/t/original-slug/12345"), "12345");
  assert.equal(hooks.discourseTopicId("https://forum.zcashcommunity.com/t/new-slug/12345/8?x=1#y"), "12345");
  assert.equal(hooks.discourseTopicId("https://forum.zcashcommunity.com/t/12345/8"), "12345");
  assert.equal(hooks.discourseTopicId("https://forum.zcashcommunity.com.evil.test/t/x/12345"), null);
  assert.equal(hooks.discourseTopicId("https://forum.zcashcommunity.com/c/grants/8"), null);
});

test("primary forum source wins over a supporting reference and post suffixes still match", () => {
  const url = "https://forum.zcashcommunity.com/t/official-shielded-support/45965";
  const applications = [
    {
      id: "app-primary",
      canonical_key: "github:1",
      title: "Official Shielded Support",
      normalized_status: "approved",
      github_issue_number: null,
      github_issue_url: null
    },
    {
      id: "app-supporting",
      canonical_key: "github:2",
      title: "Ledger Live Support",
      normalized_status: "declined",
      github_issue_number: null,
      github_issue_url: null
    }
  ];
  const rows = [
    {
      application_id: "app-primary",
      canonical_key: "github:1",
      title: "Official Shielded Support",
      normalized_status: "approved",
      source_record_id: "source-primary",
      source_kind: "forum_link",
      source_id: url,
      source_url: url,
      confidence: "1",
      relationship_role: "primary_forum_thread"
    },
    {
      application_id: "app-supporting",
      canonical_key: "github:2",
      title: "Ledger Live Support",
      normalized_status: "declined",
      source_record_id: "source-supporting",
      source_kind: "forum_link",
      source_id: url,
      source_url: url,
      confidence: "1",
      relationship_role: "supporting_forum_reference"
    }
  ];
  const indexes = hooks.buildDirectMatchIndexes(rows, applications);
  const matched = hooks.matchMention(
    {
      mentionKey: "mention",
      linkedSourceUrl: `${url}/7`,
      candidateTitle: "Shielded Support for Zcash in Ledger",
      normalizedDecision: "approved",
      decisionText: "Approved",
      rationaleText: null,
      speakerNotes: [],
      contentHash: "hash",
      metadata: {}
    },
    indexes,
    applications
  );

  assert.equal(matched.applicationId, "app-primary");
  assert.equal(matched.matchMethod, "primary_forum_topic_id");
  assert.equal(matched.linkedSourceRecordId, "source-primary");
});

test("does not choose arbitrarily between two primary applications", () => {
  const url = "https://forum.zcashcommunity.com/t/ambiguous/12345";
  const applications = [
    {
      id: "app-a",
      canonical_key: "a",
      title: "First unrelated title",
      normalized_status: "approved",
      github_issue_number: null,
      github_issue_url: null
    },
    {
      id: "app-b",
      canonical_key: "b",
      title: "Second unrelated title",
      normalized_status: "declined",
      github_issue_number: null,
      github_issue_url: null
    }
  ];
  const rows = applications.map((application, index) => ({
    application_id: application.id,
    canonical_key: application.canonical_key,
    title: application.title,
    normalized_status: application.normalized_status,
    source_record_id: `source-${index}`,
    source_kind: "forum_link",
    source_id: url,
    source_url: url,
    confidence: "1",
    relationship_role: "primary_forum_thread"
  }));
  const indexes = hooks.buildDirectMatchIndexes(rows, applications);
  const matched = hooks.matchMention(
    {
      mentionKey: "mention",
      linkedSourceUrl: url,
      candidateTitle: "No matching canonical title",
      normalizedDecision: "approved",
      decisionText: "Approved",
      rationaleText: null,
      speakerNotes: [],
      contentHash: "hash",
      metadata: {}
    },
    indexes,
    applications
  );

  assert.equal(matched.applicationId, null);
  assert.equal(matched.matchMethod, "ambiguous_direct_source_url");
});
