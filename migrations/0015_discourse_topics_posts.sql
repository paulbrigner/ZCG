create table if not exists discourse_topics (
  id uuid primary key default gen_random_uuid(),
  forum_host text not null default 'forum.zcashcommunity.com',
  topic_id bigint not null check (topic_id > 0),
  canonical_url text not null,
  slug text,
  title text,
  fancy_title text,
  category_id bigint,
  tags jsonb not null default '[]'::jsonb,
  reported_post_count integer check (reported_post_count is null or reported_post_count >= 0),
  stream_post_count integer not null default 0 check (stream_post_count >= 0),
  stream_post_ids jsonb not null default '[]'::jsonb,
  coverage_complete boolean not null default false,
  coverage_capped boolean not null default false,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  last_posted_at timestamptz,
  last_sync_run_id uuid references sync_runs(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (forum_host, topic_id)
);

create unique index if not exists discourse_topics_canonical_url_idx
  on discourse_topics(canonical_url);

create index if not exists discourse_topics_coverage_idx
  on discourse_topics(coverage_complete, source_updated_at desc);

create table if not exists discourse_posts (
  id uuid primary key default gen_random_uuid(),
  discourse_topic_id uuid not null references discourse_topics(id) on delete cascade,
  post_id bigint not null check (post_id > 0),
  post_number integer check (post_number is null or post_number > 0),
  post_type integer,
  reply_to_post_number integer,
  username text,
  display_name text,
  created_at_source timestamptz,
  updated_at_source timestamptz,
  cooked_html text,
  plain_text text not null default '',
  permalink text not null,
  content_hash text not null,
  deleted_at timestamptz,
  last_sync_run_id uuid references sync_runs(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (discourse_topic_id, post_id)
);

create index if not exists discourse_posts_topic_number_idx
  on discourse_posts(discourse_topic_id, post_number)
  where deleted_at is null;

create index if not exists discourse_posts_post_id_idx
  on discourse_posts(post_id);

create table if not exists discourse_topic_references (
  id uuid primary key default gen_random_uuid(),
  discourse_topic_id uuid not null references discourse_topics(id) on delete cascade,
  source_record_id uuid references source_records(id) on delete cascade,
  referenced_url text not null,
  referenced_post_number integer check (referenced_post_number is null or referenced_post_number > 0),
  reference_kind text not null default 'source_record',
  first_seen_sync_run_id uuid references sync_runs(id) on delete set null,
  last_seen_sync_run_id uuid references sync_runs(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists discourse_topic_references_source_idx
  on discourse_topic_references(discourse_topic_id, source_record_id, referenced_url)
  where source_record_id is not null;

create unique index if not exists discourse_topic_references_url_idx
  on discourse_topic_references(discourse_topic_id, referenced_url)
  where source_record_id is null;

create index if not exists discourse_topic_references_post_idx
  on discourse_topic_references(discourse_topic_id, referenced_post_number)
  where referenced_post_number is not null;
