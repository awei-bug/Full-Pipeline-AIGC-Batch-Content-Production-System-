create table if not exists content_platform.credit_accounts (
  id text primary key,
  owner_type text not null,
  owner_id text not null,
  available_credits integer not null default 0,
  frozen_credits integer not null default 0,
  used_credits integer not null default 0,
  version_no integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_type, owner_id)
);

create table if not exists content_platform.credit_transactions (
  id text primary key,
  account_id text not null references content_platform.credit_accounts(id) on delete cascade,
  owner_type text not null,
  owner_id text not null,
  biz_type text not null,
  biz_no text not null,
  change_amount integer not null,
  before_amount integer not null,
  after_amount integer not null,
  remark text,
  created_at timestamptz not null default now(),
  unique(biz_type, biz_no)
);

insert into content_platform.credit_accounts(
  id,
  owner_type,
  owner_id,
  available_credits,
  frozen_credits,
  used_credits
)
values (
  'credit_demo_user',
  'user',
  'user_demo',
  1000,
  0,
  0
)
on conflict (owner_type, owner_id) do update
set updated_at = now();
