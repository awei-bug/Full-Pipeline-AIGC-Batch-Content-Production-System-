# Commerce SaaS skeleton

Independent-store SaaS bootstrap for a **global English storefront** with **PayPal-first** payments (payment wiring is next).

## What landed in Week 1

```text
apps/
  commerce-api/     Node API: auth, stores, products, storefront read APIs
  seller-admin/     Seller console: register/login, open store, add products
  storefront/       English buyer shell: /s/:slug and product detail

infra/sql/
  006_commerce_domain.sql   Commerce schema (users/stores/products/orders/payments...)

scripts/
  init-commerce-schema.js   Apply commerce SQL to PostgreSQL
```

Runtime repository selection:

1. If `DATABASE_URL` / `PG*` is set **and** commerce schema is applied → **Postgres**
2. Otherwise → **memory** (still fine for local UI demos)

Schema files:

- `infra/sql/006_commerce_domain.sql`
- `infra/sql/007_commerce_sessions.sql`
- `infra/sql/008_commerce_carts.sql`

## Ports

| App | URL |
|---|---|
| commerce-api | http://127.0.0.1:3200 |
| seller-admin | http://127.0.0.1:5174 |
| storefront | http://127.0.0.1:3000 |

## Install

From repo root:

```powershell
npm install
```

## Run (3 terminals)

```powershell
npm run dev:commerce
```

```powershell
npm run dev:seller
```

```powershell
npm run dev:storefront
```

## API surface (current)

Auth
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`

Stores
- `GET /api/stores`
- `POST /api/stores`
- `GET /api/stores/by-slug/:slug`

Products
- `GET /api/stores/:storeId/products`
- `POST /api/stores/:storeId/products`
- `GET /api/stores/:storeId/products/:productId`
- `PATCH /api/stores/:storeId/products/:productId`
- `DELETE /api/stores/:storeId/products/:productId`
- `POST /api/stores/:storeId/products/:productId/generate-content`
  - body: `{ apply?: true, audience?, category?, sellingPoint? }`
  - writes English title/description (+ sellingPoints metadata)

Orders
- `GET /api/stores/:storeId/orders`
- `POST /api/stores/:storeId/orders` (manual/demo order until PayPal)
- `GET /api/stores/:storeId/orders/:orderId`
- `POST /api/stores/:storeId/orders/:orderId/fulfill`
- `POST /api/stores/:storeId/orders/:orderId/cancel` (unpaid only)

Carts
- `POST /api/carts` body: `{ storeId | storeSlug, email? }`
- `GET /api/carts/:cartId`
- `POST /api/carts/:cartId/items` body: `{ productId, quantity }`
- `PATCH /api/carts/:cartId/items/:itemId` body: `{ quantity }` (0 removes)
- `DELETE /api/carts/:cartId/items/:itemId`
- `PATCH /api/carts/:cartId` body: `{ email }`
- `POST /api/carts/:cartId/checkout` body: `{ email, shippingAddress }`
  → creates `pending_payment` order and marks cart `checked_out`

Payments (PayPal)
- `POST /api/payments/paypal/create` body: `{ orderId, storeSlug? }`
  → returns `approveUrl` (mock or sandbox)
- `POST /api/payments/paypal/capture` body: `{ paypalOrderId }`
  → marks order `paid`, payment `captured`
- `POST /api/webhooks/paypal`
  → webhook handler for capture/order completed events

Storefront
- `GET /api/storefront/:slug`
- `GET /api/storefront/:slug/products/:handle`
- `GET /api/storefront/:slug/orders/:orderId`

## Postgres

```powershell
# set PG* or DATABASE_URL first
npm run db:init:commerce
npm run dev:commerce
# GET /api/health → repository: "postgres"
```

If schema is missing, API logs a warning and falls back to memory.

## Tests

```powershell
npm run test:commerce
```

With Postgres env configured, integration tests against the real DB also run.
Without DB env, those tests are skipped.

## PayPal setup

Default mode is **mock** (no credentials needed).

For sandbox:

```powershell
$env:PAYPAL_MODE="sandbox"
$env:PAYPAL_CLIENT_ID="your-sandbox-client-id"
$env:PAYPAL_CLIENT_SECRET="your-sandbox-secret"
$env:STOREFRONT_BASE_URL="http://127.0.0.1:3000"
npm run dev:commerce
```

Buyer flow:
1. Cart → Checkout → redirects to PayPal approve URL
2. Return URL captures payment
3. Order becomes `paid` (seller admin can fulfill)

Webhook (optional for sandbox hardening):
- endpoint: `POST /api/webhooks/paypal`

## Inventory rules

- Add-to-cart checks available stock
- Creating an order checks stock again
- Stock is deducted when order becomes **paid**
  - PayPal capture
  - Demo/manual paid order
- Already-paid capture retries do not double-deduct

## Pending payment timeout

- Default timeout: **30 minutes** (`PENDING_ORDER_TIMEOUT_MINUTES`)
- Background sweeper cancels `pending_payment` orders older than timeout
- Interval: `PENDING_ORDER_SWEEP_INTERVAL_MS` (default 60s)
- Seller can also cancel unpaid orders manually

## AI product content

Seller admin **AI fill** calls commerce-api, which:

1. prefers `AI_ORCHESTRATOR_BASE_URL` → `POST /internal/commerce/product-copy`
2. falls back to local English template if orchestrator is down/missing

```powershell
$env:AI_ORCHESTRATOR_BASE_URL="http://127.0.0.1:8110"
npm run dev:commerce
npm run dev:orchestrator
```

## Not in this skeleton yet

- Hard inventory reservation at checkout (hold until pay timeout)
- Custom domains
- Live multi-currency settlement
- Bulk AI generation for entire catalog
