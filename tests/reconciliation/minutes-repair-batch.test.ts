import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decisionMinutesTestHooks as hooks } from "../../lib/reconciliation/decision-minutes";

type RecordInput = Parameters<typeof hooks.decisionMentionsFromRecord>[0];
// First posts of public minutes, including their source URLs and actual HTML offsets.
const records = JSON.parse(readFileSync(new URL("../fixtures/decision-minutes-repair-batch.json", import.meta.url), "utf8")) as Record<string, RecordInput>;
const excluded = new Set(Object.keys(records));
function parsed(topic: string) { return hooks.decisionMentionsFromRecord({ ...records[topic], raw_payload: JSON.stringify(records[topic].raw_payload) }, excluded); }
function mention(topic: string, title: string) {
  const result = parsed(topic).mentions.find(m => m.candidateTitle.includes(title));
  assert.ok(result, `${topic}: missing ${title}`);
  return result;
}

test("recognizes recorded collective noun outcomes and short title-prefixed approvals", () => {
  assert.equal(mention("50764", "AI Knowledge Base").normalizedDecision, "declined");
  assert.equal(mention("50764", "Zingo:").normalizedDecision, "approved");
  assert.equal(mention("51137", "Network Monitoring").normalizedDecision, "declined");
  assert.equal(mention("48535", "Asset Swaps").normalizedDecision, "remains_open");
  assert.equal(mention("48651", "Asset Swaps").normalizedDecision, "approved");
  assert.equal(hooks.normalizeDecisionLine("ZCG votes to approve 4-1.")?.decision, "approved");
  assert.equal(hooks.normalizeDecisionLine("Unanimous approval.")?.decision, "approved");
  for (const line of ["Possible unanimous rejection", "Unanimous rejection of invalid transactions", "A member suggested unanimous approval", "If approved, the community will benefit."]) {
    assert.equal(hooks.normalizeDecisionLine(line), null, line);
  }
});

test("bounds nested proposals before unlinked sibling agenda headings", () => {
  const mlabs = mention("50764", "Lightwalletd RFP");
  assert.equal(mlabs.normalizedDecision, "unknown");
  assert.doesNotMatch(mlabs.rationaleText ?? "", /BTCPayServer|Maya/);
  const sdi = mention("50407", "Saas Development");
  assert.equal(sdi.normalizedDecision, "unknown");
  assert.doesNotMatch(sdi.rationaleText ?? "", /Ledger|Least Authority/);
  for (const topic of ["44277", "44370"]) {
    const bridge = mention(topic, "Elastic Subnet");
    assert.equal(bridge.normalizedDecision, "unknown");
    assert.doesNotMatch(bridge.rationaleText ?? "", /Zephyr|Compensation|Zcon4/);
  }
  assert.equal(mention("44472", "Elastic Subnet").normalizedDecision, "remains_open");
  assert.equal(mention("44577", "Elastic Subnet").normalizedDecision, "approved");
});

test("does not promote an inline organizational reference into a grant", () => {
  const result = parsed("46186").mentions;
  assert.equal(result.length, 3);
  assert.ok(result.every(m => m.candidateTitle !== "ZCG pledged"));
  assert.equal(mention("46186", "ZecHub").normalizedDecision, "approved");
});

test("repeated Forum discussion labels retain distinct legacy proposal boundaries and decisions", () => {
  const qedit = mention("40874", "Shielded Assets");
  const latino = mention("40874", "Latinoamérica");
  const eternity = mention("40874", "Eternity");
  assert.deepEqual([qedit.normalizedDecision, latino.normalizedDecision, eternity.normalizedDecision], ["approved", "declined", "declined"]);
  assert.match(qedit.rationaleText ?? "", /monthly/i);
  assert.doesNotMatch(qedit.rationaleText ?? "", /Voting Thresholds|Latinoamérica|Eternity|Brian also agreed to decline/);
  assert.doesNotMatch(eternity.rationaleText ?? "", /QEDIT|Latinoamérica/);
  assert.equal(new Set([qedit, latino, eternity].map(m => m.mentionKey)).size, 3);
  assert.equal(parsed("41020").mentions.length, 0, "Do not expand previously unrecognized formats in this repair");
});

