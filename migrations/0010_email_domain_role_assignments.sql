create table if not exists email_domain_role_assignments (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  role_id uuid not null references roles(id) on delete cascade,
  granted_by_principal_id uuid references principals(id),
  reason text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (domain, role_id),
  check (domain = lower(domain)),
  check (domain !~ '[@[:space:]/]' and position('.' in domain) > 1)
);

create index if not exists email_domain_role_assignments_domain_idx
  on email_domain_role_assignments(domain);

create index if not exists email_domain_role_assignments_role_idx
  on email_domain_role_assignments(role_id);

insert into email_domain_role_assignments (domain, role_id, reason)
select 'zcashcommunitygrants.org', roles.id, 'Default ZCG domain access for committee workflow review'
  from roles
 where roles.role_key = 'committee'
on conflict (domain, role_id) do update
set reason = excluded.reason,
    updated_at = now();
