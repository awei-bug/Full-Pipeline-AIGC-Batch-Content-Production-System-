-- Additive migration for deployments that already applied 006 without sessions
create schema if not exists commerce;

create table if not exists commerce.sessions (
  token text primary key,
  user_id text not null references commerce.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_commerce_sessions_user
  on commerce.sessions(user_id);

create index if not exists idx_commerce_sessions_expires
  on commerce.sessions(expires_at);
