import crypto from "node:crypto";

import { createSessionToken, hashPassword, sessionExpiry, verifyPassword } from "../lib/auth.js";
import {
  isUniqueViolation,
  mapCartRow,
  mapOrderRow,
  mapProductRow,
  mapStoreRow,
  mapUserRow,
  nextOrderNo,
  randomProductHandle,
  slugify,
} from "../lib/commerce-mappers.js";

export class PostgresCommerceRepository {
  constructor(pool) {
    if (!pool) {
      throw new Error("Postgres pool is required");
    }
    this.pool = pool;
    this.mode = "postgres";
  }

  async createUser({ email, password, displayName }) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail || !password) {
      const error = new Error("Email and password are required");
      error.code = "INVALID_PARAM";
      throw error;
    }

    const id = `user_${crypto.randomUUID()}`;
    const passwordHash = hashPassword(password);
    const name = String(displayName || normalizedEmail.split("@")[0]).trim();

    try {
      const result = await this.pool.query(
        `insert into commerce.users (id, email, password_hash, display_name, status)
         values ($1, $2, $3, $4, 'active')
         returning id, email, display_name, status, created_at`,
        [id, normalizedEmail, passwordHash, name],
      );
      return mapUserRow(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const conflict = new Error("Email already registered");
        conflict.code = "CONFLICT";
        throw conflict;
      }
      throw error;
    }
  }

  async authenticate({ email, password }) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const result = await this.pool.query(
      `select id, email, password_hash, display_name, status, created_at
       from commerce.users
       where email = $1
       limit 1`,
      [normalizedEmail],
    );
    const row = result.rows[0];
    if (!row || !verifyPassword(password, row.password_hash)) {
      const error = new Error("Invalid email or password");
      error.code = "UNAUTHORIZED";
      throw error;
    }
    return mapUserRow(row);
  }

  async createSession(userId) {
    const token = createSessionToken();
    const expiresAt = sessionExpiry();
    await this.pool.query(
      `insert into commerce.sessions (token, user_id, expires_at)
       values ($1, $2, $3::timestamptz)`,
      [token, userId, expiresAt],
    );
    return { token, expiresAt };
  }

  async getUserBySessionToken(token) {
    const normalized = String(token || "").trim();
    if (!normalized) {
      return null;
    }

    const result = await this.pool.query(
      `select u.id, u.email, u.display_name, u.status, u.created_at, s.expires_at
       from commerce.sessions s
       join commerce.users u on u.id = s.user_id
       where s.token = $1
       limit 1`,
      [normalized],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      await this.pool.query(`delete from commerce.sessions where token = $1`, [normalized]);
      return null;
    }

    return mapUserRow(row);
  }

  async createStore({ ownerUserId, name, slug, supportEmail }) {
    const normalizedSlug = slugify(slug || name);
    if (!normalizedSlug) {
      const error = new Error("Store slug is required");
      error.code = "INVALID_PARAM";
      throw error;
    }

    const storeId = `store_${crypto.randomUUID()}`;
    const memberId = `member_${crypto.randomUUID()}`;
    const storeName = String(name || "").trim() || normalizedSlug;
    const support = String(supportEmail || "").trim() || null;
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      const storeResult = await client.query(
        `insert into commerce.stores (
           id, owner_user_id, name, slug, currency, support_email,
           logo_url, flat_shipping_cents, status, plan_code
         )
         values ($1, $2, $3, $4, 'USD', $5, null, 0, 'active', 'free')
         returning
           id, owner_user_id, name, slug, currency, support_email, logo_url,
           flat_shipping_cents, status, plan_code, created_at, updated_at`,
        [storeId, ownerUserId, storeName, normalizedSlug, support],
      );
      await client.query(
        `insert into commerce.store_members (id, store_id, user_id, role_code, status)
         values ($1, $2, $3, 'owner', 'active')`,
        [memberId, storeId, ownerUserId],
      );
      await client.query("commit");
      return mapStoreRow(storeResult.rows[0]);
    } catch (error) {
      await client.query("rollback");
      if (isUniqueViolation(error)) {
        const conflict = new Error("Store slug already taken");
        conflict.code = "CONFLICT";
        throw conflict;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listStoresForUser(userId) {
    const result = await this.pool.query(
      `select
         s.id, s.owner_user_id, s.name, s.slug, s.currency, s.support_email, s.logo_url,
         s.flat_shipping_cents, s.status, s.plan_code, s.created_at, s.updated_at
       from commerce.stores s
       join commerce.store_members m on m.store_id = s.id
       where m.user_id = $1 and m.status = 'active'
       order by s.created_at desc`,
      [userId],
    );
    return result.rows.map(mapStoreRow);
  }

  async getStoreBySlug(slug) {
    const result = await this.pool.query(
      `select
         id, owner_user_id, name, slug, currency, support_email, logo_url,
         flat_shipping_cents, status, plan_code, created_at, updated_at
       from commerce.stores
       where slug = $1
       limit 1`,
      [String(slug || "").trim().toLowerCase()],
    );
    return mapStoreRow(result.rows[0]);
  }

  async getStoreById(storeId) {
    const result = await this.pool.query(
      `select
         id, owner_user_id, name, slug, currency, support_email, logo_url,
         flat_shipping_cents, status, plan_code, created_at, updated_at
       from commerce.stores
       where id = $1
       limit 1`,
      [storeId],
    );
    return mapStoreRow(result.rows[0]);
  }

  async assertStoreMember(storeId, userId) {
    const result = await this.pool.query(
      `select id, store_id, user_id, role_code, status, created_at
       from commerce.store_members
       where store_id = $1 and user_id = $2 and status = 'active'
       limit 1`,
      [storeId, userId],
    );
    if (!result.rowCount) {
      const error = new Error("Forbidden for this store");
      error.code = "FORBIDDEN";
      throw error;
    }
    const row = result.rows[0];
    return {
      id: row.id,
      storeId: row.store_id,
      userId: row.user_id,
      roleCode: row.role_code,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  async createProduct({
    storeId,
    title,
    handle,
    description,
    status = "draft",
    primaryImageUrl = null,
    priceCents = 0,
    stock = 0,
    sku = null,
  }) {
    const normalizedHandle = randomProductHandle(handle || title);
    const productId = `prod_${crypto.randomUUID()}`;
    const variantId = `var_${crypto.randomUUID()}`;
    const productTitle = String(title || "").trim() || "Untitled product";
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      const productResult = await client.query(
        `insert into commerce.products (
           id, store_id, title, handle, description, status, primary_image_url, metadata
         )
         values ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb)
         returning
           id, store_id, title, handle, description, status, primary_image_url,
           metadata, created_at, updated_at`,
        [
          productId,
          storeId,
          productTitle,
          normalizedHandle,
          String(description || ""),
          status || "draft",
          primaryImageUrl,
        ],
      );
      const variantResult = await client.query(
        `insert into commerce.product_variants (
           id, product_id, store_id, sku, title, price_cents, compare_at_cents, stock
         )
         values ($1, $2, $3, $4, 'Default', $5, null, $6)
         returning
           id, product_id, store_id, sku, title, price_cents, compare_at_cents,
           stock, created_at, updated_at`,
        [variantId, productId, storeId, sku, Number(priceCents) || 0, Number(stock) || 0],
      );
      await client.query("commit");
      return mapProductRow(productResult.rows[0], [variantResult.rows[0]]);
    } catch (error) {
      await client.query("rollback");
      if (isUniqueViolation(error)) {
        const conflict = new Error("Product handle already exists in this store");
        conflict.code = "CONFLICT";
        throw conflict;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listProductsByStore(storeId, { status } = {}) {
    const params = [storeId];
    let statusClause = "";
    if (status) {
      params.push(status);
      statusClause = `and p.status = $2`;
    }

    const productResult = await this.pool.query(
      `select
         id, store_id, title, handle, description, status, primary_image_url,
         metadata, created_at, updated_at
       from commerce.products p
       where p.store_id = $1
       ${statusClause}
       order by p.created_at desc`,
      params,
    );

    if (!productResult.rowCount) {
      return [];
    }

    const productIds = productResult.rows.map((row) => row.id);
    const variantResult = await this.pool.query(
      `select
         id, product_id, store_id, sku, title, price_cents, compare_at_cents,
         stock, created_at, updated_at
       from commerce.product_variants
       where product_id = any($1::text[])
       order by created_at asc`,
      [productIds],
    );

    const variantsByProduct = new Map();
    for (const row of variantResult.rows) {
      const list = variantsByProduct.get(row.product_id) || [];
      list.push(row);
      variantsByProduct.set(row.product_id, list);
    }

    return productResult.rows.map((row) => mapProductRow(row, variantsByProduct.get(row.id) || []));
  }

  async getProductByHandle(storeId, handle) {
    const productResult = await this.pool.query(
      `select
         id, store_id, title, handle, description, status, primary_image_url,
         metadata, created_at, updated_at
       from commerce.products
       where store_id = $1 and handle = $2
       limit 1`,
      [storeId, String(handle || "").trim().toLowerCase()],
    );
    const product = productResult.rows[0];
    if (!product) {
      return null;
    }

    const variantResult = await this.pool.query(
      `select
         id, product_id, store_id, sku, title, price_cents, compare_at_cents,
         stock, created_at, updated_at
       from commerce.product_variants
       where product_id = $1
       order by created_at asc`,
      [product.id],
    );

    return mapProductRow(product, variantResult.rows);
  }

  async getProductById(storeId, productId) {
    const productResult = await this.pool.query(
      `select
         id, store_id, title, handle, description, status, primary_image_url,
         metadata, created_at, updated_at
       from commerce.products
       where store_id = $1 and id = $2
       limit 1`,
      [storeId, productId],
    );
    const product = productResult.rows[0];
    if (!product) {
      return null;
    }

    const variantResult = await this.pool.query(
      `select
         id, product_id, store_id, sku, title, price_cents, compare_at_cents,
         stock, created_at, updated_at
       from commerce.product_variants
       where product_id = $1
       order by created_at asc`,
      [product.id],
    );

    return mapProductRow(product, variantResult.rows);
  }

  async updateProduct({
    storeId,
    productId,
    title,
    handle,
    description,
    status,
    primaryImageUrl,
    priceCents,
    stock,
    sku,
    metadata,
  }) {
    const existing = await this.getProductById(storeId, productId);
    if (!existing) {
      const error = new Error("Product not found");
      error.code = "NOT_FOUND";
      throw error;
    }

    const nextHandle =
      handle !== undefined ? randomProductHandle(handle || existing.title) : existing.handle;
    const nextTitle = title !== undefined ? String(title || "").trim() || existing.title : existing.title;
    const nextDescription =
      description !== undefined ? String(description || "") : existing.description;
    const nextStatus = status !== undefined ? status : existing.status;
    const nextImage =
      primaryImageUrl !== undefined ? primaryImageUrl : existing.primaryImageUrl;
    const nextPrice =
      priceCents !== undefined ? Number(priceCents) || 0 : existing.priceCents;
    const nextStock = stock !== undefined ? Number(stock) || 0 : existing.stock;
    const nextSku = sku !== undefined ? sku : existing.variants[0]?.sku || null;
    const nextMetadata = metadata !== undefined ? metadata || {} : existing.metadata || {};

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const productResult = await client.query(
        `update commerce.products
         set title = $3,
             handle = $4,
             description = $5,
             status = $6,
             primary_image_url = $7,
             metadata = $8::jsonb,
             updated_at = now()
         where store_id = $1 and id = $2
         returning
           id, store_id, title, handle, description, status, primary_image_url,
           metadata, created_at, updated_at`,
        [
          storeId,
          productId,
          nextTitle,
          nextHandle,
          nextDescription,
          nextStatus,
          nextImage,
          JSON.stringify(nextMetadata),
        ],
      );

      let variantRows = [];
      if (existing.variants[0]?.id) {
        const variantResult = await client.query(
          `update commerce.product_variants
           set sku = $2,
               price_cents = $3,
               stock = $4,
               updated_at = now()
           where id = $1
           returning
             id, product_id, store_id, sku, title, price_cents, compare_at_cents,
             stock, created_at, updated_at`,
          [existing.variants[0].id, nextSku, nextPrice, nextStock],
        );
        variantRows = variantResult.rows;
      }
      await client.query("commit");
      return mapProductRow(productResult.rows[0], variantRows);
    } catch (error) {
      await client.query("rollback");
      if (isUniqueViolation(error)) {
        const conflict = new Error("Product handle already exists in this store");
        conflict.code = "CONFLICT";
        throw conflict;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteProduct(storeId, productId) {
    const result = await this.pool.query(
      `delete from commerce.products
       where store_id = $1 and id = $2
       returning id`,
      [storeId, productId],
    );
    if (!result.rowCount) {
      const error = new Error("Product not found");
      error.code = "NOT_FOUND";
      throw error;
    }
    return { deleted: true, productId };
  }

  async createOrder({
    storeId,
    email,
    items,
    shippingAddress = {},
    status = "paid",
    shippingCents,
  }) {
    const store = await this.getStoreById(storeId);
    if (!store) {
      const error = new Error("Store not found");
      error.code = "NOT_FOUND";
      throw error;
    }

    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail) {
      const error = new Error("Order email is required");
      error.code = "INVALID_PARAM";
      throw error;
    }

    const rawItems = Array.isArray(items) ? items : [];
    if (rawItems.length === 0) {
      const error = new Error("Order items are required");
      error.code = "INVALID_PARAM";
      throw error;
    }

    const preparedItems = [];
    let subtotalCents = 0;
    for (const raw of rawItems) {
      const quantity = Math.max(1, Number(raw.quantity) || 1);
      let title = String(raw.title || "").trim();
      let unitPriceCents = Number(raw.unitPriceCents);
      let productId = raw.productId || null;
      let variantId = raw.variantId || null;

      if (productId) {
        const product = await this.getProductById(storeId, productId);
        if (!product) {
          const error = new Error(`Product not found: ${productId}`);
          error.code = "INVALID_PARAM";
          throw error;
        }
        title = title || product.title;
        unitPriceCents = Number.isFinite(unitPriceCents) ? unitPriceCents : product.priceCents;
        variantId = variantId || product.variants[0]?.id || null;
      }

      if (variantId) {
        const stockResult = await this.pool.query(
          `select id, stock, price_cents
           from commerce.product_variants
           where id = $1 and store_id = $2
           limit 1`,
          [variantId, storeId],
        );
        const variant = stockResult.rows[0];
        if (!variant) {
          const error = new Error(`Variant not found: ${variantId}`);
          error.code = "INVALID_PARAM";
          throw error;
        }
        if (Number(variant.stock) < quantity) {
          const error = new Error(`Insufficient stock for ${title || variantId}`);
          error.code = "INVALID_PARAM";
          throw error;
        }
        if (!Number.isFinite(unitPriceCents)) {
          unitPriceCents = Number(variant.price_cents) || 0;
        }
      }

      if (!title || !Number.isFinite(unitPriceCents) || unitPriceCents < 0) {
        const error = new Error("Each order item needs title and unitPriceCents");
        error.code = "INVALID_PARAM";
        throw error;
      }

      const lineTotalCents = unitPriceCents * quantity;
      subtotalCents += lineTotalCents;
      preparedItems.push({
        id: `oi_${crypto.randomUUID()}`,
        productId,
        variantId,
        title,
        quantity,
        unitPriceCents,
        lineTotalCents,
      });
    }

    const resolvedShipping =
      shippingCents === undefined || shippingCents === null
        ? store.flatShippingCents || 0
        : Number(shippingCents) || 0;
    const allowedStatuses = new Set([
      "pending_payment",
      "paid",
      "fulfilled",
      "completed",
      "cancelled",
      "payment_failed",
    ]);
    const normalizedStatus = allowedStatuses.has(status) ? status : "paid";
    const orderId = `order_${crypto.randomUUID()}`;
    const orderNo = nextOrderNo();
    const paidAt = ["paid", "fulfilled", "completed"].includes(normalizedStatus)
      ? new Date().toISOString()
      : null;
    const fulfilledAt = ["fulfilled", "completed"].includes(normalizedStatus)
      ? new Date().toISOString()
      : null;

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const orderResult = await client.query(
        `insert into commerce.orders (
           id, store_id, order_no, email, status, currency,
           subtotal_cents, shipping_cents, total_cents, shipping_address,
           paid_at, fulfilled_at
         )
         values (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10::jsonb,
           $11::timestamptz, $12::timestamptz
         )
         returning
           id, store_id, order_no, email, status, currency,
           subtotal_cents, shipping_cents, total_cents, shipping_address,
           created_at, updated_at, paid_at, fulfilled_at`,
        [
          orderId,
          storeId,
          orderNo,
          normalizedEmail,
          normalizedStatus,
          store.currency || "USD",
          subtotalCents,
          resolvedShipping,
          subtotalCents + resolvedShipping,
          JSON.stringify(shippingAddress || {}),
          paidAt,
          fulfilledAt,
        ],
      );

      const itemRows = [];
      for (const item of preparedItems) {
        const itemResult = await client.query(
          `insert into commerce.order_items (
             id, order_id, store_id, product_id, variant_id, title,
             quantity, unit_price_cents, line_total_cents
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           returning
             id, order_id, store_id, product_id, variant_id, title,
             quantity, unit_price_cents, line_total_cents`,
          [
            item.id,
            orderId,
            storeId,
            item.productId,
            item.variantId,
            item.title,
            item.quantity,
            item.unitPriceCents,
            item.lineTotalCents,
          ],
        );
        itemRows.push(itemResult.rows[0]);
      }

      if (["paid", "fulfilled", "completed"].includes(normalizedStatus)) {
        await this.deductStockForOrderWithClient(client, orderId);
      }

      await client.query("commit");
      return mapOrderRow(orderResult.rows[0], itemRows, []);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listOrdersByStore(storeId, { status } = {}) {
    const params = [storeId];
    let statusClause = "";
    if (status) {
      params.push(status);
      statusClause = "and status = $2";
    }

    const orderResult = await this.pool.query(
      `select
         id, store_id, order_no, email, status, currency,
         subtotal_cents, shipping_cents, total_cents, shipping_address,
         created_at, updated_at, paid_at, fulfilled_at
       from commerce.orders
       where store_id = $1
       ${statusClause}
       order by created_at desc`,
      params,
    );

    if (!orderResult.rowCount) {
      return [];
    }

    return Promise.all(orderResult.rows.map((row) => this.decorateOrderRow(row)));
  }

  async getOrderById(storeId, orderId) {
    const orderResult = await this.pool.query(
      `select
         id, store_id, order_no, email, status, currency,
         subtotal_cents, shipping_cents, total_cents, shipping_address,
         created_at, updated_at, paid_at, fulfilled_at
       from commerce.orders
       where store_id = $1 and id = $2
       limit 1`,
      [storeId, orderId],
    );
    if (!orderResult.rowCount) {
      return null;
    }
    return this.decorateOrderRow(orderResult.rows[0]);
  }

  async getOrderByIdGlobal(orderId) {
    const orderResult = await this.pool.query(
      `select
         id, store_id, order_no, email, status, currency,
         subtotal_cents, shipping_cents, total_cents, shipping_address,
         created_at, updated_at, paid_at, fulfilled_at
       from commerce.orders
       where id = $1
       limit 1`,
      [orderId],
    );
    if (!orderResult.rowCount) {
      return null;
    }
    return this.decorateOrderRow(orderResult.rows[0]);
  }

  decoratePaymentRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      orderId: row.order_id,
      storeId: row.store_id,
      provider: row.provider,
      providerRef: row.provider_ref,
      status: row.status,
      amountCents: row.amount_cents,
      rawPayload: row.raw_payload || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async getPaymentByOrderId(orderId) {
    const result = await this.pool.query(
      `select
         id, order_id, store_id, provider, provider_ref, status, amount_cents,
         raw_payload, created_at, updated_at
       from commerce.payments
       where order_id = $1
       order by created_at desc
       limit 1`,
      [orderId],
    );
    return this.decoratePaymentRow(result.rows[0]);
  }

  async getPaymentByProviderRef(provider, providerRef) {
    const result = await this.pool.query(
      `select
         id, order_id, store_id, provider, provider_ref, status, amount_cents,
         raw_payload, created_at, updated_at
       from commerce.payments
       where provider = $1 and provider_ref = $2
       limit 1`,
      [provider, providerRef],
    );
    return this.decoratePaymentRow(result.rows[0]);
  }

  async upsertPaypalPayment({
    orderId,
    storeId,
    providerRef,
    amountCents,
    status = "created",
    rawPayload = {},
  }) {
    const existing = await this.pool.query(
      `select id
       from commerce.payments
       where order_id = $1 or (provider = 'paypal' and provider_ref = $2)
       order by created_at desc
       limit 1`,
      [orderId, providerRef || null],
    );

    if (existing.rowCount) {
      const result = await this.pool.query(
        `update commerce.payments
         set provider_ref = coalesce($2, provider_ref),
             status = $3,
             amount_cents = $4,
             raw_payload = $5::jsonb,
             updated_at = now()
         where id = $1
         returning
           id, order_id, store_id, provider, provider_ref, status, amount_cents,
           raw_payload, created_at, updated_at`,
        [
          existing.rows[0].id,
          providerRef || null,
          status,
          Number(amountCents) || 0,
          JSON.stringify(rawPayload || {}),
        ],
      );
      return this.decoratePaymentRow(result.rows[0]);
    }

    const result = await this.pool.query(
      `insert into commerce.payments (
         id, order_id, store_id, provider, provider_ref, status, amount_cents, raw_payload
       )
       values ($1, $2, $3, 'paypal', $4, $5, $6, $7::jsonb)
       returning
         id, order_id, store_id, provider, provider_ref, status, amount_cents,
         raw_payload, created_at, updated_at`,
      [
        `pay_${crypto.randomUUID()}`,
        orderId,
        storeId,
        providerRef || null,
        status,
        Number(amountCents) || 0,
        JSON.stringify(rawPayload || {}),
      ],
    );
    return this.decoratePaymentRow(result.rows[0]);
  }

  async cancelOrder({ storeId, orderId }) {
    const existing = await this.getOrderById(storeId, orderId);
    if (!existing) {
      const error = new Error("Order not found");
      error.code = "NOT_FOUND";
      throw error;
    }
    if (!["pending_payment", "payment_failed"].includes(existing.status)) {
      const error = new Error("Only unpaid orders can be cancelled");
      error.code = "INVALID_STATUS";
      throw error;
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const orderResult = await client.query(
        `update commerce.orders
         set status = 'cancelled',
             updated_at = now()
         where store_id = $1 and id = $2 and status in ('pending_payment', 'payment_failed')
         returning
           id, store_id, order_no, email, status, currency,
           subtotal_cents, shipping_cents, total_cents, shipping_address,
           created_at, updated_at, paid_at, fulfilled_at`,
        [storeId, orderId],
      );
      if (!orderResult.rowCount) {
        const error = new Error("Only unpaid orders can be cancelled");
        error.code = "INVALID_STATUS";
        throw error;
      }
      await client.query(
        `update commerce.payments
         set status = 'cancelled',
             updated_at = now()
         where order_id = $1 and status <> 'captured'`,
        [orderId],
      );
      await client.query("commit");
      return this.decorateOrderRow(orderResult.rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelExpiredPendingOrders({ olderThanMs = 30 * 60 * 1000 } = {}) {
    const seconds = Math.max(0, Math.floor(Number(olderThanMs) / 1000));
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const orderResult = await client.query(
        `update commerce.orders
         set status = 'cancelled',
             updated_at = now()
         where status = 'pending_payment'
           and created_at < now() - make_interval(secs => $1)
         returning
           id, store_id, order_no, email, status, currency,
           subtotal_cents, shipping_cents, total_cents, shipping_address,
           created_at, updated_at, paid_at, fulfilled_at`,
        [seconds],
      );
      const orderIds = orderResult.rows.map((row) => row.id);
      if (orderIds.length > 0) {
        await client.query(
          `update commerce.payments
           set status = 'cancelled',
               updated_at = now()
           where order_id = any($1::text[]) and status <> 'captured'`,
          [orderIds],
        );
      }
      await client.query("commit");
      return Promise.all(orderResult.rows.map((row) => this.decorateOrderRow(row)));
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async markOrderPaidByPaypal({ paypalOrderId, captureId = null, rawPayload = {} }) {
    const payment = await this.getPaymentByProviderRef("paypal", paypalOrderId);
    if (!payment) {
      const error = new Error("Payment not found");
      error.code = "NOT_FOUND";
      throw error;
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const currentOrder = await client.query(
        `select id, status
         from commerce.orders
         where id = $1
         for update`,
        [payment.orderId],
      );
      if (!currentOrder.rowCount) {
        const error = new Error("Order not found");
        error.code = "NOT_FOUND";
        throw error;
      }

      const previousStatus = currentOrder.rows[0].status;
      const shouldDeduct = ["pending_payment", "payment_failed"].includes(previousStatus);
      if (shouldDeduct) {
        await this.deductStockForOrderWithClient(client, payment.orderId);
      }

      const orderResult = await client.query(
        `update commerce.orders
         set status = case
               when status in ('pending_payment', 'payment_failed') then 'paid'
               else status
             end,
             paid_at = coalesce(paid_at, now()),
             updated_at = now()
         where id = $1
         returning
           id, store_id, order_no, email, status, currency,
           subtotal_cents, shipping_cents, total_cents, shipping_address,
           created_at, updated_at, paid_at, fulfilled_at`,
        [payment.orderId],
      );

      const paymentResult = await client.query(
        `update commerce.payments
         set status = 'captured',
             raw_payload = coalesce(raw_payload, '{}'::jsonb) || $2::jsonb,
             updated_at = now()
         where id = $1
         returning
           id, order_id, store_id, provider, provider_ref, status, amount_cents,
           raw_payload, created_at, updated_at`,
        [
          payment.id,
          JSON.stringify({
            ...(rawPayload || {}),
            captureId,
          }),
        ],
      );
      await client.query("commit");
      return {
        order: await this.decorateOrderRow(orderResult.rows[0]),
        payment: this.decoratePaymentRow(paymentResult.rows[0]),
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async deductStockForOrderWithClient(client, orderId) {
    const itemsResult = await client.query(
      `select variant_id, quantity, title
       from commerce.order_items
       where order_id = $1`,
      [orderId],
    );

    for (const item of itemsResult.rows) {
      if (!item.variant_id) continue;
      const updated = await client.query(
        `update commerce.product_variants
         set stock = stock - $2,
             updated_at = now()
         where id = $1 and stock >= $2
         returning id, stock`,
        [item.variant_id, item.quantity],
      );
      if (!updated.rowCount) {
        const error = new Error(
          `Insufficient stock while capturing payment for ${item.title || item.variant_id}`,
        );
        error.code = "INVALID_PARAM";
        throw error;
      }
    }
  }

  async fulfillOrder({ storeId, orderId, carrier, trackingNo }) {
    const existing = await this.getOrderById(storeId, orderId);
    if (!existing) {
      const error = new Error("Order not found");
      error.code = "NOT_FOUND";
      throw error;
    }
    if (!["paid", "fulfilled", "completed"].includes(existing.status)) {
      const error = new Error("Only paid orders can be fulfilled");
      error.code = "INVALID_STATUS";
      throw error;
    }

    const shipmentId = `ship_${crypto.randomUUID()}`;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const orderResult = await client.query(
        `update commerce.orders
         set status = 'fulfilled',
             fulfilled_at = coalesce(fulfilled_at, now()),
             paid_at = coalesce(paid_at, now()),
             updated_at = now()
         where store_id = $1 and id = $2
         returning
           id, store_id, order_no, email, status, currency,
           subtotal_cents, shipping_cents, total_cents, shipping_address,
           created_at, updated_at, paid_at, fulfilled_at`,
        [storeId, orderId],
      );
      await client.query(
        `insert into commerce.shipments (
           id, order_id, store_id, carrier, tracking_no, shipped_at
         )
         values ($1, $2, $3, $4, $5, now())`,
        [
          shipmentId,
          orderId,
          storeId,
          String(carrier || "").trim() || null,
          String(trackingNo || "").trim() || null,
        ],
      );
      await client.query("commit");
      return this.decorateOrderRow(orderResult.rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async decorateOrderRow(orderRow) {
    const itemResult = await this.pool.query(
      `select
         id, order_id, store_id, product_id, variant_id, title,
         quantity, unit_price_cents, line_total_cents
       from commerce.order_items
       where order_id = $1
       order by id asc`,
      [orderRow.id],
    );
    const shipmentResult = await this.pool.query(
      `select
         id, order_id, store_id, carrier, tracking_no, shipped_at, created_at
       from commerce.shipments
       where order_id = $1
       order by created_at asc`,
      [orderRow.id],
    );
    return mapOrderRow(orderRow, itemResult.rows, shipmentResult.rows);
  }

  async createCart({ storeId, email = null }) {
    const store = await this.getStoreById(storeId);
    if (!store || store.status !== "active") {
      const error = new Error("Store not found");
      error.code = "NOT_FOUND";
      throw error;
    }

    const cartId = `cart_${crypto.randomUUID()}`;
    const result = await this.pool.query(
      `insert into commerce.carts (id, store_id, currency, email, status)
       values ($1, $2, $3, $4, 'open')
       returning id, store_id, currency, email, status, created_at, updated_at`,
      [cartId, storeId, store.currency || "USD", email ? String(email).trim().toLowerCase() : null],
    );
    return mapCartRow(result.rows[0], [], store.flatShippingCents || 0);
  }

  async getCartById(cartId) {
    const cartResult = await this.pool.query(
      `select id, store_id, currency, email, status, created_at, updated_at
       from commerce.carts
       where id = $1
       limit 1`,
      [cartId],
    );
    if (!cartResult.rowCount) {
      return null;
    }
    return this.decorateCartRow(cartResult.rows[0]);
  }

  async assertOpenCartRow(cartId, storeId = null) {
    const cartResult = await this.pool.query(
      `select id, store_id, currency, email, status, created_at, updated_at
       from commerce.carts
       where id = $1
       limit 1`,
      [cartId],
    );
    const cart = cartResult.rows[0];
    if (!cart) {
      const error = new Error("Cart not found");
      error.code = "NOT_FOUND";
      throw error;
    }
    if (storeId && cart.store_id !== storeId) {
      const error = new Error("Cart does not belong to this store");
      error.code = "INVALID_PARAM";
      throw error;
    }
    if (cart.status !== "open") {
      const error = new Error("Cart is no longer open");
      error.code = "INVALID_STATUS";
      throw error;
    }
    return cart;
  }

  async addCartItem({ cartId, productId, quantity = 1 }) {
    const cart = await this.assertOpenCartRow(cartId);
    const product = await this.getProductById(cart.store_id, productId);
    if (!product || product.status !== "active") {
      const error = new Error("Product not available");
      error.code = "INVALID_PARAM";
      throw error;
    }
    const variant = product.variants[0];
    if (!variant) {
      const error = new Error("Product has no purchasable variant");
      error.code = "INVALID_PARAM";
      throw error;
    }

    const qty = Math.max(1, Number(quantity) || 1);
    if (variant.stock < qty) {
      const error = new Error("Insufficient stock");
      error.code = "INVALID_PARAM";
      throw error;
    }

    const existingResult = await this.pool.query(
      `select id, quantity
       from commerce.cart_items
       where cart_id = $1 and variant_id = $2
       limit 1`,
      [cartId, variant.id],
    );

    if (existingResult.rowCount) {
      const existing = existingResult.rows[0];
      const nextQty = Number(existing.quantity) + qty;
      if (variant.stock < nextQty) {
        const error = new Error("Insufficient stock");
        error.code = "INVALID_PARAM";
        throw error;
      }
      await this.pool.query(
        `update commerce.cart_items
         set quantity = $2,
             unit_price_cents = $3,
             line_total_cents = $3 * $2,
             title = $4,
             updated_at = now()
         where id = $1`,
        [existing.id, nextQty, variant.priceCents, product.title],
      );
    } else {
      await this.pool.query(
        `insert into commerce.cart_items (
           id, cart_id, store_id, product_id, variant_id, title,
           unit_price_cents, quantity, line_total_cents
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $7 * $8)`,
        [
          `ci_${crypto.randomUUID()}`,
          cartId,
          cart.store_id,
          product.id,
          variant.id,
          product.title,
          variant.priceCents,
          qty,
        ],
      );
    }

    await this.pool.query(`update commerce.carts set updated_at = now() where id = $1`, [cartId]);
    return this.getCartById(cartId);
  }

  async updateCartItem({ cartId, itemId, quantity }) {
    await this.assertOpenCartRow(cartId);
    const itemResult = await this.pool.query(
      `select id, cart_id, variant_id
       from commerce.cart_items
       where cart_id = $1 and id = $2
       limit 1`,
      [cartId, itemId],
    );
    if (!itemResult.rowCount) {
      const error = new Error("Cart item not found");
      error.code = "NOT_FOUND";
      throw error;
    }

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty < 0) {
      const error = new Error("Quantity must be a non-negative number");
      error.code = "INVALID_PARAM";
      throw error;
    }

    if (qty === 0) {
      await this.pool.query(`delete from commerce.cart_items where id = $1`, [itemId]);
    } else {
      const item = itemResult.rows[0];
      if (item.variant_id) {
        const stockResult = await this.pool.query(
          `select stock from commerce.product_variants where id = $1 limit 1`,
          [item.variant_id],
        );
        const stock = stockResult.rows[0]?.stock;
        if (Number.isFinite(stock) && stock < qty) {
          const error = new Error("Insufficient stock");
          error.code = "INVALID_PARAM";
          throw error;
        }
      }
      await this.pool.query(
        `update commerce.cart_items
         set quantity = $2,
             line_total_cents = unit_price_cents * $2,
             updated_at = now()
         where id = $1`,
        [itemId, qty],
      );
    }

    await this.pool.query(`update commerce.carts set updated_at = now() where id = $1`, [cartId]);
    return this.getCartById(cartId);
  }

  async removeCartItem({ cartId, itemId }) {
    return this.updateCartItem({ cartId, itemId, quantity: 0 });
  }

  async updateCartEmail({ cartId, email }) {
    await this.assertOpenCartRow(cartId);
    await this.pool.query(
      `update commerce.carts
       set email = $2,
           updated_at = now()
       where id = $1`,
      [cartId, String(email || "").trim().toLowerCase() || null],
    );
    return this.getCartById(cartId);
  }

  async checkoutCart({ cartId, email, shippingAddress = {} }) {
    const cart = await this.getCartById(cartId);
    if (!cart) {
      const error = new Error("Cart not found");
      error.code = "NOT_FOUND";
      throw error;
    }
    if (cart.status !== "open") {
      const error = new Error("Cart is no longer open");
      error.code = "INVALID_STATUS";
      throw error;
    }
    if (!cart.items.length) {
      const error = new Error("Cart is empty");
      error.code = "INVALID_PARAM";
      throw error;
    }

    const checkoutEmail = String(email || cart.email || "").trim().toLowerCase();
    if (!checkoutEmail) {
      const error = new Error("Checkout email is required");
      error.code = "INVALID_PARAM";
      throw error;
    }

    const order = await this.createOrder({
      storeId: cart.storeId,
      email: checkoutEmail,
      items: cart.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        title: item.title,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
      })),
      shippingAddress,
      status: "pending_payment",
      shippingCents: cart.shippingCents,
    });

    await this.pool.query(
      `update commerce.carts
       set status = 'checked_out',
           email = $2,
           updated_at = now()
       where id = $1`,
      [cartId, checkoutEmail],
    );

    return {
      cart: await this.getCartById(cartId),
      order,
    };
  }

  async decorateCartRow(cartRow) {
    const itemResult = await this.pool.query(
      `select
         id, cart_id, store_id, product_id, variant_id, title,
         unit_price_cents, quantity, line_total_cents, created_at, updated_at
       from commerce.cart_items
       where cart_id = $1
       order by created_at asc`,
      [cartRow.id],
    );
    const store = await this.getStoreById(cartRow.store_id);
    return mapCartRow(cartRow, itemResult.rows, store?.flatShippingCents || 0);
  }
}
