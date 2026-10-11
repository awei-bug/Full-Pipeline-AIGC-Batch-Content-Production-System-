import crypto from "node:crypto";

export function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function isUniqueViolation(error) {
  return error?.code === "23505";
}

export function mapUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function mapStoreRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    slug: row.slug,
    currency: row.currency,
    supportEmail: row.support_email,
    logoUrl: row.logo_url,
    flatShippingCents: row.flat_shipping_cents,
    status: row.status,
    planCode: row.plan_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapVariantRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    productId: row.product_id,
    storeId: row.store_id,
    sku: row.sku,
    title: row.title,
    priceCents: row.price_cents,
    compareAtCents: row.compare_at_cents,
    stock: row.stock,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapProductRow(row, variants = []) {
  if (!row) return null;
  const mappedVariants = variants.map(mapVariantRow);
  return {
    id: row.id,
    storeId: row.store_id,
    title: row.title,
    handle: row.handle,
    description: row.description,
    status: row.status,
    primaryImageUrl: row.primary_image_url,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    variants: mappedVariants,
    priceCents: mappedVariants[0]?.priceCents ?? 0,
    stock: mappedVariants[0]?.stock ?? 0,
  };
}

export function mapOrderItemRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    storeId: row.store_id,
    productId: row.product_id,
    variantId: row.variant_id,
    title: row.title,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    lineTotalCents: row.line_total_cents,
  };
}

export function mapShipmentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    storeId: row.store_id,
    carrier: row.carrier,
    trackingNo: row.tracking_no,
    shippedAt: row.shipped_at,
    createdAt: row.created_at,
  };
}

export function mapOrderRow(row, items = [], shipments = []) {
  if (!row) return null;
  return {
    id: row.id,
    storeId: row.store_id,
    orderNo: row.order_no,
    email: row.email,
    status: row.status,
    currency: row.currency,
    subtotalCents: row.subtotal_cents,
    shippingCents: row.shipping_cents,
    totalCents: row.total_cents,
    shippingAddress: row.shipping_address || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at,
    fulfilledAt: row.fulfilled_at,
    items: items.map(mapOrderItemRow),
    shipments: shipments.map(mapShipmentRow),
  };
}

export function randomProductHandle(title) {
  return slugify(title) || `product-${crypto.randomBytes(3).toString("hex")}`;
}

export function nextOrderNo() {
  const stamp = Date.now().toString().slice(-10);
  const rand = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `ORD-${stamp}-${rand}`;
}

export function mapCartItemRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    cartId: row.cart_id,
    storeId: row.store_id,
    productId: row.product_id,
    variantId: row.variant_id,
    title: row.title,
    unitPriceCents: row.unit_price_cents,
    quantity: row.quantity,
    lineTotalCents: row.line_total_cents,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapCartRow(row, items = [], shippingCents = 0) {
  if (!row) return null;
  const mappedItems = items.map(mapCartItemRow);
  const itemCount = mappedItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const subtotalCents = mappedItems.reduce(
    (sum, item) => sum + Number(item.lineTotalCents || 0),
    0,
  );
  const resolvedShipping = Number(shippingCents) || 0;
  return {
    id: row.id,
    storeId: row.store_id,
    currency: row.currency,
    email: row.email,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: mappedItems,
    itemCount,
    subtotalCents,
    shippingCents: resolvedShipping,
    totalCents: subtotalCents + resolvedShipping,
  };
}
