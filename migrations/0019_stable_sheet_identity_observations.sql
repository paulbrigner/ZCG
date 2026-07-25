select pg_advisory_xact_lock(
  hashtextextended('zcg:corpus-refresh-reconciliation:v1'::text, 0)
);

do $$
declare
  migration_owner constant text := 'schema-migration:0019';
  claimed_owner text;
begin
  insert into idempotency_keys (
    key,
    scope,
    locked_until,
    result,
    created_at,
    updated_at
  )
  values (
    'corpus-refresh:pipeline:v1',
    'corpus-refresh',
    now() + interval '30 minutes',
    jsonb_build_object(
      'owner',
      migration_owner,
      'ownerKind',
      'schema_migration',
      'migration',
      '0019_stable_sheet_identity_observations.sql',
      'startedAt',
      now()
    ),
    now(),
    now()
  )
  on conflict (key) do update
    set scope = excluded.scope,
        locked_until = excluded.locked_until,
        result = excluded.result,
        updated_at = now()
  where idempotency_keys.locked_until is null
     or idempotency_keys.locked_until < now()
     or idempotency_keys.result->>'owner' = migration_owner
  returning result->>'owner' into claimed_owner;

  if claimed_owner is distinct from migration_owner then
    raise exception
      'Migration 0019 requires an idle corpus pipeline; an active refresh lease is present';
  end if;
end;
$$;

create table if not exists source_record_observations (
  id uuid primary key default gen_random_uuid(),
  source_record_id uuid not null,
  version_number integer not null check (version_number > 0),
  observation_type text not null default 'present' check (
    observation_type in ('present', 'tombstone')
  ),
  sync_run_id uuid,
  raw_snapshot_id uuid,
  source_kind text not null,
  source_id text not null,
  source_url text,
  source_updated_at timestamptz,
  checksum_sha256 text,
  title text,
  summary text,
  raw_payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (source_record_id, version_number)
);

comment on table source_record_observations is
  'Append-only source history. source_record_id intentionally has no foreign key so observations survive authoritative pruning.';

create index if not exists source_record_observations_source_idx
  on source_record_observations(source_kind, source_id, observed_at desc);

create index if not exists source_record_observations_record_idx
  on source_record_observations(source_record_id, version_number desc);

insert into source_record_observations (
  source_record_id,
  version_number,
  observation_type,
  sync_run_id,
  raw_snapshot_id,
  source_kind,
  source_id,
  source_url,
  source_updated_at,
  checksum_sha256,
  title,
  summary,
  raw_payload,
  metadata,
  observed_at
)
select sr.id,
       1,
       'present',
       ss.sync_run_id,
       sr.raw_snapshot_id,
       sr.source_kind,
       sr.source_id,
       sr.source_url,
       sr.source_updated_at,
       sr.checksum_sha256,
       sr.title,
       sr.summary,
       sr.raw_payload,
       sr.metadata,
       coalesce(sr.updated_at, sr.created_at, now())
  from source_records sr
  left join source_snapshots ss on ss.id = sr.raw_snapshot_id
on conflict (source_record_id, version_number) do nothing;

create or replace function source_observation_metadata(value jsonb)
returns jsonb
language sql
immutable
parallel safe
as $$
  select coalesce(value, '{}'::jsonb) - array[
    'fetchedAt',
    'forumNormalizationAttemptedChecksum',
    'forumNormalizationAttemptedAt',
    'forumNormalizationSyncRunId',
    'reconciliationGeneratedBy',
    'discoveredFrom',
    'relationshipRole'
  ]::text[]
$$;

create or replace function append_source_record_observation()
returns trigger
language plpgsql
as $$
declare
  next_version integer;
  context_sync_run_id uuid;
  snapshot_sync_run_id uuid;
  observed_record source_records%rowtype;
  observed_type text;
