create table if not exists email_role_assignments (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role_id uuid not null references roles(id) on delete cascade,
  granted_by_principal_id uuid references principals(id),
  reason text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (email, role_id),
  check (email = lower(email))
);

create index if not exists email_role_assignments_email_idx
  on email_role_assignments(email);

create index if not exists email_role_assignments_role_idx
  on email_role_assignments(role_id);
