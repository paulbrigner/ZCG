create table if not exists grant_decision_sources (
  id uuid primary key default gen_random_uuid(),
  source_record_id uuid not null unique references source_records(id) on delete cascade,
  forum_topic_id integer,
  topic_url text not null,
  title text not null,
  meeting_date date,
  parser_version text not null,
  content_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists grant_decision_sources_meeting_date_idx
  on grant_decision_sources(meeting_date desc, updated_at desc);

create table if not exists grant_decision_mentions (
  id uuid primary key default gen_random_uuid(),
  mention_key text not null unique,
  decision_source_id uuid not null references grant_decision_sources(id) on delete cascade,
  application_id uuid references grant_applications(id) on delete set null,
  linked_source_record_id uuid references source_records(id) on delete set null,
  linked_source_url text,
  candidate_title text not null,
  normalized_decision text not null default 'unknown',
  decision_text text,
  rationale_text text,
  speaker_notes jsonb not null default '[]'::jsonb,
  match_method text not null default 'unmatched',
  confidence numeric(5, 4) not null default 0 check (confidence >= 0 and confidence <= 1),
  review_status text not null default 'needs_review' check (review_status in ('accepted', 'needs_review', 'dismissed', 'stale')),
  content_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists grant_decision_mentions_application_idx
  on grant_decision_mentions(application_id, review_status, updated_at desc)
  where application_id is not null;

create index if not exists grant_decision_mentions_status_idx
  on grant_decision_mentions(review_status, normalized_decision, updated_at desc);

create index if not exists grant_decision_mentions_source_idx
  on grant_decision_mentions(decision_source_id, review_status);

create index if not exists grant_decision_mentions_title_idx
  on grant_decision_mentions using gin (to_tsvector('english', coalesce(candidate_title, '') || ' ' || coalesce(rationale_text, '')));
