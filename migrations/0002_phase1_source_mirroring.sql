alter table sync_runs
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table source_records
  add column if not exists title text,
  add column if not exists summary text,
  add column if not exists raw_payload jsonb not null default '{}'::jsonb,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists source_records_kind_updated_idx
  on source_records(source_kind, source_updated_at desc);

create index if not exists source_records_title_idx
  on source_records using gin (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, '')));

insert into permissions (permission_key, name, description)
values
  ('source:mirror:read', 'Read source mirror', 'Can inspect mirrored source records and sync evidence.')
on conflict (permission_key) do update
set name = excluded.name,
    description = excluded.description;

insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.permission_key = 'source:mirror:read'
where r.role_key in ('admin', 'committee', 'fpf_ops', 'finance')
on conflict do nothing;