test("preserves a later explicit vote's date and the earlier meeting's pending state", () => {
  assert.equal(mention("43759", "dismad8").normalizedDecision, "remains_open");
  const later = mention("43921", "ZecHub:");
  assert.equal(later.normalizedDecision, "approved");
  assert.equal(later.metadata.decisionDate, "2023-01-25");
  assert.match(later.decisionText ?? "", /Signal/);
  assert.equal(hooks.normalizeDecisionLine("Too early to vote. On 01/25, the committee unanimously approved the grant.")?.decision, "approved");
  assert.equal(hooks.normalizeDecisionLine("Too early to vote. On 01/25, the committee will vote to approve the grant if revised.")?.decision, "remains_open");
  assert.equal(hooks.normalizeDecisionLine("The grant was approved. On 01/25, the grant was withdrawn.")?.decision, "withdrawn");
  assert.equal(hooks.normalizeDecisionLine("The grant was approved. On 01/25, ZCG decided to keep the grant open.")?.decision, "remains_open");
  assert.equal(hooks.decisionOccurrenceDate("Update: on February 30, the grant was approved.", "2023-02-20"), null);
  assert.equal(hooks.decisionOccurrenceDate("Update: on January 3, the grant was approved.", "2023-12-28"), "2024-01-03");
  assert.equal(hooks.decisionOccurrenceDate("Later that week voted to reject this grant.", "2023-01-23"), null);
  assert.equal(hooks.decisionOccurrenceDate("Approved based on community feedback.", "2023-01-23"), "2023-01-23");
});

test("reviewed mention links cannot reassign another meeting in a reused topic", () => {
  const earlier = mention("44277", "Elastic Subnet");
  const later = { ...earlier, mentionKey: "later-2026-application" };
  const apps = ["old", "new"].map(id => ({ id, canonical_key: id, title: id, normalized_status: "approved", github_issue_number: null, github_issue_url: null }));
  const rows = apps.map(app => ({ application_id: app.id, canonical_key: app.id, title: app.title, normalized_status: "approved", source_record_id: `source-${app.id}`, source_kind: "forum_link", source_id: earlier.linkedSourceUrl!, source_url: earlier.linkedSourceUrl!, confidence: "1", relationship_role: "primary_forum_thread" }));
  const reviewed = { ...rows[0], source_kind: "decision_minutes_mention", source_id: earlier.mentionKey, source_url: earlier.mentionKey, relationship_role: "manual_source_decision" };
  const indexes = hooks.buildDirectMatchIndexes([...rows, reviewed], apps);
  const match = hooks.matchMention(earlier, indexes, apps);
  assert.equal(match.applicationId, "old");
  assert.equal(match.matchMethod, "reviewed_minutes_mention");
  assert.equal(hooks.matchMention(later, indexes, apps).applicationId, null);
  assert.equal(indexes.byPrimaryForumTopicId.size, 0);
  const conflict = hooks.buildDirectMatchIndexes([...rows, reviewed, { ...reviewed, application_id: "new", canonical_key: "new" }], apps);
  assert.equal(hooks.matchMention(earlier, conflict, apps).reviewStatus, "needs_review");
});

test("supporting and summary links cannot replace an application's own detailed rationale", () => {
  const fpoc = mention("55349", "F-PoC:");
  assert.match(fpoc.rationaleText ?? "", /Research prototype integrating/);
  assert.match(fpoc.rationaleText ?? "", /Gguy:/);
  const zinfra = mention("56384", "Zinfra");
  for (const speaker of ["Hanh", "Gguy", "Zerodartz"]) assert.ok(zinfra.rationaleText?.includes(speaker));
  const uniffi = mention("45307", "UniFFI");
  assert.match(uniffi.rationaleText ?? "", /Jason gave the background/);
  assert.doesNotMatch(uniffi.rationaleText ?? "", /Administration|Administrative|Brainstorm/);
  assert.match(mention("55555", "ChainSafe").rationaleText ?? "", /second year of maintenance/);
  assert.match(mention("48729", "eZcash").rationaleText ?? "", /Brian provided background/);
  const english = mention("52476", "Professional Development, English");
  // The source itself has reversed language descriptions; keep the exact
  // English heading's (101) section rather than the later Spanish (102) item.
  assert.match(english.rationaleText ?? "", /\(101\)/);
  assert.doesNotMatch(english.rationaleText ?? "", /\(102\)/);
});
