import crypto from "node:crypto";
import type pg from "pg";
import { parseForumTopicReference } from "./forum";
import type { SourceMirrorRecord } from "./types";

const forumSourceKinds = ["forum_link", "forum_meeting_minutes", "forum_update_topic"];

type JsonRecord = Record<string, unknown>;

export type NormalizedForumStoreCounts = {
  recordsSeen: number;
  recordsEligible: number;
  topicsUpserted: number;
  completeTopics: number;
  postsUpserted: number;
  postsMarkedDeleted: number;
  referencesUpserted: number;
};

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown) {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }

  if (typeof value !== "string" || !value.trim() || !/^-?\d+$/.test(value.trim())) {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function checksum(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedRecord(record: SourceMirrorRecord) {
  if (!forumSourceKinds.includes(record.sourceKind)) {
    return null;
  }

  const raw = recordValue(record.rawPayload);
  const topic = recordValue(raw.topic);
  const topicId = numberValue(topic.id);
  const reference = parseForumTopicReference(
    stringValue(raw.url) ?? record.sourceUrl ?? record.sourceId
  );

  if (!topicId || topicId <= 0 || !reference || reference.topicId !== topicId) {
    return null;
  }

  const coverage = recordValue(raw.coverage);
  const coverageCapped = booleanValue(coverage.capped) ?? false;
  const rawPosts = arrayValue(raw.posts).map(recordValue);
  const postIds = rawPosts
    .map((post) => numberValue(post.id))
    .filter((postId): postId is number => Boolean(postId && postId > 0));
  const streamPostIds = arrayValue(topic.streamPostIds)
    .map(numberValue)
    .filter((postId): postId is number => Boolean(postId && postId > 0));
  // A capped updates-category mirror knows the stream identity, but not its full
  // content. Treat it as a mergeable observation so it cannot downgrade a
  // complete linked-topic capture that already has the same stream.
  const hasStreamSnapshot = Array.isArray(topic.streamPostIds);
  const hasAuthoritativeStream = hasStreamSnapshot && !coverageCapped;
  const reportedPostCount = numberValue(topic.postsCount);
  const effectiveStreamPostIds = streamPostIds.length ? streamPostIds : postIds;
  const inferredComplete = Boolean(
    reportedPostCount !== null && reportedPostCount <= postIds.length
  );

  return {
    record,
    raw,
    topic,
    topicId,
    reference,
    posts: rawPosts,
    streamPostIds: effectiveStreamPostIds,
    hasStreamSnapshot,
    hasAuthoritativeStream,
    coverageComplete: booleanValue(coverage.complete) ?? inferredComplete,
    coverageCapped
  };
}

function postPermalink(canonicalUrl: string, postNumber: number | null) {
  return postNumber ? `${canonicalUrl}/${postNumber}` : canonicalUrl;
}

export async function storeNormalizedForumRecords(
  client: pg.Client,
  params: {
    syncRunId: string;
    records: SourceMirrorRecord[];
  }
): Promise<NormalizedForumStoreCounts> {
  const counts: NormalizedForumStoreCounts = {
    recordsSeen: params.records.length,
    recordsEligible: 0,
    topicsUpserted: 0,
    completeTopics: 0,
    postsUpserted: 0,
    postsMarkedDeleted: 0,
    referencesUpserted: 0
  };
  const grouped = new Map<number, NonNullable<ReturnType<typeof normalizedRecord>>[]>();

  for (const record of params.records) {
    const normalized = normalizedRecord(record);

    if (!normalized) {
      continue;
    }

    counts.recordsEligible += 1;
    const existing = grouped.get(normalized.topicId) ?? [];
    existing.push(normalized);
    grouped.set(normalized.topicId, existing);
  }

  for (const [topicId, candidates] of grouped) {
    const postsById = new Map<number, JsonRecord>();
    const hasStreamSnapshot = candidates.some((candidate) => candidate.hasStreamSnapshot);
    const hasAuthoritativeStream = candidates.some((candidate) => candidate.hasAuthoritativeStream);
    const streamPostIds = new Set<number>();

    for (const candidate of candidates.filter(
      (candidate) => !hasStreamSnapshot || candidate.hasStreamSnapshot
    )) {
      for (const postId of candidate.streamPostIds) {
        streamPostIds.add(postId);
      }
    }

    for (const candidate of candidates) {
      for (const post of candidate.posts) {
        const postId = numberValue(post.id);

        if (postId && postId > 0) {
          postsById.set(postId, post);
        }
      }
    }

    const representative = [...candidates].sort((left, right) => {
      if (left.hasStreamSnapshot !== right.hasStreamSnapshot) {
        return left.hasStreamSnapshot ? -1 : 1;
      }

      if (left.hasAuthoritativeStream !== right.hasAuthoritativeStream) {
        return left.hasAuthoritativeStream ? -1 : 1;
      }

      if (left.coverageComplete !== right.coverageComplete) {
        return left.coverageComplete ? -1 : 1;
      }

      return right.posts.length - left.posts.length;
    })[0]!;
    const topic = representative.topic;
    const reportedPostCountCandidates = hasStreamSnapshot
      ? candidates.filter((candidate) => candidate.hasStreamSnapshot)
      : candidates;
    const reportedPostCount = Math.max(
      0,
      ...reportedPostCountCandidates.map((candidate) => numberValue(candidate.topic.postsCount) ?? 0)
    ) || null;
    const mergedStreamPostIds = [...streamPostIds].sort((left, right) => left - right);
    const coverageCandidates = hasStreamSnapshot
      ? candidates.filter((candidate) => candidate.hasStreamSnapshot)
      : candidates;
    const coverageComplete = coverageCandidates.some((candidate) => candidate.coverageComplete)
      || Boolean(reportedPostCount !== null && postsById.size >= reportedPostCount);
    const coverageCapped = !coverageComplete
      && coverageCandidates.some((candidate) => candidate.coverageCapped);
    const slug = stringValue(topic.slug) ?? representative.reference.slug;
    const canonicalUrl = slug
      ? `https://forum.zcashcommunity.com/t/${slug}/${topicId}`
      : representative.reference.canonicalUrl;
    const topicResult = await client.query<{ id: string }>(
      `insert into discourse_topics (
         forum_host,
         topic_id,
         canonical_url,
         slug,
         title,
         fancy_title,
         category_id,
         tags,
         reported_post_count,
         stream_post_count,
         stream_post_ids,
         coverage_complete,
         coverage_capped,
         source_created_at,
         source_updated_at,
         last_posted_at,
         last_sync_run_id,
         metadata
       )
       values (
         'forum.zcashcommunity.com', $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb,
         $11, $12, $13, $14, $15, $16, $17::jsonb
       )
       on conflict (forum_host, topic_id)
       do update set canonical_url = case
                       when $19::boolean
                         or discourse_topics.metadata->>'streamAuthoritative' is distinct from 'true'
                         then excluded.canonical_url
                       else discourse_topics.canonical_url
                     end,
                     slug = case
                       when $19::boolean
                         or discourse_topics.metadata->>'streamAuthoritative' is distinct from 'true'
                         then coalesce(excluded.slug, discourse_topics.slug)
                       else discourse_topics.slug
                     end,
                     title = case
                       when $19::boolean
                         or discourse_topics.metadata->>'streamAuthoritative' is distinct from 'true'
                         then coalesce(excluded.title, discourse_topics.title)
                       else discourse_topics.title
                     end,
                     fancy_title = case
                       when $19::boolean
                         or discourse_topics.metadata->>'streamAuthoritative' is distinct from 'true'
                         then coalesce(excluded.fancy_title, discourse_topics.fancy_title)
                       else discourse_topics.fancy_title
                     end,
                     category_id = case
                       when $19::boolean
                         or discourse_topics.metadata->>'streamAuthoritative' is distinct from 'true'
                         then coalesce(excluded.category_id, discourse_topics.category_id)
                       else discourse_topics.category_id
                     end,
                     tags = case
                       when $19::boolean
                         or discourse_topics.metadata->>'streamAuthoritative' is distinct from 'true'
                         then excluded.tags
                       else discourse_topics.tags
                     end,
                     reported_post_count = case
                       when $19::boolean then excluded.reported_post_count
                       when discourse_topics.metadata->>'streamAuthoritative' = 'true'
                         then discourse_topics.reported_post_count
                       when discourse_topics.reported_post_count is null then excluded.reported_post_count
                       when excluded.reported_post_count is null then discourse_topics.reported_post_count
                       else greatest(discourse_topics.reported_post_count, excluded.reported_post_count)
                     end,
                     coverage_complete = case
                       when discourse_topics.metadata->>'streamAuthoritative' = 'true'
                         and (
                           not $19::boolean
                           or (
                             not $18::boolean
                             and discourse_topics.stream_post_ids = excluded.stream_post_ids
                           )
                         )
                         then discourse_topics.coverage_complete
                       else excluded.coverage_complete
                     end,
                     coverage_capped = case
                       when discourse_topics.metadata->>'streamAuthoritative' = 'true'
                         and (
                           not $19::boolean
                           or (
                             not $18::boolean
                             and discourse_topics.stream_post_ids = excluded.stream_post_ids
                           )
                         )
                         then discourse_topics.coverage_capped
                       else excluded.coverage_capped
                     end,
                     source_created_at = case
                       when discourse_topics.source_created_at is null then excluded.source_created_at
                       when excluded.source_created_at is null then discourse_topics.source_created_at
                       else least(discourse_topics.source_created_at, excluded.source_created_at)
                     end,
                     source_updated_at = case
                       when discourse_topics.source_updated_at is null then excluded.source_updated_at
                       when excluded.source_updated_at is null then discourse_topics.source_updated_at
                       else greatest(discourse_topics.source_updated_at, excluded.source_updated_at)
                     end,
                     last_posted_at = case
                       when discourse_topics.last_posted_at is null then excluded.last_posted_at
                       when excluded.last_posted_at is null then discourse_topics.last_posted_at
                       else greatest(discourse_topics.last_posted_at, excluded.last_posted_at)
                     end,
                     last_sync_run_id = excluded.last_sync_run_id,
                     metadata = case
                       when $19::boolean
                         or discourse_topics.metadata->>'streamAuthoritative' is distinct from 'true'
                         then discourse_topics.metadata || jsonb_strip_nulls(excluded.metadata)
                       else discourse_topics.metadata
                     end,
                     updated_at = now()
       returning id`,
      [
        topicId,
        canonicalUrl,
        slug,
        stringValue(topic.title),
        stringValue(topic.fancyTitle),
        numberValue(topic.categoryId),
        JSON.stringify(arrayValue(topic.tags)),
        reportedPostCount,
        mergedStreamPostIds.length,
        JSON.stringify(mergedStreamPostIds),
        coverageComplete,
        coverageCapped,
        stringValue(topic.createdAt),
        stringValue(topic.updatedAt),
        stringValue(topic.lastPostedAt),
        params.syncRunId,
        JSON.stringify({
          replyCount: numberValue(topic.replyCount),
          views: numberValue(topic.views),
          bumpedAt: stringValue(topic.bumpedAt),
          ...(hasAuthoritativeStream ? { streamAuthoritative: true } : {})
        }),
        hasAuthoritativeStream,
        hasStreamSnapshot
      ]
    );
    const discourseTopicId = topicResult.rows[0]?.id;

    if (!discourseTopicId) {
      throw new Error(`Failed to normalize Discourse topic ${topicId}.`);
    }

    counts.topicsUpserted += 1;
    for (const [postId, post] of postsById) {
      const postNumber = numberValue(post.postNumber);
      const cookedHtml = stringValue(post.cookedHtml);
      const plainText = stringValue(post.plainText) ?? "";
      const contentHash = checksum({ cookedHtml, plainText });

      await client.query(
        `insert into discourse_posts (
           discourse_topic_id,
           post_id,
           post_number,
           post_type,
           reply_to_post_number,
           username,
           display_name,
           created_at_source,
           updated_at_source,
           cooked_html,
           plain_text,
           permalink,
           content_hash,
           last_sync_run_id,
           metadata
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
         on conflict (discourse_topic_id, post_id)
         do update set post_number = excluded.post_number,
                       post_type = excluded.post_type,
                       reply_to_post_number = excluded.reply_to_post_number,
                       username = excluded.username,
                       display_name = excluded.display_name,
                       created_at_source = coalesce(excluded.created_at_source, discourse_posts.created_at_source),
                       updated_at_source = coalesce(excluded.updated_at_source, discourse_posts.updated_at_source),
                       cooked_html = excluded.cooked_html,
                       plain_text = excluded.plain_text,
                       permalink = excluded.permalink,
                       content_hash = excluded.content_hash,
                       deleted_at = null,
                       last_sync_run_id = excluded.last_sync_run_id,
                       metadata = discourse_posts.metadata || excluded.metadata,
                       updated_at = now()`,
        [
          discourseTopicId,
          postId,
          postNumber,
          numberValue(post.postType),
          numberValue(post.replyToPostNumber),
          stringValue(post.username),
          stringValue(post.name),
          stringValue(post.createdAt),
          stringValue(post.updatedAt),
          cookedHtml,
          plainText,
          postPermalink(canonicalUrl, postNumber),
          contentHash,
          params.syncRunId,
          JSON.stringify({ links: arrayValue(post.links) })
        ]
      );
      counts.postsUpserted += 1;
    }

    const coverageResult = await client.query<{
      coverage_complete: boolean;
      stream_post_ids: number[];
    }>(
      `with merged_ids as (
         select coalesce(array_agg(distinct post_id order by post_id), '{}'::bigint[]) as ids
           from (
             select (value #>> '{}')::bigint as post_id
               from discourse_topics existing,
                    jsonb_array_elements(
                      case
                        when $6::boolean then $2::jsonb
                        when existing.metadata->>'streamAuthoritative' = 'true'
                          then existing.stream_post_ids
                        else existing.stream_post_ids || $2::jsonb
                      end
                    ) value
              where existing.id = $1
           ) merged
       ), active_posts as (
         select count(*)::integer as count
           from discourse_posts posts, merged_ids
          where posts.discourse_topic_id = $1
            and posts.deleted_at is null
            and posts.post_id = any(merged_ids.ids)
            and (not $3::boolean or posts.last_sync_run_id = $5)
       ), coverage as (
         select (
           cardinality(merged_ids.ids) > 0
           and active_posts.count = cardinality(merged_ids.ids)
           and (
             $3::boolean
             or (
               not $6::boolean
               and topic.metadata->>'streamAuthoritative' = 'true'
               and topic.coverage_complete
             )
             or (
               not $6::boolean
               and topic.metadata->>'streamAuthoritative' is distinct from 'true'
               and (
                 topic.reported_post_count is null
                 or cardinality(merged_ids.ids) >= topic.reported_post_count
               )
             )
             or (
               $6::boolean
               and not $3::boolean
               and topic.metadata->>'streamAuthoritative' = 'true'
               and topic.coverage_complete
             )
           )
         ) as complete
           from discourse_topics topic, merged_ids, active_posts
          where topic.id = $1
       )
       update discourse_topics topic
          set stream_post_ids = to_jsonb(merged_ids.ids),
              stream_post_count = cardinality(merged_ids.ids),
              coverage_complete = coverage.complete,
              coverage_capped = (
                case
                  when $6::boolean then $4::boolean
                  else topic.coverage_capped or $4::boolean
                end
              ) and not coverage.complete,
              updated_at = now()
         from merged_ids, coverage
        where topic.id = $1
       returning topic.coverage_complete, merged_ids.ids as stream_post_ids`,
      [
        discourseTopicId,
        JSON.stringify(mergedStreamPostIds),
        hasAuthoritativeStream,
        coverageCapped,
        params.syncRunId,
        hasStreamSnapshot
      ]
    );
    const finalCoverageComplete = coverageResult.rows[0]?.coverage_complete ?? coverageComplete;
    const finalStreamPostIds = coverageResult.rows[0]?.stream_post_ids ?? mergedStreamPostIds;

    counts.completeTopics += finalCoverageComplete ? 1 : 0;

    if (finalCoverageComplete) {
      const deleted = await client.query(
        `update discourse_posts
            set deleted_at = coalesce(deleted_at, now()),
                last_sync_run_id = $3,
                updated_at = now()
          where discourse_topic_id = $1
            and not (post_id = any($2::bigint[]))
            and deleted_at is null`,
        [discourseTopicId, finalStreamPostIds, params.syncRunId]
      );
      counts.postsMarkedDeleted += deleted.rowCount ?? 0;
    }

    for (const candidate of candidates) {
      const sourceRecord = await client.query<{ id: string }>(
        `select id
           from source_records
          where source_kind = $1
            and source_id = $2`,
        [candidate.record.sourceKind, candidate.record.sourceId]
      );
      const sourceRecordId = sourceRecord.rows[0]?.id;

      if (!sourceRecordId) {
        continue;
      }

      await client.query(
        `insert into discourse_topic_references (
           discourse_topic_id,
           source_record_id,
           referenced_url,
           referenced_post_number,
           first_seen_sync_run_id,
           last_seen_sync_run_id,
           metadata
         )
         values ($1, $2, $3, $4, $5, $5, $6::jsonb)
         on conflict (discourse_topic_id, source_record_id, referenced_url)
           where source_record_id is not null
         do update set referenced_post_number = excluded.referenced_post_number,
                       last_seen_sync_run_id = excluded.last_seen_sync_run_id,
                       metadata = discourse_topic_references.metadata || excluded.metadata,
                       updated_at = now()`,
        [
          discourseTopicId,
          sourceRecordId,
          candidate.reference.referencedUrl,
          candidate.reference.referencedPostNumber,
          params.syncRunId,
          JSON.stringify({ sourceKind: candidate.record.sourceKind })
        ]
      );
      counts.referencesUpserted += 1;
    }
  }

  return counts;
}

export async function backfillNormalizedForumRecords(
  client: pg.Client,
  params: { syncRunId: string; limit?: number }
) {
  const limit = Math.min(1000, Math.max(1, params.limit ?? 250));
  const result = await client.query<{
    id: string;
    source_kind: string;
    source_id: string;
    checksum_sha256: string | null;
    source_url: string | null;
    source_updated_at: string | null;
    title: string | null;
    summary: string | null;
    raw_payload: JsonRecord;
    metadata: JsonRecord;
  }>(
    `select sr.id::text,
            sr.source_kind,
            sr.source_id,
            sr.checksum_sha256,
            sr.source_url,
            sr.source_updated_at::text,
            sr.title,
            sr.summary,
            sr.raw_payload,
            sr.metadata
       from source_records sr
      where sr.source_kind = any($1::text[])
        and (sr.raw_payload->'topic'->>'id') ~ '^[0-9]+$'
        and sr.metadata->>'forumNormalizationAttemptedChecksum'
              is distinct from coalesce(sr.checksum_sha256, '__no_checksum__')
        and not exists (
          select 1
            from discourse_topic_references dtr
           where dtr.source_record_id = sr.id
        )
      order by sr.id
      limit $2`,
    [forumSourceKinds, limit]
  );
  const records: SourceMirrorRecord[] = result.rows.map((row) => ({
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceUrl: row.source_url ?? undefined,
    sourceUpdatedAt: row.source_updated_at,
    title: row.title,
    summary: row.summary,
    rawPayload: row.raw_payload,
    metadata: row.metadata
  }));
  const counts = await storeNormalizedForumRecords(client, {
    syncRunId: params.syncRunId,
    records
  });
  const attemptedIds = result.rows.map((row) => row.id);

  if (attemptedIds.length) {
    await client.query(
      `update source_records
          set metadata = metadata || jsonb_build_object(
                'forumNormalizationAttemptedChecksum', coalesce(checksum_sha256, '__no_checksum__'),
                'forumNormalizationAttemptedAt', now(),
                'forumNormalizationSyncRunId', $2::text
              ),
              updated_at = now()
        where id = any($1::uuid[])`,
      [attemptedIds, params.syncRunId]
    );
  }

  const remaining = await client.query<{ count: string }>(
    `select count(*)::text as count
       from source_records sr
      where sr.source_kind = any($1::text[])
        and (sr.raw_payload->'topic'->>'id') ~ '^[0-9]+$'
        and sr.metadata->>'forumNormalizationAttemptedChecksum'
              is distinct from coalesce(sr.checksum_sha256, '__no_checksum__')
        and not exists (
          select 1
            from discourse_topic_references dtr
           where dtr.source_record_id = sr.id
        )`,
    [forumSourceKinds]
  );
  const remainingRecords = Number(remaining.rows[0]?.count ?? 0);

  return {
    ...counts,
    batchLimit: limit,
    remainingRecords,
    complete: remainingRecords === 0
  };
}
