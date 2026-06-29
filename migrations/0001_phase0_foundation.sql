create extension if not exists pgcrypto;

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists principals (
  id uuid primary key default gen_random_uuid(),
  auth_provider text not null,
  auth_subject text not null,
  email text not null,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (auth_provider, auth_subject)
);

create table if not exists roles (
  id uuid primary key default gen_random_uuid(),
  role_key text not null unique,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

create table if not exists permissions (
  id uuid primary key default gen_random_uuid(),
  permission_key text not null unique,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

create table if not exists role_permissions (
  role_id uuid not null references roles(id) on delete cascade,
  permission_id uuid not null references permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table if not exists role_assignments (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid not null references principals(id) on delete cascade,
  role_id uuid not null references roles(id) on delete cascade,
  granted_by_principal_id uuid references principals(id),
  reason text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (principal_id, role_id)
);

create table if not exists permission_grants (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid not null references principals(id) on delete cascade,
  permission_id uuid not null references permissions(id) on delete cascade,
  granted_by_principal_id uuid references principals(id),
  reason text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (principal_id, permission_id)
);

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_principal_id uuid references principals(id),
  action text not null,
  target_type text not null,
  target_id text,
  request_context jsonb not null default '{}'::jsonb,
  before_values jsonb,
  after_values jsonb,
  metadata jsonb not null default '{}'::jsonb,
  public_projection_impact jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_created_at_idx on audit_events(created_at desc);
create index if not exists audit_events_target_idx on audit_events(target_type, target_id);
create index if not exists audit_events_actor_idx on audit_events(actor_principal_id);

create table if not exists public_audit_events (
  id uuid primary key default gen_random_uuid(),
  audit_event_id uuid references audit_events(id),
  public_event_type text not null,
  public_target_type text not null,
  public_target_id text,
  public_payload jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists sync_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  status text not null check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  records_seen integer not null default 0,
  records_created integer not null default 0,
  records_updated integer not null default 0,
  records_skipped integer not null default 0,
  error_summary text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists sync_runs_source_started_idx on sync_runs(source, started_at desc);

create table if not exists source_snapshots (
  id uuid primary key default gen_random_uuid(),
  sync_run_id uuid references sync_runs(id) on delete set null,
  source_kind text not null,
  source_id text not null,
  source_url text,
  s3_bucket text not null,
  s3_key text not null,
  checksum_sha256 text not null,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (source_kind, source_id, checksum_sha256)
);

create table if not exists source_records (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null,
  source_id text not null,
  source_url text,
  source_updated_at timestamptz,
  checksum_sha256 text,
  raw_snapshot_id uuid references source_snapshots(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_kind, source_id)
);

create table if not exists source_links (
  id uuid primary key default gen_random_uuid(),
  source_record_id uuid not null references source_records(id) on delete cascade,
  canonical_type text not null,
  canonical_id uuid not null,
  confidence numeric(5, 4) not null default 1,
  created_at timestamptz not null default now(),
  unique (source_record_id, canonical_type, canonical_id)
);

create table if not exists reconciliation_issues (
  id uuid primary key default gen_random_uuid(),
  issue_type text not null,
  severity text not null check (severity in ('info', 'warning', 'error')),
  source_record_id uuid references source_records(id) on delete set null,
  canonical_type text,
  canonical_id uuid,
  summary text not null,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'assigned', 'resolved', 'dismissed')),
  assigned_principal_id uuid references principals(id),
  resolved_by_principal_id uuid references principals(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists idempotency_keys (
  key text primary key,
  scope text not null,
  locked_until timestamptz,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into permissions (permission_key, name, description)
values
  ('admin:dashboard:view', 'View admin dashboard', 'Can view the internal admin shell.'),
  ('audit:read', 'Read audit events', 'Can read audit event records.'),
  ('sync:run:write', 'Record sync runs', 'Can create sync-run records.'),
  ('public:projection:read', 'Read public projection', 'Can read public projection definitions.'),
  ('role:assignment:manage', 'Manage role assignments', 'Can grant and revoke platform roles.')
on conflict (permission_key) do update
set name = excluded.name,
    description = excluded.description;

insert into roles (role_key, name, description)
values
  ('admin', 'Administrator', 'Full prototype administration role.'),
  ('committee', 'Committee member', 'ZCG committee workflow participant.'),
  ('fpf_ops', 'FPF operations', 'FPF operations and eligibility workflow participant.'),
  ('finance', 'Finance', 'Finance and liability workflow participant.'),
  ('applicant', 'Applicant', 'Authenticated applicant role.'),
  ('public', 'Public', 'Unauthenticated public projection role.')
on conflict (role_key) do update
set name = excluded.name,
    description = excluded.description;

insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.permission_key in (
  'admin:dashboard:view',
  'audit:read',
  'sync:run:write',
  'public:projection:read',
  'role:assignment:manage'
)
where r.role_key = 'admin'
on conflict do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.permission_key in ('admin:dashboard:view', 'public:projection:read')
where r.role_key in ('committee', 'fpf_ops', 'finance')
on conflict do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.permission_key = 'public:projection:read'
where r.role_key in ('applicant', 'public')
on conflict do nothing;
