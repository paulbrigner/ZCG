create table if not exists grant_participants (
  id uuid primary key default gen_random_uuid(),
  participant_key text not null unique,
  display_name text not null,
  normalized_name text not null,
  participant_type text not null default 'unknown' check (
    participant_type in ('person', 'organization', 'team', 'unknown')
  ),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists grant_participants_normalized_name_idx
  on grant_participants(normalized_name);

create table if not exists grant_application_participants (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references grant_applications(id) on delete cascade,
  participant_id uuid references grant_participants(id),
  display_name text not null,
  normalized_name text not null,
  participant_role text not null default 'team_member',
  source_record_id uuid references source_records(id) on delete set null,
  confidence numeric(5, 4) not null default 0 check (confidence >= 0 and confidence <= 1),
  review_status text not null default 'needs_review' check (
    review_status in ('accepted', 'needs_review', 'dismissed')
  ),
  reviewed_by_principal_id uuid references principals(id) on delete set null,
  reviewed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (review_status <> 'accepted' or participant_id is not null)
);

create index if not exists grant_application_participants_application_idx
  on grant_application_participants(application_id, review_status, normalized_name);

create index if not exists grant_application_participants_participant_idx
  on grant_application_participants(participant_id, review_status)
  where participant_id is not null;

create index if not exists grant_application_participants_source_idx
  on grant_application_participants(source_record_id)
  where source_record_id is not null;

create unique index if not exists grant_application_participants_identity_idx
  on grant_application_participants(
    application_id,
    normalized_name,
    participant_role
  );

create table if not exists grant_participant_aliases (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references grant_participants(id) on delete cascade,
  alias text not null,
  normalized_alias text not null,
  source_record_id uuid references source_records(id) on delete set null,
  confidence numeric(5, 4) not null default 0 check (confidence >= 0 and confidence <= 1),
  review_status text not null default 'needs_review' check (
    review_status in ('accepted', 'needs_review', 'dismissed')
  ),
  reviewed_by_principal_id uuid references principals(id) on delete set null,
  reviewed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists grant_participant_aliases_normalized_idx
  on grant_participant_aliases(normalized_alias, review_status);

create index if not exists grant_participant_aliases_source_idx
  on grant_participant_aliases(source_record_id)
  where source_record_id is not null;

create unique index if not exists grant_participant_aliases_identity_idx
  on grant_participant_aliases(
    participant_id,
    normalized_alias
  );

create table if not exists grant_analysis_reports (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references grant_applications(id) on delete cascade,
  report_type text not null check (report_type in ('committee_briefing', 'custom')),
  visibility text not null default 'private' check (visibility in ('private', 'shared')),
  title text not null,
  custom_prompt text,
  template_key text not null,
  template_version text not null,
  version_number integer not null check (version_number > 0),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  requested_by_principal_id uuid references principals(id) on delete set null,
  answer_job_id uuid references grant_knowledge_answer_jobs(id) on delete set null,
  answer_text text,
  answer_status text check (
    answer_status is null or answer_status in ('evidence', 'generated', 'fallback', 'disabled', 'not_requested')
  ),
  error_message text,
  evidence_fingerprint text,
  provider text,
  model text,
  generation_metadata jsonb not null default '{}'::jsonb,
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  supersedes_report_id uuid references grant_analysis_reports(id) on delete set null,
  regeneration_reason text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (report_type <> 'custom' or custom_prompt is not null),
  unique (application_id, report_type, version_number)
);

create index if not exists grant_analysis_reports_application_idx
  on grant_analysis_reports(application_id, report_type, created_at desc);

create index if not exists grant_analysis_reports_application_status_idx
  on grant_analysis_reports(application_id, status, visibility, completed_at desc);

create index if not exists grant_analysis_reports_requester_idx
  on grant_analysis_reports(requested_by_principal_id, created_at desc)
  where requested_by_principal_id is not null;

create unique index if not exists grant_analysis_reports_answer_job_idx
  on grant_analysis_reports(answer_job_id)
  where answer_job_id is not null;

create index if not exists grant_analysis_reports_supersedes_idx
  on grant_analysis_reports(supersedes_report_id)
  where supersedes_report_id is not null;

create table if not exists grant_analysis_report_evidence (
  report_id uuid not null references grant_analysis_reports(id) on delete cascade,
  citation_number integer not null check (citation_number > 0),
  knowledge_document_id uuid references grant_knowledge_documents(id) on delete set null,
  document_key text not null,
  content_hash text not null,
  evidence_role text not null check (
    evidence_role in ('current', 'team_history', 'related', 'similar_approved', 'similar_declined', 'external')
  ),
  retrieval_rank numeric,
  application_id uuid not null,
  source_record_id uuid references source_records(id) on delete set null,
  title text,
  source_kind text,
  source_id text,
  source_url text,
  content_snapshot text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (report_id, citation_number)
);

create index if not exists grant_analysis_report_evidence_document_idx
  on grant_analysis_report_evidence(knowledge_document_id)
  where knowledge_document_id is not null;

create index if not exists grant_analysis_report_evidence_application_idx
  on grant_analysis_report_evidence(application_id, report_id);

create index if not exists grant_analysis_report_evidence_source_idx
  on grant_analysis_report_evidence(source_record_id)
  where source_record_id is not null;

insert into permissions (permission_key, name, description)
values
  ('grant:analysis:read', 'Read grant analyses', 'Can read shared committee briefings and grounded grant analyses.'),
  ('grant:analysis:generate', 'Generate grant analyses', 'Can generate committee briefings and private grounded grant analyses.'),
  ('grant:analysis:publish', 'Publish grant analyses', 'Can publish grounded grant analyses for other authorized users.')
on conflict (permission_key) do update
set name = excluded.name,
    description = excluded.description;

insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.permission_key in (
  'grant:analysis:read',
  'grant:analysis:generate',
  'grant:analysis:publish'
)
where r.role_key in ('admin', 'committee')
on conflict do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.permission_key = 'grant:analysis:read'
where r.role_key in ('fpf_ops', 'finance')
on conflict do nothing;
