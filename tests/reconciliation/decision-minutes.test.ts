import assert from "node:assert/strict";
import test from "node:test";
import { decisionMinutesTestHooks as hooks } from "../../lib/reconciliation/decision-minutes";

function recordFixture(params: {
  title?: string;
  plainText: string;
  fullText?: string;
  cookedHtml?: string;
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
          cookedHtml: params.cookedHtml,
          links: params.links.map((link) => ({
            ...link,
            normalizedUrl: link.href,
            ...(params.cookedHtml ? { htmlOffset: params.cookedHtml.indexOf(`<a href="${link.href}">`) } : {})
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

test("keeps rejection references with their three applications instead of inventing another application", () => {
  const titles = ["Education Initiative For Latin America", "Auto Failover Toolkit V2", "Monitoring and Observability Platform for Zcash Nodes"];
  const urls = titles.map((_, i) => `https://forum.zcashcommunity.com/t/proposal/${53010 + i}`);
  const policy = "https://forum.zcashcommunity.com/t/zcg-use-of-ai-and-enforcement/53408";
  const plainText = ["ZCG Meeting: November 24, 2025", "Key Takeaways:", "Open Grants",
    ...titles.flatMap(title => [title, "Declined"]), "Open Grant Proposals",
    ...titles.flatMap(title => [title, "Project description.", "Rejected, see Forum post"])
  ].join("\n\n");
  // Include the same supporting policy reference beneath each real grant.
  const cookedHtml = `<p>Open Grant Proposals</p><ul>${titles.map((title, i) =>
    `<li><p><a href="${urls[i]}">${title}</a></p><ul><li>Project description.<ul><li><a href="${policy}">Rejected, see Forum post</a></li></ul></li></ul></li>`
  ).join("")}</ul>`;
  const fixture = recordFixture({ plainText, cookedHtml, links: [
    ...titles.map((text, i) => ({href: urls[i], text})),
    {href: policy, text: "Rejected, see Forum post"}
  ] });
  const originalPayload = fixture.raw_payload;
  const parsed = hooks.decisionMentionsFromRecord(fixture);
  assert.deepEqual(parsed.mentions.map(m => [m.candidateTitle, m.normalizedDecision]), titles.map(title => [title, "declined"]));
  assert.ok(parsed.mentions.every(m => m.rationaleText?.includes("Rejected, see Forum post")));
  assert.equal(fixture.raw_payload, originalPayload);
});

test("uses list ancestry to keep arbitrary supporting references inside the grant discussion", () => {
  const grant = "https://forum.zcashcommunity.com/t/grant/55501";
  const background = "https://forum.zcashcommunity.com/t/background/55502";
  const cookedHtml = `\n <p>Open Grant Proposals</p><ul><li><a href="${grant}">Privacy Tool</a><ul><li><a href="${background}">Community feedback</a><p>The committee rejected this proposal.</p></li></ul></li></ul>`;
  const parsed = hooks.decisionMentionsFromRecord(recordFixture({
    cookedHtml,
    plainText: "ZCG Meeting\nOpen Grant Proposals\nPrivacy Tool\nCommunity feedback\nThe committee rejected this proposal.",
    links: [{href: grant, text: "Privacy Tool"}, {href: background, text: "Community feedback"}]
  }));
  assert.equal(parsed.mentions.length, 1);
  assert.equal(parsed.mentions[0]?.candidateTitle, "Privacy Tool");
  assert.equal(parsed.mentions[0]?.normalizedDecision, "declined");
  assert.match(parsed.mentions[0]?.rationaleText ?? "", /Community feedback/);
});

test("handles decision reference labels in older snapshots without HTML", () => {
  const parsed = hooks.decisionMentionsFromRecord(recordFixture({
    plainText: "ZCG Meeting\nOpen Grant Proposals\nPrivacy Tool\nRejected, see Forum post",
    links: [
      {href: "https://forum.zcashcommunity.com/t/grant/55501", text: "Privacy Tool"},
      {href: "https://forum.zcashcommunity.com/t/policy/55502", text: "Rejected, see Forum post"}
    ]
  }));
  assert.deepEqual(parsed.mentions.map(m => [m.candidateTitle, m.normalizedDecision]), [["Privacy Tool", "declined"]]);
});

test("keeps an async outcome on the application when an older snapshot links the outcome separately", () => {
  const parsed = hooks.decisionMentionsFromRecord(recordFixture({
    plainText: "ZCG Meeting\nKey Takeaways:\nOpen Grants\nPrivacy Tool\nDeclined asnyc",
    links: [
      {href: "https://forum.zcashcommunity.com/t/grant/55501", text: "Privacy Tool"},
      {href: "https://forum.zcashcommunity.com/t/grant/55501/2", text: "Declined asnyc"}
    ]
  }));
  assert.deepEqual(parsed.mentions.map(m => [m.candidateTitle, m.normalizedDecision]), [["Privacy Tool", "declined"]]);
});

test("retains legacy Forum discussion links that identify the application", () => {
  const parsed = hooks.decisionMentionsFromRecord(recordFixture({
    plainText: "ZOMG Meeting\nOpen Grant Proposals\nEternity Protocol\nForum discussion\nThe committee rejected this proposal.",
    links: [{href: "https://forum.zcashcommunity.com/t/proposal-to-fund-eternity-protocol/40822", text: "Forum discussion"}]
  }));
  assert.equal(parsed.mentions.length, 1);
  assert.equal(parsed.mentions[0]?.normalizedDecision, "declined");
});

test("separates administrative follow-ups without losing real grant amendments or named RFP responses", () => {
  const titles = ["Main Proposal", "FPF/ZecHub Bounty Grant", "RFP – Node Infrastructure Response", "RFP posted on the forum"];
  const parsed = hooks.decisionMentionsFromRecord(recordFixture({
    plainText: ["ZCG Meeting", "Key Takeaways:", "Open Grants", "Main Proposal", "Remains open",
      "Brainstorm Session Follow-Ups", "FPF/ZecHub Bounty Grant - ZCG approved this proposal.",
      "Open Grant Proposals", "Main Proposal", "Needs further investigation.",
      "Brainstorm Session Follow-Ups", "FPF/ZecHub Bounty Grant", "ZCG voted via Signal to approve 550 ZEC.",
      "RFP – Node Infrastructure Response", "The proposal was approved.",
      "Community Notetaker", "RFP posted on the forum", "Responses due March 14th", "Three responses received thus far."
    ].join("\n\n"),
    links: titles.map((text, i) => ({href: `https://forum.zcashcommunity.com/t/topic/${55600+i}`, text}))
  }));
  const byTitle = new Map(parsed.mentions.map(m => [m.candidateTitle, m]));
  assert.deepEqual([...byTitle.keys()], titles.slice(0, 3));
  assert.equal(byTitle.get("FPF/ZecHub Bounty Grant")?.normalizedDecision, "approved");
  assert.equal(byTitle.get("RFP – Node Infrastructure Response")?.normalizedDecision, "approved");
  assert.equal(byTitle.get("Main Proposal")?.normalizedDecision, "remains_open");
  assert.doesNotMatch(byTitle.get("Main Proposal")?.rationaleText ?? "", /Brainstorm|550 ZEC|Notetaker/);
});

test("does not borrow a later administrative rejection or a previous meeting's approval", () => {
  const parsed = hooks.decisionMentionsFromRecord(recordFixture({
    plainText: ["ZCG Meeting", "Open Grant Proposals", "UniFFI Library Addendum",
      "Last meeting, four members of the committee voted to approve this grant.",
      "The committee will discuss the revised proposal at their next brainstorm meeting.",
      "Brainstorm Session Follow Ups", "Promotional Merch Request", "The committee rejected this request."
    ].join("\n\n"),
    links: [{href: "https://forum.zcashcommunity.com/t/uniffi/44904", text: "UniFFI Library Addendum"}]
  }));
  assert.equal(parsed.mentions[0]?.normalizedDecision, "unknown");
  assert.doesNotMatch(parsed.mentions[0]?.rationaleText ?? "", /Promotional Merch|rejected/);
});

test("retains grouped title-only proposals when administrative follow-ups are removed", () => {
  const titles = ["ZecHub 2025: An Education Hub For Zcash", "Zcash Brazil 2025", "Zcash Global en Espanol 2025", "ZK AV Club Community Support"];
  const parsed = hooks.decisionMentionsFromRecord(recordFixture({
    title: "Zcash Community Grants Meeting Minutes 12/9/2024",
    plainText: ["ZCG Meeting", "Key Takeaways:", "Open Grants",
      "The following grants have been tabled until January 2025:", ...titles,
      "Open Grant Proposals", "2025 Community Funding Programs Grants - ZCG will table these decisions until the new committee is appointed.",
      ...titles, "Brainstorm Session Follow-Ups", "GitHub Migration - The submission form is now available."
    ].join("\n\n"),
    links: titles.map((text, i) => ({href: `https://forum.zcashcommunity.com/t/proposal/${55700+i}`, text}))
  }));
  assert.deepEqual(parsed.mentions.map(m=>m.candidateTitle),titles);
  assert.ok(parsed.mentions.every(m=>m.normalizedDecision==='unknown' && m.rationaleText===null));
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

test("reviewed source decisions override inferred links without a mirrored source record", () => {
  const url = "https://forum.zcashcommunity.com/t/proposal/45599";
  const applications = [
    {
      id: "app-reviewed",
      canonical_key: "sheet:reviewed",
      title: "Reviewed application",
      normalized_status: "declined",
      github_issue_number: null,
      github_issue_url: null
    },
    {
      id: "app-inferred",
      canonical_key: "sheet:inferred",
      title: "Inferred application",
      normalized_status: "approved",
      github_issue_number: null,
      github_issue_url: null
    }
  ];
  const rows = [
    {
      application_id: "app-inferred",
      canonical_key: "sheet:inferred",
      title: "Inferred application",
      normalized_status: "approved",
      source_record_id: "source-inferred",
      source_kind: "forum_link",
      source_id: url,
      source_url: url,
      confidence: "1",
      relationship_role: "primary_forum_thread"
    },
    {
      application_id: "app-reviewed",
      canonical_key: "sheet:reviewed",
      title: "Reviewed application",
      normalized_status: "declined",
      source_record_id: "",
      source_kind: "forum_link",
      source_id: url,
      source_url: url,
      confidence: "1",
      relationship_role: "manual_source_decision"
    }
  ];
  const indexes = hooks.buildDirectMatchIndexes(rows, applications);
  const matched = hooks.matchMention(
    {
      mentionKey: "mention",
      linkedSourceUrl: url,
      candidateTitle: "Proposal",
      normalizedDecision: "declined",
      decisionText: "Declined",
      rationaleText: null,
      speakerNotes: [],
      contentHash: "hash",
      metadata: {}
    },
    indexes,
    applications
  );

  assert.equal(matched.applicationId, "app-reviewed");
  assert.equal(matched.matchMethod, "direct_source_url");
  assert.equal(matched.linkedSourceRecordId, null);
});

test("builds an exact, idempotent status assertion only from accepted key-takeaway decisions", () => {
  const application = {
    id: "00000000-0000-4000-8000-000000000021",
    canonical_key: "github:ZcashCommunityGrants/zcashcommunitygrants#351",
    title: "Example application",
    normalized_status: "approved",
    github_issue_number: "351",
    github_issue_url: "https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues/351"
  };
  const mention = {
    mentionKey: "meeting:example",
    linkedSourceUrl: application.github_issue_url,
    candidateTitle: application.title,
    normalizedDecision: "approved_async",
    decisionText: "Approved asynchronously",
    rationaleText: null,
    speakerNotes: [],
    contentHash: "mention-content-hash",
    metadata: { decisionSection: "key_takeaways" },
    applicationId: application.id,
    linkedSourceRecordId: null,
    matchMethod: "direct_source_url",
    confidence: 0.86,
    reviewStatus: "accepted"
  };
  const source = {
    sourceRecordId: "00000000-0000-4000-8000-000000000022",
    forumTopicId: 123,
    topicUrl: "https://forum.zcashcommunity.com/t/meeting/123",
    title: "ZCG meeting",
    meetingDate: "2026-07-14",
    contentHash: "source-content-hash",
    metadata: {}
  };
  const record = {
    id: source.sourceRecordId,
    source_kind: "forum_meeting_minutes",
    source_id: source.topicUrl,
    source_url: source.topicUrl,
    checksum_sha256: "source-checksum",
    title: source.title,
    summary: null,
    source_updated_at: "2026-07-14T18:00:00.000Z",
    raw_payload: "{}",
    metadata: "{}"
  };
  const assertion = hooks.exactDecisionStatusAssertion(
    application as never,
    mention as never,
    "00000000-0000-4000-8000-000000000023",
    source as never,
    record as never
  );

  assert.ok(assertion);
  assert.equal(assertion.toStatus, "approved");
  assert.equal(assertion.effectiveDate, "2026-07-14");
  assert.equal(
    assertion.idempotencyKey,
    "decision-mention:00000000-0000-4000-8000-000000000023:mention-content-hash"
  );

  assert.equal(
    hooks.exactDecisionStatusAssertion(
      application as never,
      { ...mention, metadata: { decisionSection: "detailed_minutes" } } as never,
      "00000000-0000-4000-8000-000000000023",
      source as never,
      record as never
    ),
    null
  );
  assert.equal(
    hooks.exactDecisionStatusAssertion(
      application as never,
      { ...mention, confidence: 0.85 } as never,
      "00000000-0000-4000-8000-000000000023",
      source as never,
      record as never
    ),
    null
  );
});
