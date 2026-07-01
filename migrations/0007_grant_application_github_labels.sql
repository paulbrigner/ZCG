create table if not exists grant_application_github_labels (
  application_id uuid not null references grant_applications(id) on delete cascade,
  label_name text not null,
  label_slug text not null,
  label_color text,
  label_description text,
  label_category text not null default 'other',
  label_status text,
  milestone_number integer,
  label_order integer not null default 1000,
  source_record_id uuid references source_records(id) on delete set null,
  source_url text,
  observed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (application_id, label_name)
);

create index if not exists grant_application_github_labels_category_idx
  on grant_application_github_labels(label_category, label_status, label_order);

create index if not exists grant_application_github_labels_milestone_idx
  on grant_application_github_labels(application_id, milestone_number)
  where milestone_number is not null;
