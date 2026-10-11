const apiBaseUrl =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_COMMERCE_API_BASE_URL) ||
  "http://127.0.0.1:3200";

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || "Request failed");
  }
  return payload.data;
}

export async function fetchStorefront(slug) {
  return request(`/api/storefront/${encodeURIComponent(slug)}`);
}

export async function fetchProduct(slug, handle) {
  return request(
    `/api/storefront/${encodeURIComponent(slug)}/products/${encodeURIComponent(handle)}`,
  );
}

export async function fetchOrder(slug, orderId) {
  return request(
    `/api/storefront/${encodeURIComponent(slug)}/orders/${encodeURIComponent(orderId)}`,
  );
}

export function createCart({ storeId, storeSlug, email } = {}) {
  return request("/api/carts", {
    method: "POST",
    body: { storeId, storeSlug, email },
  });
}

export function getCart(cartId) {
  return request(`/api/carts/${encodeURIComponent(cartId)}`);
}

export function addCartItem(cartId, { productId, quantity }) {
  return request(`/api/carts/${encodeURIComponent(cartId)}/items`, {
    method: "POST",
    body: { productId, quantity },
  });
}

export function updateCartItem(cartId, itemId, quantity) {
  return request(`/api/carts/${encodeURIComponent(cartId)}/items/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    body: { quantity },
  });
}

export function removeCartItem(cartId, itemId) {
  return request(`/api/carts/${encodeURIComponent(cartId)}/items/${encodeURIComponent(itemId)}`, {
    method: "DELETE",
  });
}

export function checkoutCart(cartId, { email, shippingAddress }) {
  return request(`/api/carts/${encodeURIComponent(cartId)}/checkout`, {
    method: "POST",
    body: { email, shippingAddress },
  });
}

export function createPaypalPayment({ orderId, storeSlug }) {
  return request("/api/payments/paypal/create", {
    method: "POST",
    body: { orderId, storeSlug },
  });
}

export function capturePaypalPayment({ paypalOrderId }) {
  return request("/api/payments/paypal/capture", {
    method: "POST",
    body: { paypalOrderId },
  });
}

export { apiBaseUrl };
