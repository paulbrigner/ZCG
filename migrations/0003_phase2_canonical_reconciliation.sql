create table if not exists grant_applications (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  title text not null,
  applicant_name text,
  github_issue_number integer,
  github_issue_url text,
  github_state text,
  normalized_status text not null default 'unknown',
  requested_amount_usd numeric(14, 2),
  match_confidence numeric(5, 4) not null default 0,
  source_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists grant_applications_status_idx
  on grant_applications(normalized_status, updated_at desc);

create index if not exists grant_applications_title_idx
  on grant_applications using gin (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(applicant_name, '')));

create table if not exists grants (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references grant_applications(id) on delete set null,
  title text not null,
  grantee_name text,
  status text not null default 'unknown',
  approved_amount_usd numeric(14, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(application_id)
);

create index if not exists grants_status_idx
  on grants(status, updated_at desc);

insert into permissions (permission_key, name, description)
values
  ('grant:read', 'Read canonical grants', 'Can read canonical application and grant records.'),
  ('reconciliation:read', 'Read reconciliation queue', 'Can inspect reconciliation issues and match confidence.'),
  ('reconciliation:write', 'Run reconciliation', 'Can run or update prototype reconciliation jobs.')
on conflict (permission_key) do update
set name = excluded.name,
    description = excluded.description;

insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.permission_key in ('grant:read', 'reconciliation:read', 'reconciliation:write')
where r.role_key = 'admin'
on conflict do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.permission_key in ('grant:read', 'reconciliation:read')
where r.role_key in ('committee', 'fpf_ops', 'finance')
on conflict do nothing;
