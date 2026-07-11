insert into email_domain_role_assignments (domain, role_id, reason)
select 'fpriv.org', roles.id, 'Default FPF domain access for operational workflow review'
  from roles
 where roles.role_key = 'fpf_ops'
on conflict (domain, role_id) do update
set reason = excluded.reason,
    updated_at = now();
