create table if not exists content_platform.import_batches (
  id text primary key,
  file_name text not null,
  field_mapping jsonb not null default '{}'::jsonb,
  product_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_content_platform_import_batches_created_at
  on content_platform.import_batches(created_at desc);

create table if not exists content_platform.products (
  id text primary key,
  import_batch_id text not null references content_platform.import_batches(id) on delete cascade,
  source_row_no integer not null,
  original_data jsonb not null default '{}'::jsonb,
  normalized_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_content_platform_products_batch_source_row
  on content_platform.products(import_batch_id, source_row_no asc);

create table if not exists content_platform.content_jobs (
  id text primary key,
  job_no text not null unique,
  import_batch_id text not null references content_platform.import_batches(id) on delete cascade,
  status text not null default 'created',
  content_types jsonb not null default '[]'::jsonb,
  progress integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table if not exists content_platform.content_job_items (
  id text primary key,
  job_id text not null references content_platform.content_jobs(id) on delete cascade,
  product_id text not null references content_platform.products(id) on delete cascade,
  status text not null default 'pending',
  result_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_content_platform_content_job_items_job_created_at
  on content_platform.content_job_items(job_id, created_at asc);

create table if not exists content_platform.content_outputs (
  id text primary key,
  job_item_id text not null references content_platform.content_job_items(id) on delete cascade,
  output_type text not null,
  output_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists content_platform.prompt_templates (
  id text primary key,
  template_no text not null unique,
  template_type text not null,
  channel_code text not null default 'default',
  version_no integer not null default 1,
  template_body text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists content_platform.risk_events (
  id text primary key,
  subject_type text not null,
  subject_id text not null,
  risk_code text not null,
  risk_message text not null,
  severity text not null default 'medium',
  created_at timestamptz not null default now()
);

create table if not exists content_platform.usage_metrics (
  id text primary key,
  subject_type text not null,
  subject_id text not null,
  metric_type text not null,
  metric_value numeric not null default 0,
  metric_unit text not null default 'count',
  created_at timestamptz not null default now()
);
