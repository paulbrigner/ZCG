alter table source_links
  add column if not exists relationship_role text not null default 'source_evidence';

create index if not exists source_links_relationship_role_idx
  on source_links(canonical_type, relationship_role, canonical_id);
