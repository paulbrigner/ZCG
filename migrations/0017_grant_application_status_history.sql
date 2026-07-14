-- These migration-local parsers reject malformed source values instead of
-- allowing a single bad timestamp or date to abort the entire history
-- backfill. Decision dates occur in both ISO and US month/day/year formats in
-- the historical registry; normalize both to an unambiguous ISO date before
-- casting. The helpers are dropped at the end of the migration.
create or replace function zcg_migration_0017_parse_source_date(input_value text)
returns date
language sql
stable
strict
as $migration$
  with normalized as (
    select case
      when btrim(input_value) ~ '^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}$' then
        split_part(btrim(input_value), '-', 1) || '-' ||
        lpad(split_part(btrim(input_value), '-', 2), 2, '0') || '-' ||
        lpad(split_part(btrim(input_value), '-', 3), 2, '0')
      when btrim(input_value) ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$' then
        split_part(btrim(input_value), '/', 3) || '-' ||
        lpad(split_part(btrim(input_value), '/', 1), 2, '0') || '-' ||
        lpad(split_part(btrim(input_value), '/', 2), 2, '0')
      else null
    end as candidate
  )
  select case
    when candidate is not null and pg_input_is_valid(candidate, 'date') then candidate::date
    else null
  end
  from normalized
$migration$;

create or replace function zcg_migration_0017_parse_source_timestamptz(input_value text)
returns timestamptz
language sql
stable
strict
as $migration$
  select case
    when btrim(input_value) ~
           '^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$'
     and pg_input_is_valid(btrim(input_value), 'timestamp with time zone')
      then btrim(input_value)::timestamptz
    else null
  end
$migration$;

create table if not exists grant_application_status_events (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references grant_applications(id) on delete set null,
  application_canonical_key text not null,
  event_type text not null check (
    event_type in ('initial_observation', 'status_transition', 'historical_assertion', 'correction', 'retraction')
  ),
  from_status text,
  to_status text not null,
  provenance text not null check (provenance in ('exact', 'observed', 'inferred')),
  effective_at timestamptz,
  effective_date date,
  observed_at timestamptz not null default clock_timestamp(),
  confidence numeric(5, 4) not null default 1 check (confidence >= 0 and confidence <= 1),
  source_record_id uuid references source_records(id) on delete set null,
  source_kind text,
  source_id text,
  source_url text,
  source_checksum_sha256 text,
  source_field text,
  sync_run_id uuid references sync_runs(id) on delete set null,
  reconciliation_run_id uuid,
  evidence_locator text not null,
  evidence_fingerprint text not null,
  corrects_event_id uuid references grant_application_status_events(id) on delete restrict,
  idempotency_key text not null unique,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  check (num_nonnulls(effective_at, effective_date) <= 1),
  check (provenance = 'observed' or num_nonnulls(effective_at, effective_date) = 1),
  check (
    (event_type in ('correction', 'retraction') and corrects_event_id is not null)
    or (event_type not in ('correction', 'retraction') and corrects_event_id is null)
  )
);

create index if not exists grant_application_status_events_application_idx
  on grant_application_status_events(application_id, created_at desc);

create index if not exists grant_application_status_events_status_idx
  on grant_application_status_events(application_id, to_status, created_at desc);

create index if not exists grant_application_status_events_canonical_key_idx
  on grant_application_status_events(application_canonical_key, created_at desc);

create index if not exists grant_application_status_events_source_idx
  on grant_application_status_events(source_record_id)
  where source_record_id is not null;

create unique index if not exists grant_application_status_events_corrects_idx
  on grant_application_status_events(corrects_event_id)
  where corrects_event_id is not null;

