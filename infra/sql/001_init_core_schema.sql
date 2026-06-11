create schema if not exists content_platform;

create table if not exists content_platform.users (
  id text primary key,
  user_no text not null unique,
  username text not null,
  email text,
  status text not null default 'active',
  tenant_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists content_platform.projects (
  id text primary key,
  project_no text not null unique,
  name text not null,
  slug text not null unique,
  description text,
  status text not null default 'draft',
  owner_user_id text not null references content_platform.users(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_content_platform_projects_owner_created_at
  on content_platform.projects(owner_user_id, created_at desc);

create table if not exists content_platform.project_members (
  id text primary key,
  project_id text not null references content_platform.projects(id) on delete cascade,
  user_id text not null references content_platform.users(id),
  role_code text not null,
  status text not null default 'active',
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, user_id)
);

insert into content_platform.users(id, user_no, username, email, status)
values ('user_demo', 'U_DEMO', '演示用户', 'demo@example.com', 'active')
on conflict (id) do update
set username = excluded.username,
    email = excluded.email,
    status = excluded.status,
    updated_at = now();
