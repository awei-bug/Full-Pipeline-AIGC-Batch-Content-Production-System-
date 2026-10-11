-- Guest carts for English storefront checkout prep
create schema if not exists commerce;

create table if not exists commerce.carts (
  id text primary key,
  store_id text not null references commerce.stores(id) on delete cascade,
  currency text not null default 'USD',
  email text,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_commerce_carts_store_status
  on commerce.carts(store_id, status, updated_at desc);

create table if not exists commerce.cart_items (
  id text primary key,
  cart_id text not null references commerce.carts(id) on delete cascade,
  store_id text not null references commerce.stores(id) on delete cascade,
  product_id text references commerce.products(id) on delete set null,
  variant_id text references commerce.product_variants(id) on delete set null,
  title text not null,
  unit_price_cents integer not null check (unit_price_cents >= 0),
  quantity integer not null check (quantity > 0),
  line_total_cents integer not null check (line_total_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_commerce_cart_items_cart
  on commerce.cart_items(cart_id, created_at asc);

create unique index if not exists idx_commerce_cart_items_cart_variant
  on commerce.cart_items(cart_id, variant_id)
  where variant_id is not null;
