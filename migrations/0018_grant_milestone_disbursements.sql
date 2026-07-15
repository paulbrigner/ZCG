create table if not exists grant_milestones (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references grant_applications(id) on delete cascade,
  source_record_id uuid not null unique references source_records(id) on delete cascade,
  milestone_label text not null,
  milestone_number integer,
  milestone_type text not null check (milestone_type in ('startup_funding', 'numbered', 'named')),
  reporting_frequency text,
  category text,
  grantee_name text,
  amount_usd numeric(14, 2),
  estimate_text text,
  estimated_at date,
  grant_status text,
  match_confidence numeric(5, 4) not null check (match_confidence >= 0 and match_confidence <= 1),
  linkage_method text not null check (linkage_method in ('exact', 'reviewer_confirmed', 'similarity')),
  source_url text,
  source_row_number integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (milestone_type = 'numbered' and milestone_number is not null and milestone_number > 0)
    or (milestone_type <> 'numbered' and milestone_number is null)
  ),
  unique (id, application_id, source_record_id)
);

create index if not exists grant_milestones_application_order_idx
  on grant_milestones(application_id, milestone_type, milestone_number, source_row_number);

create table if not exists grant_disbursements (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null unique,
  application_id uuid not null,
  source_record_id uuid not null unique,
  paid_at date,
  zec_amount numeric(24, 8),
  usd_amount numeric(14, 2),
  exchange_rate_usd_per_zec numeric(18, 8),
  source_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (num_nonnulls(paid_at, zec_amount, usd_amount) >= 1),
  foreign key (milestone_id, application_id, source_record_id)
    references grant_milestones(id, application_id, source_record_id)
    on update cascade
    on delete cascade
);

create index if not exists grant_disbursements_application_paid_at_idx
  on grant_disbursements(application_id, paid_at desc);
