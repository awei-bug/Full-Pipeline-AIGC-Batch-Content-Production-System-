-- Latest sync attempt per content job; no credentials or response bodies are stored.
create table if not exists content_platform.hub_sync_status (
  job_id text primary key references content_platform.content_jobs(id) on delete cascade,
  attempt_id text not null,
  status text not null,
  message text not null default '',
  received integer not null default 0,
  succeeded integer not null default 0,
  failed integer not null default 0,
  updated_at timestamptz not null default now()
);
