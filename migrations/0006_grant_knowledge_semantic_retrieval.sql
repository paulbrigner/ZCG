create extension if not exists vector;

alter table grant_knowledge_documents
  add column if not exists embedding vector(1024),
  add column if not exists embedding_model text,
  add column if not exists embedding_dims integer,
  add column if not exists embedding_content_hash text,
  add column if not exists embedding_indexed_at timestamptz;

create index if not exists grant_knowledge_documents_embedding_model_idx
  on grant_knowledge_documents(embedding_model, embedding_dims)
  where embedding is not null;

create index if not exists grant_knowledge_documents_embedding_hash_idx
  on grant_knowledge_documents(embedding_content_hash)
  where embedding_content_hash is not null;

create index if not exists grant_knowledge_documents_embedding_hnsw_cosine_idx
  on grant_knowledge_documents
  using hnsw ((embedding::vector(1024)) vector_cosine_ops)
  where embedding is not null
    and embedding_model = 'text-embedding-bge-m3'
    and embedding_dims = 1024;

insert into permissions (permission_key, name, description)
values
  ('knowledge:semantic', 'Use semantic grant retrieval', 'Can run embedding-backed semantic and hybrid grant knowledge searches.')
on conflict (permission_key) do update
set name = excluded.name,
    description = excluded.description;

insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.permission_key = 'knowledge:semantic'
where r.role_key in ('admin', 'committee')
on conflict do nothing;