-- Establish an honest starting point. These events deliberately have no
-- effective date: the migration proves only that this was the current status
-- when history recording began.
insert into grant_application_status_events (
  application_id,
  application_canonical_key,
  event_type,
  from_status,
  to_status,
  provenance,
  observed_at,
  confidence,
  source_kind,
  source_field,
  evidence_locator,
  evidence_fingerprint,
  idempotency_key,
  evidence,
  created_at
)
select ga.id,
       ga.canonical_key,
       'initial_observation',
       null,
       ga.normalized_status,
       'observed',
       clock_timestamp(),
       1,
       'canonical_reconciliation',
       'normalized_status',
       'canonical:' || ga.canonical_key || ':migration-baseline',
       encode(
         digest(
           jsonb_build_object(
             'canonicalKey', ga.canonical_key,
             'status', ga.normalized_status,
             'basis', 'migration_baseline'
           )::text,
           'sha256'
         ),
         'hex'
       ),
       'migration:0017:baseline:' || ga.id::text,
       jsonb_build_object(
         'basis', 'migration_baseline',
         'effectiveDateKnown', false,
         'note', 'Current status when status-history recording began'
       ),
       clock_timestamp()
  from grant_applications ga
on conflict (idempotency_key) do nothing;

-- GitHub issue creation is useful submission evidence, but submission is an
-- inference from the issue being opened rather than a status event supplied by
-- GitHub itself.
insert into grant_application_status_events (
  application_id,
  application_canonical_key,
  event_type,
  from_status,
  to_status,
  provenance,
  effective_at,
  observed_at,
  confidence,
  source_record_id,
  source_kind,
  source_id,
  source_url,
  source_checksum_sha256,
  source_field,
  evidence_locator,
  evidence_fingerprint,
  idempotency_key,
  evidence,
  created_at
)
select distinct on (ga.id)
       ga.id,
       ga.canonical_key,
       'historical_assertion',
       null,
       'submitted',
       'inferred',
       parsed_source.created_at,
       clock_timestamp(),
       sl.confidence,
       sr.id,
       sr.source_kind,
       sr.source_id,
       sr.source_url,
       sr.checksum_sha256,
       'created_at',
       'source-record:' || sr.id::text || ':github-created-at',
       encode(
         digest(
           jsonb_build_object(
             'sourceRecordId', sr.id,
             'createdAt', sr.raw_payload->>'created_at',
             'status', 'submitted'
           )::text,
           'sha256'
         ),
         'hex'
       ),
       'migration:0017:github-submitted:' || ga.id::text || ':' || sr.id::text,
       jsonb_build_object(
         'basis', 'github_issue_created_at',
         'note', 'Submission inferred from GitHub issue creation'
       ),
       clock_timestamp()
  from grant_applications ga
  join source_links sl
    on sl.canonical_type = 'grant_application'
   and sl.canonical_id = ga.id
  join source_records sr
    on sr.id = sl.source_record_id
   and sr.source_kind = 'github_issue'
 cross join lateral (
   select zcg_migration_0017_parse_source_timestamptz(sr.raw_payload->>'created_at') as created_at
 ) parsed_source
 where parsed_source.created_at is not null
 order by ga.id, sl.confidence desc, sr.source_id
on conflict (idempotency_key) do nothing;

