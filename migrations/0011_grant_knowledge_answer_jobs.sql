create table if not exists grant_knowledge_answer_jobs (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid references principals(id) on delete set null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'expired')),
  query_text text not null,
  retrieval_mode text not null,
  answer_mode text not null default 'ai',
  limit_value integer not null default 8,
  request_payload jsonb not null default '{}'::jsonb,
  result_payload jsonb,
  error_message text,
  attempt_count integer not null default 0,
  max_attempts integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '72 hours')
);

create index if not exists grant_knowledge_answer_jobs_status_created_idx
  on grant_knowledge_answer_jobs(status, created_at desc);

create index if not exists grant_knowledge_answer_jobs_principal_created_idx
  on grant_knowledge_answer_jobs(principal_id, created_at desc);

create index if not exists grant_knowledge_answer_jobs_expires_idx
  on grant_knowledge_answer_jobs(expires_at);
