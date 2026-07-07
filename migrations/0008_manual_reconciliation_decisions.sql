create table if not exists reconciliation_decisions (
  id uuid primary key default gen_random_uuid(),
  decision_key text not null unique,
  decision_type text not null check (
    decision_type in (
      'link_source',
      'unlink_source',
      'relate_applications',
      'merge_applications',
      'override_field',
      'dismiss_issue'
    )
  ),
  status text not null default 'active' check (status in ('active', 'superseded', 'reverted')),
  source_kind text,
  source_id text,
  canonical_type text not null default 'grant_application',
  canonical_key text,
  related_canonical_key text,
  relationship_type text,
  field_name text,
  field_value jsonb,
  rationale text not null,
  confidence numeric(5, 4) not null default 1 check (confidence >= 0 and confidence <= 1),
  evidence jsonb not null default '{}'::jsonb,
  created_by_principal_id uuid references principals(id) on delete set null,
  superseded_by_decision_id uuid references reconciliation_decisions(id) on delete set null,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    decision_type not in ('link_source', 'unlink_source')
    or (source_kind is not null and source_id is not null and canonical_key is not null)
  ),
  check (
    decision_type not in ('relate_applications', 'merge_applications')
    or (canonical_key is not null and related_canonical_key is not null and relationship_type is not null)
  ),
  check (
    decision_type <> 'override_field'
    or (canonical_key is not null and field_name is not null and field_value is not null)
  )
);

create index if not exists reconciliation_decisions_status_idx
  on reconciliation_decisions(status, decision_type, updated_at desc);

create index if not exists reconciliation_decisions_source_idx
  on reconciliation_decisions(source_kind, source_id)
  where source_kind is not null and source_id is not null;

create index if not exists reconciliation_decisions_canonical_idx
  on reconciliation_decisions(canonical_type, canonical_key)
  where canonical_key is not null;

create table if not exists reconciliation_decision_issues (
  decision_id uuid not null references reconciliation_decisions(id) on delete cascade,
  reconciliation_issue_id uuid not null references reconciliation_issues(id) on delete cascade,
  resolution_status text not null default 'resolved' check (resolution_status in ('resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  primary key (decision_id, reconciliation_issue_id)
);

create index if not exists reconciliation_decision_issues_issue_idx
  on reconciliation_decision_issues(reconciliation_issue_id);

create table if not exists grant_application_relationships (
  id uuid primary key default gen_random_uuid(),
  relationship_key text not null unique,
  from_application_id uuid not null references grant_applications(id) on delete cascade,
  to_application_id uuid not null references grant_applications(id) on delete cascade,
  relationship_type text not null,
  source_decision_id uuid references reconciliation_decisions(id) on delete set null,
  rationale text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (from_application_id, to_application_id, relationship_type),
  check (from_application_id <> to_application_id)
);

create index if not exists grant_application_relationships_from_idx
  on grant_application_relationships(from_application_id, relationship_type);

create index if not exists grant_application_relationships_to_idx
  on grant_application_relationships(to_application_id, relationship_type);