-- The historical registry has an explicitly named committee decision-date
-- field. Preserve its day precision and the status asserted by that record.
insert into grant_application_status_events (
  application_id,
  application_canonical_key,
  event_type,
  from_status,
  to_status,
  provenance,
  effective_date,
  observed_at,
  confidence,
  source_record_id,
  source_kind,
  source_id,
  source_url,
  source_checksum_sha256,
  source_field,
  evidence_locator,
  evidence_fingerprint,
  idempotency_key,
  evidence,
  created_at
)
select ga.id,
       ga.canonical_key,
       'historical_assertion',
       null,
       case
         when registry_status.normalized_status in ('active', 'completed') then 'approved'
         else registry_status.normalized_status
       end,
       case
         when registry_status.normalized_status in ('active', 'completed') then 'inferred'
         else 'exact'
       end,
       parsed_source.decision_date,
       clock_timestamp(),
       coalesce(sheet_source.confidence, ga.match_confidence),
       sheet_source.id,
       sheet_source.source_kind,
       sheet_source.source_id,
       sheet_source.source_url,
       sheet_source.checksum_sha256,
       'Date Committee Approved/ Rejected',
       'canonical:' || ga.canonical_key || ':historical-registry-decision-date',
       encode(
         digest(
           jsonb_build_object(
             'canonicalKey', ga.canonical_key,
             'decisionDate', ga.source_summary->>'historicalRegistryDecisionDate',
             'registryStatus', ga.source_summary->>'historicalRegistryStatus',
             'canonicalStatus', ga.normalized_status
           )::text,
           'sha256'
         ),
         'hex'
       ),
       'migration:0017:historical-decision:' || ga.id::text || ':' || parsed_source.decision_date::text,
       jsonb_build_object(
         'basis', 'official_registry_decision_date',
         'decisionDate', parsed_source.decision_date,
         'registryStatus', ga.source_summary->>'historicalRegistryStatus',
         'normalizedRegistryStatus', registry_status.normalized_status,
         'canonicalStatus', ga.normalized_status
       ),
       clock_timestamp()
  from grant_applications ga
  left join lateral (
    select sr.id,
           sr.source_kind,
           sr.source_id,
           sr.source_url,
           sr.checksum_sha256,
           sl.confidence
      from source_links sl
      join source_records sr on sr.id = sl.source_record_id
     where sl.canonical_type = 'grant_application'
       and sl.canonical_id = ga.id
       and sr.source_kind = 'google_sheet_row'
     order by case
                when zcg_migration_0017_parse_source_date(
                       sr.raw_payload->>'Date Committee Approved/ Rejected'
                     ) = zcg_migration_0017_parse_source_date(
                       ga.source_summary->>'historicalRegistryDecisionDate'
                     )
                  then 0
                else 1
              end,
              sl.confidence desc,
              sr.source_id
     limit 1
  ) sheet_source on true
 cross join lateral (
   select zcg_migration_0017_parse_source_date(
     ga.source_summary->>'historicalRegistryDecisionDate'
   ) as decision_date
 ) parsed_source
 cross join lateral (
   select case
     when lower(coalesce(ga.source_summary->>'historicalRegistryStatus', '')) like '%withdraw%' then 'withdrawn'
     when lower(coalesce(ga.source_summary->>'historicalRegistryStatus', '')) like '%filtered%' then 'filtered'
     when lower(coalesce(ga.source_summary->>'historicalRegistryStatus', '')) like '%discuss%'
       or lower(coalesce(ga.source_summary->>'historicalRegistryStatus', '')) like '%review%' then 'under_review'
     when lower(coalesce(ga.source_summary->>'historicalRegistryStatus', '')) like '%complete%' then 'completed'
     when lower(coalesce(ga.source_summary->>'historicalRegistryStatus', '')) like '%cancel%' then 'cancelled'
     when lower(coalesce(ga.source_summary->>'historicalRegistryStatus', '')) like '%active%'
       or lower(coalesce(ga.source_summary->>'historicalRegistryStatus', '')) like '%progress%' then 'active'
     when lower(coalesce(ga.source_summary->>'historicalRegistryStatus', '')) like '%approved%' then 'approved'
     when lower(coalesce(ga.source_summary->>'historicalRegistryStatus', '')) like '%reject%'
       or lower(coalesce(ga.source_summary->>'historicalRegistryStatus', '')) like '%decline%' then 'declined'
     else null
   end as normalized_status
 ) registry_status
 where parsed_source.decision_date is not null
   and (
     registry_status.normalized_status = ga.normalized_status
     or (
       registry_status.normalized_status in ('active', 'completed')
       and ga.normalized_status in ('active', 'completed')
     )
   )
   and registry_status.normalized_status in (
     'approved', 'declined', 'withdrawn', 'cancelled', 'filtered', 'active', 'completed'
   )
on conflict (idempotency_key) do nothing;

