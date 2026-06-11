create table if not exists content_platform.story_characters (
  id text primary key,
  project_id text not null references content_platform.projects(id) on delete cascade,
  character_no text not null unique,
  name text not null,
  role_type text not null default 'main',
  summary text,
  appearance_profile jsonb not null default '{}'::jsonb,
  style_profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_content_platform_story_characters_project
  on content_platform.story_characters(project_id, created_at desc);

create table if not exists content_platform.story_scenes (
  id text primary key,
  project_id text not null references content_platform.projects(id) on delete cascade,
  scene_no text not null unique,
  title text not null,
  summary text,
  setting_profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_content_platform_story_scenes_project
  on content_platform.story_scenes(project_id, created_at desc);

create table if not exists content_platform.story_storyboards (
  id text primary key,
  project_id text not null references content_platform.projects(id) on delete cascade,
  storyboard_no text not null unique,
  title text not null,
  chapter_title text,
  status text not null default 'draft',
  source_script text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists content_platform.story_shots (
  id text primary key,
  storyboard_id text not null references content_platform.story_storyboards(id) on delete cascade,
  shot_no text not null unique,
  title text not null,
  shot_order integer not null,
  shot_type text not null default 'panel',
  prompt_text text,
  camera_profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_content_platform_story_shots_storyboard_order
  on content_platform.story_shots(storyboard_id, shot_order asc);
