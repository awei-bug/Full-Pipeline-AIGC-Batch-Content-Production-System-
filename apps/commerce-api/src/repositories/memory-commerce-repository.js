import crypto from "node:crypto";

import { createSessionToken, hashPassword, sessionExpiry, verifyPassword } from "../lib/auth.js";
import { mapCartRow, nextOrderNo, randomProductHandle, slugify } from "../lib/commerce-mappers.js";

function nowIso() {
  return new Date().toISOString();
}

export class MemoryCommerceRepository {
  constructor() {
    this.mode = "memory";
    this.users = [];
    this.stores = [];
    this.members = [];
    this.products = [];
    this.variants = [];
    this.orders = [];
    this.orderItems = [];
    this.payments = [];
    this.shipments = [];
    this.carts = [];
    this.cartItems = [];
    this.sessions = new Map();
  }

  async createUser({ email, password, displayName }) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail || !password) {
      const error = new Error("Email and password are required");
      error.code = "INVALID_PARAM";
      throw error;
    }
    if (this.users.some((item) => item.email === normalizedEmail)) {
      const error = new Error("Email already registered");
      error.code = "CONFLICT";
      throw error;
    }

    const user = {
      id: `user_${crypto.randomUUID()}`,
      email: normalizedEmail,
      passwordHash: hashPassword(password),
      displayName: String(displayName || normalizedEmail.split("@")[0]).trim(),
      status: "active",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.users.push(user);
    return this.toPublicUser(user);
  }

  async authenticate({ email, password }) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const user = this.users.find((item) => item.email === normalizedEmail);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      const error = new Error("Invalid email or password");
      error.code = "UNAUTHORIZED";
      throw error;
    }
    return this.toPublicUser(user);
  }

  async createSession(userId) {
    const token = createSessionToken();
    this.sessions.set(token, {
      userId,
      expiresAt: sessionExpiry(),
    });
    return { token, expiresAt: sessionExpiry() };
  }

  async getUserBySessionToken(token) {
    const session = this.sessions.get(String(token || ""));
    if (!session) {
      return null;
    }
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    const user = this.users.find((item) => item.id === session.userId);
    return user ? this.toPublicUser(user) : null;
  }

  async createStore({ ownerUserId, name, slug, supportEmail }) {
    const normalizedSlug = slugify(slug || name);
    if (!normalizedSlug) {
      const error = new Error("Store slug is required");
      error.code = "INVALID_PARAM";
      throw error;
    }
    if (this.stores.some((item) => item.slug === normalizedSlug)) {
      const error = new Error("Store slug already taken");
      error.code = "CONFLICT";
      throw error;
    }

    const store = {
      id: `store_${crypto.randomUUID()}`,
      ownerUserId,
      name: String(name || "").trim() || normalizedSlug,
      slug: normalizedSlug,
      currency: "USD",
      supportEmail: String(supportEmail || "").trim() || null,
      logoUrl: null,
      flatShippingCents: 0,
      status: "active",
      planCode: "free",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.stores.push(store);
    this.members.push({
      id: `member_${crypto.randomUUID()}`,
      storeId: store.id,
      userId: ownerUserId,
      roleCode: "owner",
      status: "active",
      createdAt: nowIso(),
    });
    return store;
  }

  async listStoresForUser(userId) {
    const storeIds = new Set(
      this.members.filter((item) => item.userId === userId && item.status === "active").map((m) => m.storeId),
    );
    return this.stores
      .filter((store) => storeIds.has(store.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getStoreBySlug(slug) {
    return this.stores.find((item) => item.slug === String(slug || "").trim().toLowerCase()) || null;
  }

  async getStoreById(storeId) {
    return this.stores.find((item) => item.id === storeId) || null;
  }

  async assertStoreMember(storeId, userId) {
    const member = this.members.find(
      (item) => item.storeId === storeId && item.userId === userId && item.status === "active",
    );
    if (!member) {
      const error = new Error("Forbidden for this store");
      error.code = "FORBIDDEN";
      throw error;
    }
    return member;
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
    if (this.products.some((item) => item.storeId === storeId && item.handle === normalizedHandle)) {
      const error = new Error("Product handle already exists in this store");
      error.code = "CONFLICT";
      throw error;
    }

    const product = {
      id: `prod_${crypto.randomUUID()}`,
      storeId,
      title: String(title || "").trim() || "Untitled product",
      handle: normalizedHandle,
      description: String(description || ""),
      status,
      primaryImageUrl,
      metadata: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.products.push(product);

    const variant = {
      id: `var_${crypto.randomUUID()}`,
      productId: product.id,
      storeId,
      sku,
      title: "Default",
      priceCents: Number(priceCents) || 0,
      compareAtCents: null,
      stock: Number(stock) || 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.variants.push(variant);

    return this.decorateProduct(product);
  }

  async listProductsByStore(storeId, { status } = {}) {
    return this.products
      .filter((item) => item.storeId === storeId)
      .filter((item) => (status ? item.status === status : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => this.decorateProduct(item));
  }

  async getProductByHandle(storeId, handle) {
    const product = this.products.find(
      (item) => item.storeId === storeId && item.handle === String(handle || "").trim().toLowerCase(),
    );
    return product ? this.decorateProduct(product) : null;
  }

  async getProductById(storeId, productId) {
    const product = this.products.find((item) => item.storeId === storeId && item.id === productId);
    return product ? this.decorateProduct(product) : null;
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
    const product = this.products.find((item) => item.storeId === storeId && item.id === productId);
    if (!product) {
      const error = new Error("Product not found");
      error.code = "NOT_FOUND";
      throw error;
    }

    if (handle !== undefined) {
      const normalizedHandle = randomProductHandle(handle || product.title);
      const conflict = this.products.some(
        (item) =>
          item.storeId === storeId && item.id !== productId && item.handle === normalizedHandle,
      );
      if (conflict) {
        const error = new Error("Product handle already exists in this store");
        error.code = "CONFLICT";
        throw error;
      }
      product.handle = normalizedHandle;
    }

    if (title !== undefined) product.title = String(title || "").trim() || product.title;
    if (description !== undefined) product.description = String(description || "");
    if (status !== undefined) product.status = status;
    if (primaryImageUrl !== undefined) product.primaryImageUrl = primaryImageUrl;
    if (metadata !== undefined) product.metadata = metadata || {};
    product.updatedAt = nowIso();

    const variant = this.variants.find((item) => item.productId === product.id);
    if (variant) {
      if (priceCents !== undefined) variant.priceCents = Number(priceCents) || 0;
      if (stock !== undefined) variant.stock = Number(stock) || 0;
      if (sku !== undefined) variant.sku = sku;
      variant.updatedAt = nowIso();
    }

    return this.decorateProduct(product);
  }

  async deleteProduct(storeId, productId) {
    const index = this.products.findIndex((item) => item.storeId === storeId && item.id === productId);
    if (index < 0) {
      const error = new Error("Product not found");
      error.code = "NOT_FOUND";
      throw error;
    }
    this.products.splice(index, 1);
    this.variants = this.variants.filter((item) => item.productId !== productId);
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
    const store = this.stores.find((item) => item.id === storeId);
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

    const orderItems = [];
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
        const variant = this.variants.find(
          (item) => item.id === variantId && item.storeId === storeId,
        );
        if (!variant) {
          const error = new Error(`Variant not found: ${variantId}`);
          error.code = "INVALID_PARAM";
          throw error;
        }
        if (variant.stock < quantity) {
          const error = new Error(`Insufficient stock for ${title || variantId}`);
          error.code = "INVALID_PARAM";
          throw error;
        }
        if (!Number.isFinite(unitPriceCents)) {
          unitPriceCents = variant.priceCents;
        }
      }

      if (!title || !Number.isFinite(unitPriceCents) || unitPriceCents < 0) {
        const error = new Error("Each order item needs title and unitPriceCents");
        error.code = "INVALID_PARAM";
        throw error;
      }

      const lineTotalCents = unitPriceCents * quantity;
      subtotalCents += lineTotalCents;
      orderItems.push({
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
    const now = nowIso();
    const order = {
      id: `order_${crypto.randomUUID()}`,
      storeId,
      orderNo: nextOrderNo(),
      email: normalizedEmail,
      status: normalizedStatus,
      currency: store.currency || "USD",
      subtotalCents,
      shippingCents: resolvedShipping,
      totalCents: subtotalCents + resolvedShipping,
      shippingAddress: shippingAddress || {},
      createdAt: now,
      updatedAt: now,
      paidAt: ["paid", "fulfilled", "completed"].includes(normalizedStatus) ? now : null,
      fulfilledAt: ["fulfilled", "completed"].includes(normalizedStatus) ? now : null,
    };

    this.orders.push(order);
    for (const item of orderItems) {
      this.orderItems.push({
        ...item,
        orderId: order.id,
        storeId,
      });
    }

    // Demo/manual paid orders deduct stock immediately.
    if (["paid", "fulfilled", "completed"].includes(normalizedStatus)) {
      this.deductStockForOrder(order.id);
    }

    return this.decorateOrder(order);
  }

  async listOrdersByStore(storeId, { status } = {}) {
    return this.orders
      .filter((item) => item.storeId === storeId)
      .filter((item) => (status ? item.status === status : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => this.decorateOrder(item));
  }

  async getOrderById(storeId, orderId) {
    const order = this.orders.find((item) => item.storeId === storeId && item.id === orderId);
    return order ? this.decorateOrder(order) : null;
  }

  async getOrderByIdGlobal(orderId) {
    const order = this.orders.find((item) => item.id === orderId);
    return order ? this.decorateOrder(order) : null;
  }

  async getPaymentByOrderId(orderId) {
    const payment = this.payments.find((item) => item.orderId === orderId);
    return payment ? this.decoratePayment(payment) : null;
  }

  async getPaymentByProviderRef(provider, providerRef) {
    const payment = this.payments.find(
      (item) => item.provider === provider && item.providerRef === providerRef,
    );
    return payment ? this.decoratePayment(payment) : null;
  }

  async upsertPaypalPayment({
    orderId,
    storeId,
    providerRef,
    amountCents,
    status = "created",
    rawPayload = {},
  }) {
    let payment = this.payments.find(
      (item) => item.orderId === orderId || (providerRef && item.providerRef === providerRef),
    );
    const now = nowIso();
    if (!payment) {
      payment = {
        id: `pay_${crypto.randomUUID()}`,
        orderId,
        storeId,
        provider: "paypal",
        providerRef: providerRef || null,
        status,
        amountCents: Number(amountCents) || 0,
        rawPayload: rawPayload || {},
        createdAt: now,
        updatedAt: now,
      };
      this.payments.push(payment);
    } else {
      payment.providerRef = providerRef || payment.providerRef;
      payment.status = status || payment.status;
      payment.amountCents = Number(amountCents) || payment.amountCents;
      payment.rawPayload = rawPayload || payment.rawPayload;
      payment.updatedAt = now;
    }
    return this.decoratePayment(payment);
  }

  async cancelOrder({ storeId, orderId }) {
    const order = this.orders.find((item) => item.storeId === storeId && item.id === orderId);
    if (!order) {
      const error = new Error("Order not found");
      error.code = "NOT_FOUND";
      throw error;
    }
    if (!["pending_payment", "payment_failed"].includes(order.status)) {
      const error = new Error("Only unpaid orders can be cancelled");
      error.code = "INVALID_STATUS";
      throw error;
    }
    order.status = "cancelled";
    order.updatedAt = nowIso();

    const payment = this.payments.find((item) => item.orderId === order.id);
    if (payment && payment.status !== "captured") {
      payment.status = "cancelled";
      payment.updatedAt = nowIso();
    }

    return this.decorateOrder(order);
  }

  async cancelExpiredPendingOrders({ olderThanMs = 30 * 60 * 1000 } = {}) {
    const cutoff = Date.now() - Math.max(0, Number(olderThanMs) || 0);
    const cancelled = [];
    for (const order of this.orders) {
      if (order.status !== "pending_payment") continue;
      if (new Date(order.createdAt).getTime() > cutoff) continue;
      order.status = "cancelled";
      order.updatedAt = nowIso();
      const payment = this.payments.find((item) => item.orderId === order.id);
      if (payment && payment.status !== "captured") {
        payment.status = "cancelled";
        payment.updatedAt = nowIso();
      }
      cancelled.push(this.decorateOrder(order));
    }
    return cancelled;
  }

  async markOrderPaidByPaypal({ paypalOrderId, captureId = null, rawPayload = {} }) {
    const payment = this.payments.find(
      (item) => item.provider === "paypal" && item.providerRef === paypalOrderId,
    );
    if (!payment) {
      const error = new Error("Payment not found");
      error.code = "NOT_FOUND";
      throw error;
    }
    const order = this.orders.find((item) => item.id === payment.orderId);
    if (!order) {
      const error = new Error("Order not found");
      error.code = "NOT_FOUND";
      throw error;
    }

    const now = nowIso();
    const shouldDeduct =
      order.status === "pending_payment" || order.status === "payment_failed";
    if (shouldDeduct) {
      this.deductStockForOrder(order.id);
      order.status = "paid";
      order.paidAt = order.paidAt || now;
      order.updatedAt = now;
    }

    payment.status = "captured";
    payment.rawPayload = {
      ...(payment.rawPayload || {}),
      ...(rawPayload || {}),
      captureId,
    };
    payment.updatedAt = now;

    return {
      order: this.decorateOrder(order),
      payment: this.decoratePayment(payment),
    };
  }

  deductStockForOrder(orderId) {
    const items = this.orderItems.filter((item) => item.orderId === orderId);
    for (const item of items) {
      if (!item.variantId) continue;
      const variant = this.variants.find((entry) => entry.id === item.variantId);
      if (!variant) continue;
      if (variant.stock < item.quantity) {
        const error = new Error(`Insufficient stock while capturing payment for ${item.title}`);
        error.code = "INVALID_PARAM";
        throw error;
      }
      variant.stock -= item.quantity;
      variant.updatedAt = nowIso();
    }
  }

  decoratePayment(payment) {
    return {
      id: payment.id,
      orderId: payment.orderId,
      storeId: payment.storeId,
      provider: payment.provider,
      providerRef: payment.providerRef,
      status: payment.status,
      amountCents: payment.amountCents,
      rawPayload: payment.rawPayload || {},
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
    };
  }

  async fulfillOrder({ storeId, orderId, carrier, trackingNo }) {
    const order = this.orders.find((item) => item.storeId === storeId && item.id === orderId);
    if (!order) {
      const error = new Error("Order not found");
      error.code = "NOT_FOUND";
      throw error;
    }
    if (!["paid", "fulfilled", "completed"].includes(order.status)) {
      const error = new Error("Only paid orders can be fulfilled");
      error.code = "INVALID_STATUS";
      throw error;
    }

    const now = nowIso();
    order.status = "fulfilled";
    order.fulfilledAt = now;
    order.updatedAt = now;
    if (!order.paidAt) order.paidAt = now;

    this.shipments.push({
      id: `ship_${crypto.randomUUID()}`,
      orderId: order.id,
      storeId,
      carrier: String(carrier || "").trim() || null,
      trackingNo: String(trackingNo || "").trim() || null,
      shippedAt: now,
      createdAt: now,
    });

    return this.decorateOrder(order);
  }

  async createCart({ storeId, email = null }) {
    const store = this.stores.find((item) => item.id === storeId);
    if (!store || store.status !== "active") {
      const error = new Error("Store not found");
      error.code = "NOT_FOUND";
      throw error;
    }
    const now = nowIso();
    const cart = {
      id: `cart_${crypto.randomUUID()}`,
      storeId,
      currency: store.currency || "USD",
      email: email ? String(email).trim().toLowerCase() : null,
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
    this.carts.push(cart);
    return this.decorateCart(cart);
  }

  async getCartById(cartId) {
    const cart = this.carts.find((item) => item.id === cartId);
    return cart ? this.decorateCart(cart) : null;
  }

  async assertOpenCart(cartId, storeId = null) {
    const cart = this.carts.find((item) => item.id === cartId);
    if (!cart) {
      const error = new Error("Cart not found");
      error.code = "NOT_FOUND";
      throw error;
    }
    if (storeId && cart.storeId !== storeId) {
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
    const cart = await this.assertOpenCart(cartId);
    const product = await this.getProductById(cart.storeId, productId);
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

    const existing = this.cartItems.find(
      (item) => item.cartId === cartId && item.variantId === variant.id,
    );
    const now = nowIso();
    if (existing) {
      const nextQty = existing.quantity + qty;
      if (variant.stock < nextQty) {
        const error = new Error("Insufficient stock");
        error.code = "INVALID_PARAM";
        throw error;
      }
      existing.quantity = nextQty;
      existing.unitPriceCents = variant.priceCents;
      existing.lineTotalCents = existing.unitPriceCents * existing.quantity;
      existing.updatedAt = now;
    } else {
      this.cartItems.push({
        id: `ci_${crypto.randomUUID()}`,
        cartId,
        storeId: cart.storeId,
        productId: product.id,
        variantId: variant.id,
        title: product.title,
        unitPriceCents: variant.priceCents,
        quantity: qty,
        lineTotalCents: variant.priceCents * qty,
        createdAt: now,
        updatedAt: now,
      });
    }

    cart.updatedAt = now;
    return this.decorateCart(cart);
  }

  async updateCartItem({ cartId, itemId, quantity }) {
    const cart = await this.assertOpenCart(cartId);
    const item = this.cartItems.find((entry) => entry.cartId === cartId && entry.id === itemId);
    if (!item) {
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
      this.cartItems = this.cartItems.filter((entry) => entry.id !== itemId);
    } else {
      if (item.variantId) {
        const variant = this.variants.find((entry) => entry.id === item.variantId);
        if (variant && variant.stock < qty) {
          const error = new Error("Insufficient stock");
          error.code = "INVALID_PARAM";
          throw error;
        }
      }
      item.quantity = qty;
      item.lineTotalCents = item.unitPriceCents * qty;
      item.updatedAt = nowIso();
    }

    cart.updatedAt = nowIso();
    return this.decorateCart(cart);
  }

  async removeCartItem({ cartId, itemId }) {
    return this.updateCartItem({ cartId, itemId, quantity: 0 });
  }

  async updateCartEmail({ cartId, email }) {
    const cart = await this.assertOpenCart(cartId);
    cart.email = String(email || "").trim().toLowerCase() || null;
    cart.updatedAt = nowIso();
    return this.decorateCart(cart);
  }

  async checkoutCart({ cartId, email, shippingAddress = {} }) {
    const cart = await this.assertOpenCart(cartId);
    const decorated = this.decorateCart(cart);
    if (!decorated.items.length) {
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
      items: decorated.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        title: item.title,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
      })),
      shippingAddress,
      status: "pending_payment",
      shippingCents: decorated.shippingCents,
    });

    cart.status = "checked_out";
    cart.email = checkoutEmail;
    cart.updatedAt = nowIso();

    return {
      cart: this.decorateCart(cart),
      order,
    };
  }

  decorateCart(cart) {
    const store = this.stores.find((item) => item.id === cart.storeId);
    const items = this.cartItems
      .filter((item) => item.cartId === cart.id)
      .map((item) => ({
        id: item.id,
        cart_id: item.cartId,
        store_id: item.storeId,
        product_id: item.productId,
        variant_id: item.variantId,
        title: item.title,
        unit_price_cents: item.unitPriceCents,
        quantity: item.quantity,
        line_total_cents: item.lineTotalCents,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      }));
    return mapCartRow(
      {
        id: cart.id,
        store_id: cart.storeId,
        currency: cart.currency,
        email: cart.email,
        status: cart.status,
        created_at: cart.createdAt,
        updated_at: cart.updatedAt,
      },
      items,
      store?.flatShippingCents || 0,
    );
  }

  decorateOrder(order) {
    const items = this.orderItems
      .filter((item) => item.orderId === order.id)
      .map((item) => ({
        id: item.id,
        orderId: item.orderId,
        storeId: item.storeId,
        productId: item.productId,
        variantId: item.variantId,
        title: item.title,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        lineTotalCents: item.lineTotalCents,
      }));
    const shipments = this.shipments
      .filter((item) => item.orderId === order.id)
      .map((item) => ({ ...item }));
    return {
      ...order,
      items,
      shipments,
    };
  }

  decorateProduct(product) {
    const variants = this.variants.filter((item) => item.productId === product.id);
    return {
      ...product,
      variants,
      priceCents: variants[0]?.priceCents ?? 0,
      stock: variants[0]?.stock ?? 0,
    };
  }

  toPublicUser(user) {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      createdAt: user.createdAt,
    };
  }
}