-- Curated pre-GitHub forum outcomes are useful but remain explicitly inferred
-- because the current canonical record is a reviewed synthesis.
insert into grant_application_status_events (
  application_id,
  application_canonical_key,
  event_type,
  to_status,
  provenance,
  effective_date,
  observed_at,
  confidence,
  source_kind,
  source_url,
  source_field,
  evidence_locator,
  evidence_fingerprint,
  idempotency_key,
  evidence,
  created_at
)
select ga.id,
       ga.canonical_key,
       'historical_assertion',
       ga.normalized_status,
       'inferred',
       parsed_source.decision_date,
       clock_timestamp(),
       ga.match_confidence,
       'reviewed_forum_application',
       ga.source_summary->>'forumUrl',
       'decisionDate',
       'canonical:' || ga.canonical_key || ':reviewed-forum-decision-date',
       encode(
         digest(
           jsonb_build_object(
             'canonicalKey', ga.canonical_key,
             'decisionDate', ga.source_summary->>'decisionDate',
             'decisionSummary', ga.source_summary->>'decisionSummary'
           )::text,
           'sha256'
         ),
         'hex'
       ),
       'migration:0017:forum-decision:' || ga.id::text || ':' || parsed_source.decision_date::text,
       jsonb_build_object(
         'basis', 'curated_forum_decision',
         'decisionDate', parsed_source.decision_date,
         'decisionSummary', ga.source_summary->>'decisionSummary'
       ),
       clock_timestamp()
  from grant_applications ga
 cross join lateral (
   select zcg_migration_0017_parse_source_date(ga.source_summary->>'decisionDate') as decision_date
 ) parsed_source
 where ga.source_summary->>'sourceType' = 'reviewed_forum_application'
   and parsed_source.decision_date is not null
   and ga.normalized_status in ('approved', 'declined', 'withdrawn', 'cancelled', 'filtered')
on conflict (idempotency_key) do nothing;

-- Accepted committee-minute matches state both a decision and meeting date.
insert into grant_application_status_events (
  application_id,
  application_canonical_key,
  event_type,
  to_status,
  provenance,
  effective_date,
  observed_at,
  confidence,
  source_record_id,
  source_kind,
  source_id,
  source_url,
  source_checksum_sha256,
  source_field,
  evidence_locator,
  evidence_fingerprint,
  idempotency_key,
  evidence,
  created_at
)
select gdm.application_id,
       ga.canonical_key,
       'historical_assertion',
       case when gdm.normalized_decision = 'approved_async' then 'approved' else gdm.normalized_decision end,
       'exact',
       gds.meeting_date,
       clock_timestamp(),
       gdm.confidence,
       gds.source_record_id,
       sr.source_kind,
       sr.source_id,
       gds.topic_url,
       sr.checksum_sha256,
       'meeting_date',
       'decision-mention:' || gdm.id::text || ':meeting-date',
       gdm.content_hash,
       'decision-mention:' || gdm.id::text || ':' || gdm.content_hash,
       jsonb_build_object(
         'basis', 'accepted_decision_minutes',
         'mentionId', gdm.id,
         'decisionText', gdm.decision_text,
         'matchMethod', gdm.match_method
       ),
       clock_timestamp()
  from grant_decision_mentions gdm
  join grant_decision_sources gds on gds.id = gdm.decision_source_id
  join grant_applications ga on ga.id = gdm.application_id
  left join source_records sr on sr.id = gds.source_record_id
 where gdm.application_id is not null
   and gdm.review_status = 'accepted'
   and gdm.confidence >= 0.86
   and gdm.metadata->>'decisionSection' = 'key_takeaways'
   and gds.meeting_date is not null
   and gdm.normalized_decision in ('approved', 'approved_async', 'declined', 'withdrawn', 'cancelled', 'filtered')
on conflict (idempotency_key) do nothing;

drop function zcg_migration_0017_parse_source_timestamptz(text);
drop function zcg_migration_0017_parse_source_date(text);
