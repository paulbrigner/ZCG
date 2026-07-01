create table if not exists grant_knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  document_key text not null unique,
  application_id uuid not null references grant_applications(id) on delete cascade,
  source_record_id uuid references source_records(id) on delete set null,
  document_kind text not null,
  title text not null,
  applicant_name text,
  source_kind text,
  source_id text,
  source_url text,
  normalized_status text,
  requested_amount_usd numeric,
  content text not null,
  content_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  search_tsv tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(applicant_name, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'C')
  ) stored,
  indexed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists grant_knowledge_documents_application_idx
  on grant_knowledge_documents(application_id);

create index if not exists grant_knowledge_documents_source_record_idx
  on grant_knowledge_documents(source_record_id);

create index if not exists grant_knowledge_documents_kind_idx
  on grant_knowledge_documents(document_kind);

create index if not exists grant_knowledge_documents_search_idx
  on grant_knowledge_documents using gin(search_tsv);

create table if not exists grant_knowledge_queries (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid references principals(id) on delete set null,
  query_text text not null,
  retrieval_mode text not null,
  result_count integer not null default 0,
  answer_mode text not null default 'evidence',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists grant_knowledge_queries_created_idx
  on grant_knowledge_queries(created_at desc);

insert into permissions (permission_key, name, description)
values
  ('knowledge:search', 'Search grant knowledge', 'Can search grounded grant knowledge retrieval.'),
  ('knowledge:index', 'Index grant knowledge', 'Can rebuild grant knowledge retrieval documents.'),
  ('knowledge:compose', 'Compose grant knowledge answers', 'Can generate AI-assisted grounded answers from retrieved grant evidence.')
on conflict (permission_key) do update
set name = excluded.name,
    description = excluded.description;

insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.permission_key in (
  'knowledge:search',
  'knowledge:index',
  'knowledge:compose'
)
where r.role_key = 'admin'
on conflict do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.permission_key in (
  'knowledge:search',
  'knowledge:compose'
)
where r.role_key = 'committee'
on conflict do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.permission_key = 'knowledge:search'
where r.role_key in ('fpf_ops', 'finance')
on conflict do nothing;
