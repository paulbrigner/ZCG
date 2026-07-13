create table if not exists public_knowledge_search_rate_limits (
  scope text not null check (scope in ('client_minute', 'global_day')),
  scope_key text not null,
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (scope, scope_key, window_start)
);

create index if not exists public_knowledge_search_rate_limits_window_idx
  on public_knowledge_search_rate_limits(window_start);

create table if not exists public_knowledge_search_telemetry (
  usage_date date not null,
  requested_mode text not null check (requested_mode in ('keyword', 'semantic', 'hybrid')),
  served_mode text not null check (served_mode in ('keyword', 'semantic', 'hybrid')),
  outcome text not null check (
    outcome in (
      'served',
      'rate_limited_fallback',
      'control_unavailable_fallback',
      'provider_error_fallback',
      'error'
    )
  ),
  request_count integer not null default 0 check (request_count >= 0),
  last_seen_at timestamptz not null default now(),
  primary key (usage_date, requested_mode, served_mode, outcome)
);

create index if not exists public_knowledge_search_telemetry_date_idx
  on public_knowledge_search_telemetry(usage_date desc);
