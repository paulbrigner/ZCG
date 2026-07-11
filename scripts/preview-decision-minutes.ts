import { query } from "../lib/db";
import { decisionMinutesTestHooks as hooks } from "../lib/reconciliation/decision-minutes";

type RawSourceRecord = {
  id: string;
  source_kind: string;
  source_id: string;
  source_url: string | null;
  title: string | null;
  summary: string | null;
  source_updated_at: string | null;
  raw_payload: string;
  metadata: string;
};

type Application = {
  id: string;
  canonical_key: string;
  title: string;
  normalized_status: string;
  github_issue_number: string | null;
  github_issue_url: string | null;
};

type SourceLink = {
  application_id: string;
  canonical_key: string;
  title: string;
  normalized_status: string;
  source_record_id: string;
  source_kind: string;
  source_id: string;
  source_url: string | null;
  confidence: string;
  relationship_role: string;
};

const terminalDecisions = new Set([
  "approved",
  "approved_async",
  "declined",
  "withdrawn",
  "cancelled",
  "filtered"
]);

async function fetchRecords() {
  const records: RawSourceRecord[] = [];

  for (let offset = 0; ; offset += 1) {
    const result = await query<RawSourceRecord>(
      `select id::text,
              source_kind,
              source_id,
              source_url,
              title,
              summary,
              source_updated_at::text,
              jsonb_build_object(
                'posts', jsonb_build_array(jsonb_build_object(
                  'plainText', raw_payload->'posts'->0->'plainText',
                  'links', raw_payload->'posts'->0->'links'
                )),
                'topic', raw_payload->'topic'
              )::text as raw_payload,
              metadata::text
         from source_records
        where source_kind = 'forum_meeting_minutes'
        order by source_updated_at desc nulls last, source_id
        limit 1 offset $1`,
      [offset]
    );
    records.push(...result.rows);

    if (result.rows.length < 1) {
      return records;
    }
  }
}

async function fetchSourceLinks() {
  const sourceLinks: SourceLink[] = [];

  for (let offset = 0; ; offset += 500) {
    const result = await query<SourceLink>(
      `select ga.id::text as application_id,
              ga.canonical_key,
              ga.title,
              ga.normalized_status,
              sr.id::text as source_record_id,
              sr.source_kind,
              sr.source_id,
              sr.source_url,
              sl.confidence::text,
              sl.relationship_role
         from source_links sl
         join source_records sr on sr.id = sl.source_record_id
         join grant_applications ga on ga.id = sl.canonical_id
        where sl.canonical_type = 'grant_application'
        order by sl.id
        limit 500 offset $1`,
      [offset]
    );
    sourceLinks.push(...result.rows);

    if (result.rows.length < 500) {
      return sourceLinks;
    }
  }
}

async function main() {
  const [records, applicationResult, sourceLinks] = await Promise.all([
    fetchRecords(),
    query<Application>(
      `select id::text,
              canonical_key,
              title,
              normalized_status,
              github_issue_number::text,
              github_issue_url
         from grant_applications`
    ),
    fetchSourceLinks()
  ]);
  const applications = applicationResult.rows;
  const applicationsById = new Map(applications.map((application) => [application.id, application]));
  const indexes = hooks.buildDirectMatchIndexes(sourceLinks, applications);
  const meetingTopicIds = new Set(
    records
      .map((record) => hooks.discourseTopicId(record.source_url ?? record.source_id))
      .filter((topicId): topicId is string => Boolean(topicId))
  );
  const linked: Parameters<typeof hooks.latestMentionGroups>[0] = [];
  const unlinkedWarnings: Array<Record<string, unknown>> = [];
  let mentionsParsed = 0;

  for (const record of records) {
    const parsed = hooks.decisionMentionsFromRecord(record, meetingTopicIds);

    if (!parsed.source) {
      continue;
    }

    mentionsParsed += parsed.mentions.length;

    for (const mention of parsed.mentions) {
      const matched = hooks.matchMention(mention, indexes, applications);

      if (!matched.applicationId) {
        if (
          hooks.isHighConfidenceDecisionMention(matched) &&
          (terminalDecisions.has(matched.normalizedDecision) || matched.normalizedDecision === "partial_approval")
        ) {
          unlinkedWarnings.push({
            meetingDate: parsed.source.meetingDate,
            candidateTitle: matched.candidateTitle,
            decision: matched.normalizedDecision,
            linkedSourceUrl: matched.linkedSourceUrl,
            matchMethod: matched.matchMethod
          });
        }

        continue;
      }

      const application = applicationsById.get(matched.applicationId);

      if (!application) {
        continue;
      }

      if (!hooks.isHighConfidenceDecisionMention(matched)) {
        continue;
      }

      linked.push({
        application,
        matched,
        mentionId: mention.mentionKey,
        source: parsed.source,
        sourceUpdatedAt: record.source_updated_at,
        sourceRecordId: record.id
      });
    }
  }

  const linkedWarnings: Array<Record<string, unknown>> = [];

  for (const group of hooks.latestMentionGroups(linked)) {
    const first = group[0];

    if (!first) {
      continue;
    }

    const decisions = new Set(
      group.map((mention) =>
        mention.matched.normalizedDecision === "approved_async"
          ? "approved"
          : mention.matched.normalizedDecision
      )
    );

    if (decisions.has("partial_approval")) {
      if (hooks.partialDecisionConflict(first.application.normalized_status)) {
        linkedWarnings.push({
          type: "partial_decision_status_review",
          application: first.application.title,
          canonicalStatus: first.application.normalized_status,
          meetingDate: first.source.meetingDate,
          decisions: [...decisions]
        });
      }

      continue;
    }

    if (!group.every((mention) => terminalDecisions.has(mention.matched.normalizedDecision))) {
      continue;
    }

    if (decisions.size > 1) {
      linkedWarnings.push({
        type: "ambiguous_latest_decision_minutes",
        application: first.application.title,
        canonicalStatus: first.application.normalized_status,
        meetingDate: first.source.meetingDate,
        decisions: [...decisions]
      });
      continue;
    }

    if (hooks.terminalDecisionConflict(first.matched.normalizedDecision, first.application.normalized_status)) {
      linkedWarnings.push({
        type: "decision_status_conflict",
        application: first.application.title,
        canonicalStatus: first.application.normalized_status,
        meetingDate: first.source.meetingDate,
        decision: first.matched.normalizedDecision,
        decisionText: first.matched.decisionText,
        decisionSection: first.matched.metadata.decisionSection,
        candidateTitle: first.matched.candidateTitle,
        matchMethod: first.matched.matchMethod
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        sourcesParsed: records.length,
        mentionsParsed,
        mentionsLinked: linked.length,
        warningCount: unlinkedWarnings.length + linkedWarnings.length,
        unlinkedWarnings,
        linkedWarnings
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
