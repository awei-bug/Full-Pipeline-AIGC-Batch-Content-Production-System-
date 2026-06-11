create table if not exists content_platform.creation_requests (
  id text primary key,
  request_no text not null unique,
  project_id text not null references content_platform.projects(id) on delete cascade,
  user_id text not null references content_platform.users(id),
  request_type text not null,
  prompt_text text not null,
  style_code text,
  aspect_ratio text,
  status text not null default 'created',
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_content_platform_creation_requests_project_created_at
  on content_platform.creation_requests(project_id, created_at desc);

create table if not exists content_platform.generation_tasks (
  id text primary key,
  task_no text not null unique,
  creation_request_id text not null references content_platform.creation_requests(id) on delete cascade,
  project_id text not null references content_platform.projects(id) on delete cascade,
  user_id text not null references content_platform.users(id),
  task_type text not null,
  status text not null,
  current_stage text not null,
  provider_code text,
  retry_count integer not null default 0,
  max_retry_count integer not null default 0,
  progress integer not null default 0,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists idx_content_platform_generation_tasks_project_created_at
  on content_platform.generation_tasks(project_id, created_at desc);

create index if not exists idx_content_platform_generation_tasks_status
  on content_platform.generation_tasks(status, created_at desc);

create table if not exists content_platform.task_status_histories (
  id text primary key,
  task_id text not null references content_platform.generation_tasks(id) on delete cascade,
  from_status text,
  to_status text not null,
  stage_name text not null,
  change_reason text,
  operator_type text not null default 'system',
  operator_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_content_platform_task_histories_task_created_at
  on content_platform.task_status_histories(task_id, created_at asc);

create table if not exists content_platform.works (
  id text primary key,
  work_no text not null unique,
  project_id text not null references content_platform.projects(id) on delete cascade,
  creation_request_id text references content_platform.creation_requests(id),
  title text not null,
  work_type text not null,
  status text not null default 'draft',
  visibility text not null default 'private',
  latest_version_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists content_platform.work_versions (
  id text primary key,
  work_id text not null references content_platform.works(id) on delete cascade,
  generation_task_id text references content_platform.generation_tasks(id),
  version_no integer not null,
  version_type text not null default 'original',
  prompt_snapshot text,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  unique(work_id, version_no)
);

create table if not exists content_platform.media_assets (
  id text primary key,
  asset_no text not null unique,
  project_id text not null references content_platform.projects(id) on delete cascade,
  asset_type text not null,
  storage_provider text not null,
  object_key text not null,
  file_name text,
  mime_type text,
  file_size bigint,
  width integer,
  height integer,
  duration_sec integer,
  status text not null default 'ready',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists content_platform.work_asset_relations (
  id text primary key,
  work_version_id text not null references content_platform.work_versions(id) on delete cascade,
  asset_id text not null references content_platform.media_assets(id) on delete cascade,
  relation_type text not null,
  sort_no integer not null default 1,
  created_at timestamptz not null default now()
);