begin
  if tg_op = 'UPDATE'
     and old.source_id is not distinct from new.source_id
     and old.source_url is not distinct from new.source_url
     and old.source_updated_at is not distinct from new.source_updated_at
     and old.checksum_sha256 is not distinct from new.checksum_sha256
     and old.raw_snapshot_id is not distinct from new.raw_snapshot_id
     and old.title is not distinct from new.title
     and old.summary is not distinct from new.summary
     and old.raw_payload is not distinct from new.raw_payload
     and source_observation_metadata(old.metadata)
           is not distinct from source_observation_metadata(new.metadata) then
    return new;
  end if;

  if tg_op = 'DELETE' then
    observed_record := old;
    observed_type := 'tombstone';
  else
    observed_record := new;
    observed_type := 'present';
  end if;

  begin
    context_sync_run_id :=
      nullif(current_setting('zcg.sync_run_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      context_sync_run_id := null;
  end;

  select ss.sync_run_id
    into snapshot_sync_run_id
    from source_snapshots ss
   where ss.id = observed_record.raw_snapshot_id;

  select coalesce(max(observation.version_number), 0) + 1
    into next_version
    from source_record_observations observation
   where observation.source_record_id = observed_record.id;

  insert into source_record_observations (
    source_record_id,
    version_number,
    observation_type,
    sync_run_id,
    raw_snapshot_id,
    source_kind,
    source_id,
    source_url,
    source_updated_at,
    checksum_sha256,
    title,
    summary,
    raw_payload,
    metadata,
    observed_at
  )
  values (
    observed_record.id,
    next_version,
    observed_type,
    coalesce(context_sync_run_id, snapshot_sync_run_id),
    observed_record.raw_snapshot_id,
    observed_record.source_kind,
    observed_record.source_id,
    observed_record.source_url,
    observed_record.source_updated_at,
    observed_record.checksum_sha256,
    observed_record.title,
    observed_record.summary,
    observed_record.raw_payload,
    observed_record.metadata,
    now()
  );

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists source_records_append_observation on source_records;
create trigger source_records_append_observation
after insert or update of
  source_id,
  source_url,
  source_updated_at,
  checksum_sha256,
  raw_snapshot_id,
  title,
  summary,
  raw_payload,
  metadata
on source_records
for each row
execute function append_source_record_observation();

drop trigger if exists source_records_append_tombstone on source_records;
create trigger source_records_append_tombstone
before delete on source_records
for each row
execute function append_source_record_observation();

create or replace function grant_platform_identifier_raw(payload jsonb)
returns text
language sql
immutable
parallel safe
as $$
  select btrim(source_field.field_value)
    from jsonb_each_text(coalesce(payload, '{}'::jsonb))
      as source_field(field_name, field_value)
   where regexp_replace(
           lower(btrim(source_field.field_name)),
           '[^a-z0-9]+',
           '',
           'g'
         ) = 'grantplatformlink'
   order by source_field.field_name
   limit 1
$$;

create or replace function grant_platform_identifier(payload jsonb)
returns text
language sql
immutable
parallel safe
as $$
  select regexp_replace(
           grant_platform_identifier_raw(payload),
           '/+$',
           ''
         )
$$;

do $$
begin
  if exists (
    with candidates as (
      select sr.id,
             sr.source_kind,
             coalesce(nullif(sr.metadata->>'sheetId', ''), split_part(sr.source_id, ':', 1)) ||
               ':' ||
             (sr.metadata->>'gid') ||
               ':grant-platform:' ||
             encode(
               digest(
                 grant_platform_identifier(sr.raw_payload),
                 'sha256'
               ),
               'hex'
             ) as new_source_id
       from source_records sr
       where sr.source_kind = 'google_sheet_row'
         and nullif(sr.metadata->>'gid', '') is not null
         and (
           sr.metadata->>'tabName' = 'all_grants_tracking'
           or sr.metadata->>'gid' = '1164534734'
         )
         and nullif(grant_platform_identifier(sr.raw_payload), '') is not null
    )
    select 1
      from candidates
     group by source_kind, new_source_id
    having count(*) > 1
  ) then
    raise exception
      'Duplicate Grant Platform Link identifiers prevent stable Google Sheet source migration';
  end if;

  if exists (
    with candidates as (
      select sr.id,
             sr.source_kind,
             coalesce(nullif(sr.metadata->>'sheetId', ''), split_part(sr.source_id, ':', 1)) ||
               ':' ||
             (sr.metadata->>'gid') ||
               ':grant-platform:' ||
             encode(
               digest(
                 grant_platform_identifier(sr.raw_payload),
                 'sha256'
               ),
               'hex'
             ) as new_source_id
       from source_records sr
       where sr.source_kind = 'google_sheet_row'
         and nullif(sr.metadata->>'gid', '') is not null
         and (
           sr.metadata->>'tabName' = 'all_grants_tracking'
           or sr.metadata->>'gid' = '1164534734'
         )
         and nullif(grant_platform_identifier(sr.raw_payload), '') is not null
    )
    select 1
      from candidates candidate
      join source_records other
        on other.source_kind = candidate.source_kind
       and other.source_id = candidate.new_source_id
       and other.id <> candidate.id
  ) then
    raise exception
      'A stable Grant Platform Link source ID collides with an existing source record';
  end if;
end;
$$;

create temporary table zcg_0019_sheet_identity_mappings
on commit drop
as
  select sr.id,
         sr.source_id as current_source_id,
         coalesce(
           nullif(sr.metadata->>'legacySourceId', ''),
           sr.source_id
         ) as legacy_source_id,
         grant_platform_identifier(sr.raw_payload) as business_identifier,
         coalesce(nullif(sr.metadata->>'sheetId', ''), split_part(sr.source_id, ':', 1)) ||
           ':' ||
         (sr.metadata->>'gid') ||
           ':grant-platform:' ||
         encode(
           digest(
             grant_platform_identifier(sr.raw_payload),
             'sha256'
           ),
           'hex'
         ) as new_source_id
    from source_records sr
   where sr.source_kind = 'google_sheet_row'
     and nullif(sr.metadata->>'gid', '') is not null
     and (
       sr.metadata->>'tabName' = 'all_grants_tracking'
       or sr.metadata->>'gid' = '1164534734'
     )
     and nullif(grant_platform_identifier(sr.raw_payload), '') is not null;

do $$
begin
  if exists (
    select 1
      from reconciliation_decisions decision
      join zcg_0019_sheet_identity_mappings mapping
        on decision.source_id in (mapping.legacy_source_id, mapping.new_source_id)
     where decision.source_kind = 'google_sheet_row'
       and (
         decision.decision_type not in ('link_source', 'unlink_source')
         or (
           decision.field_value is not null
           and decision.field_value <> 'null'::jsonb
         )
       )
  ) then
    raise exception
      'Cannot safely re-key a non-source-link or field-valued reconciliation decision';
  end if;
end;
$$;

create temporary table zcg_0019_decision_identity_mappings
on commit drop
as
with candidates as (
  select decision.id as decision_id,
         decision.decision_key as current_decision_key,
         mapping.legacy_source_id,
         mapping.business_identifier,
         mapping.new_source_id,
         decision.decision_type,
         concat(
           '{"decisionType":',
           to_jsonb(decision.decision_type)::text,
           ',"sourceKind":',
           to_jsonb(decision.source_kind)::text,
           ',"sourceId":',
           to_jsonb(mapping.new_source_id)::text,
           ',"canonicalType":',
           to_jsonb(decision.canonical_type)::text,
           ',"canonicalKey":',
           coalesce(to_jsonb(decision.canonical_key)::text, 'null'),
           ',"relatedCanonicalKey":',
           coalesce(to_jsonb(decision.related_canonical_key)::text, 'null'),
           ',"relationshipType":',
           coalesce(to_jsonb(decision.relationship_type)::text, 'null'),
           ',"fieldName":',
           coalesce(to_jsonb(decision.field_name)::text, 'null'),
           ',"fieldValue":null',
           ',"reconciliationIssueId":null}'
         ) as stable_payload
    from reconciliation_decisions decision
    join zcg_0019_sheet_identity_mappings mapping
      on decision.source_id in (mapping.legacy_source_id, mapping.new_source_id)
   where decision.source_kind = 'google_sheet_row'
     and decision.decision_type in ('link_source', 'unlink_source')
)
select decision_id,
       current_decision_key,
       legacy_source_id,
       business_identifier,
       new_source_id,
       'manual:' ||
         decision_type ||
         ':' ||
         left(encode(digest(stable_payload, 'sha256'), 'hex'), 24) as new_decision_key
  from candidates;

do $$
begin
  if exists (
    select 1
      from zcg_0019_decision_identity_mappings
     group by new_decision_key
    having count(*) > 1
  ) then
    raise exception
      'Stable Sheet identity migration would merge reconciliation decision keys';
  end if;

  if exists (
    select 1
      from zcg_0019_decision_identity_mappings mapping
      join reconciliation_decisions other
        on other.decision_key = mapping.new_decision_key
       and other.id <> mapping.decision_id
  ) then
    raise exception
      'Stable Sheet identity migration collides with an existing reconciliation decision key';
  end if;
end;
$$;

with updated_decisions as (
  update reconciliation_decisions decision
     set decision_key = mapping.new_decision_key,
         source_id = mapping.new_source_id,
         evidence = coalesce(decision.evidence, '{}'::jsonb) ||
           jsonb_build_object(
             'legacySourceId',
             mapping.legacy_source_id,
             'businessIdentifier',
             mapping.business_identifier,
             'stableIdentityMigration',
             'grant_platform_link_v1'
           ),
         updated_at = now()
    from zcg_0019_decision_identity_mappings mapping
   where decision.id = mapping.decision_id
     and (
       decision.decision_key is distinct from mapping.new_decision_key
       or decision.source_id is distinct from mapping.new_source_id
     )
  returning decision.id
)
select count(*) from updated_decisions;

update source_records sr
   set source_id = mapping.new_source_id,
       metadata = coalesce(sr.metadata, '{}'::jsonb) ||
         jsonb_build_object(
           'identityStrategy',
           'grant_platform_link',
           'businessIdentifierField',
           'Grant Platform Link',
           'businessIdentifier',
           mapping.business_identifier,
           'businessIdentifierRaw',
           grant_platform_identifier_raw(sr.raw_payload),
           'legacySourceId',
           mapping.legacy_source_id,
           'rowLocationSourceId',
           coalesce(
             nullif(sr.metadata->>'rowLocationSourceId', ''),
             mapping.legacy_source_id
           )
         ),
       updated_at = now()
  from zcg_0019_sheet_identity_mappings mapping
 where sr.id = mapping.id
   and (
     sr.source_id is distinct from mapping.new_source_id
     or sr.metadata->>'identityStrategy' is distinct from 'grant_platform_link'
     or sr.metadata->>'businessIdentifier' is distinct from mapping.business_identifier
   );

create unique index if not exists source_records_sheet_business_identifier_idx
  on source_records (
    (metadata->>'sheetId'),
    (metadata->>'gid'),
    (grant_platform_identifier(raw_payload))
  )
  where source_kind = 'google_sheet_row'
    and nullif(metadata->>'sheetId', '') is not null
    and nullif(metadata->>'gid', '') is not null
    and (
      metadata->>'tabName' = 'all_grants_tracking'
      or metadata->>'gid' = '1164534734'
    )
    and nullif(grant_platform_identifier(raw_payload), '') is not null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'source_records_all_grants_stable_identity_check'
       and conrelid = 'source_records'::regclass
  ) then
    alter table source_records
      add constraint source_records_all_grants_stable_identity_check
      check (
        source_kind <> 'google_sheet_row'
        or not (
          metadata->>'tabName' = 'all_grants_tracking'
          or metadata->>'gid' = '1164534734'
        )
        or (
          metadata->>'identityStrategy' = 'grant_platform_link'
          and source_id ~ ':grant-platform:[a-f0-9]{64}$'
          and nullif(grant_platform_identifier(raw_payload), '') is not null
        )
      );
  end if;
end;
$$;

create or replace function prevent_source_record_observation_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'source_record_observations is append-only';
end;
$$;

drop trigger if exists source_record_observations_immutable
  on source_record_observations;
create trigger source_record_observations_immutable
before update or delete on source_record_observations
for each row
execute function prevent_source_record_observation_mutation();

update idempotency_keys
   set locked_until = null,
       result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
         'status',
         'completed',
         'completedAt',
         now()
       ),
       updated_at = now()
 where key = 'corpus-refresh:pipeline:v1'
   and result->>'owner' = 'schema-migration:0019';
