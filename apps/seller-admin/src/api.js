const apiBaseUrl =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_COMMERCE_API_BASE_URL) ||
  "http://127.0.0.1:3200";

async function request(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || "Request failed");
  }
  return payload.data;
}

export function register(input) {
  return request("/api/auth/register", { method: "POST", body: input });
}

export function login(input) {
  return request("/api/auth/login", { method: "POST", body: input });
}

export function listStores(token) {
  return request("/api/stores", { token });
}

export function createStore(token, input) {
  return request("/api/stores", { token, method: "POST", body: input });
}

export function listProducts(token, storeId) {
  return request(`/api/stores/${storeId}/products`, { token });
}

export function createProduct(token, storeId, input) {
  return request(`/api/stores/${storeId}/products`, {
    token,
    method: "POST",
    body: input,
  });
}

export function updateProduct(token, storeId, productId, input) {
  return request(`/api/stores/${storeId}/products/${productId}`, {
    token,
    method: "PATCH",
    body: input,
  });
}

export function deleteProduct(token, storeId, productId) {
  return request(`/api/stores/${storeId}/products/${productId}`, {
    token,
    method: "DELETE",
  });
}

export function generateProductContent(token, storeId, productId, input = {}) {
  return request(`/api/stores/${storeId}/products/${productId}/generate-content`, {
    token,
    method: "POST",
    body: input,
  });
}

export function listOrders(token, storeId, { status } = {}) {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return request(`/api/stores/${storeId}/orders${query}`, { token });
}

export function createOrder(token, storeId, input) {
  return request(`/api/stores/${storeId}/orders`, {
    token,
    method: "POST",
    body: input,
  });
}

export function fulfillOrder(token, storeId, orderId, input) {
  return request(`/api/stores/${storeId}/orders/${orderId}/fulfill`, {
    token,
    method: "POST",
    body: input,
  });
}

export function cancelOrder(token, storeId, orderId) {
  return request(`/api/stores/${storeId}/orders/${orderId}/cancel`, {
    token,
    method: "POST",
  });
}

export { apiBaseUrl };
