-- Independent-store SaaS commerce domain (global English storefront + PayPal later)
create schema if not exists commerce;

create table if not exists commerce.users (
  id text primary key,
  email text not null unique,
  password_hash text not null,
  display_name text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

create table if not exists commerce.stores (
  id text primary key,
  owner_user_id text not null references commerce.users(id),
  name text not null,
  slug text not null unique,
  currency text not null default 'USD',
  support_email text,
  logo_url text,
  flat_shipping_cents integer not null default 0,
  status text not null default 'active',
  plan_code text not null default 'free',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_commerce_stores_owner
  on commerce.stores(owner_user_id, created_at desc);

create table if not exists commerce.store_members (
  id text primary key,
  store_id text not null references commerce.stores(id) on delete cascade,
  user_id text not null references commerce.users(id) on delete cascade,
  role_code text not null default 'owner',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique(store_id, user_id)
);

create table if not exists commerce.products (
  id text primary key,
  store_id text not null references commerce.stores(id) on delete cascade,
  title text not null,
  handle text not null,
  description text not null default '',
  status text not null default 'draft',
  primary_image_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(store_id, handle)
);

create index if not exists idx_commerce_products_store_status
  on commerce.products(store_id, status, created_at desc);

create table if not exists commerce.product_variants (
  id text primary key,
  product_id text not null references commerce.products(id) on delete cascade,
  store_id text not null references commerce.stores(id) on delete cascade,
  sku text,
  title text not null default 'Default',
  price_cents integer not null check (price_cents >= 0),
  compare_at_cents integer,
  stock integer not null default 0 check (stock >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_commerce_variants_product
  on commerce.product_variants(product_id);

create table if not exists commerce.orders (
  id text primary key,
  store_id text not null references commerce.stores(id) on delete cascade,
  order_no text not null,
  email text not null,
  status text not null default 'pending_payment',
  currency text not null default 'USD',
  subtotal_cents integer not null default 0,
  shipping_cents integer not null default 0,
  total_cents integer not null default 0,
  shipping_address jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  fulfilled_at timestamptz,
  unique(store_id, order_no)
);

create index if not exists idx_commerce_orders_store_status
  on commerce.orders(store_id, status, created_at desc);

create table if not exists commerce.order_items (
  id text primary key,
  order_id text not null references commerce.orders(id) on delete cascade,
  store_id text not null references commerce.stores(id) on delete cascade,
  product_id text,
  variant_id text,
  title text not null,
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null,
  line_total_cents integer not null
);

create table if not exists commerce.payments (
  id text primary key,
  order_id text not null references commerce.orders(id) on delete cascade,
  store_id text not null references commerce.stores(id) on delete cascade,
  provider text not null default 'paypal',
  provider_ref text,
  status text not null default 'created',
  amount_cents integer not null,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_commerce_payments_provider_ref
  on commerce.payments(provider, provider_ref)
  where provider_ref is not null;

create table if not exists commerce.shipments (
  id text primary key,
  order_id text not null references commerce.orders(id) on delete cascade,
  store_id text not null references commerce.stores(id) on delete cascade,
  carrier text,
  tracking_no text,
  shipped_at timestamptz,
  created_at timestamptz not null default now()
);
