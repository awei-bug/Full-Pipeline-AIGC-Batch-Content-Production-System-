import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "./server.js";
import { MemoryCommerceRepository } from "./repositories/memory-commerce-repository.js";

async function withApp(run) {
  const repository = new MemoryCommerceRepository();
  const app = await buildApp({ repository, enableSweeper: false });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await run({ baseUrl, repository });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function authAndStore(baseUrl) {
  const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `seller_${Date.now()}@example.com`,
      password: "password123",
      displayName: "Seller One",
    }),
  });
  const registered = await registerResponse.json();
  const token = registered.data.token;

  const storeResponse = await fetch(`${baseUrl}/api/stores`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      name: "Nordic Home",
      slug: `nordic-${Date.now()}`,
      supportEmail: "support@nordic.test",
    }),
  });
  const storePayload = await storeResponse.json();
  return {
    token,
    storeId: storePayload.data.store.id,
    storeSlug: storePayload.data.store.slug,
  };
}

test("health endpoint reports commerce skeleton", async () => {
  await withApp(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/health`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.data.service, "commerce-api");
    assert.equal(payload.data.payments.provider, "paypal");
  });
});

test("register open store create product and storefront list", async () => {
  await withApp(async ({ baseUrl }) => {
    const { token, storeId, storeSlug } = await authAndStore(baseUrl);

    const productResponse = await fetch(`${baseUrl}/api/stores/${storeId}/products`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: "Stainless Bottle",
        description: "Food-grade export bottle",
        status: "active",
        priceCents: 1299,
        stock: 20,
      }),
    });
    const productPayload = await productResponse.json();
    assert.equal(productResponse.status, 201);
    assert.equal(productPayload.data.product.priceCents, 1299);

    const storefrontResponse = await fetch(`${baseUrl}/api/storefront/${storeSlug}`);
    const storefrontPayload = await storefrontResponse.json();
    assert.equal(storefrontResponse.status, 200);
    assert.equal(storefrontPayload.data.store.slug, storeSlug);
    assert.equal(storefrontPayload.data.products.length, 1);
    assert.equal(storefrontPayload.data.products[0].title, "Stainless Bottle");
  });
});

test("product update delete and order fulfill flow", async () => {
  await withApp(async ({ baseUrl }) => {
    const { token, storeId } = await authAndStore(baseUrl);

    const createProductResponse = await fetch(`${baseUrl}/api/stores/${storeId}/products`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: "Ceramic Mug",
        status: "active",
        priceCents: 899,
        stock: 12,
      }),
    });
    const created = await createProductResponse.json();
    const productId = created.data.product.id;

    const updateResponse = await fetch(`${baseUrl}/api/stores/${storeId}/products/${productId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: "Ceramic Mug Pro",
        priceCents: 999,
        stock: 10,
        status: "active",
      }),
    });
    const updated = await updateResponse.json();
    assert.equal(updateResponse.status, 200);
    assert.equal(updated.data.product.title, "Ceramic Mug Pro");
    assert.equal(updated.data.product.priceCents, 999);

    const orderResponse = await fetch(`${baseUrl}/api/stores/${storeId}/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        email: "buyer@example.com",
        status: "paid",
        items: [
          {
            productId,
            quantity: 2,
          },
        ],
        shippingAddress: {
          name: "Buyer",
          country: "US",
        },
      }),
    });
    const orderPayload = await orderResponse.json();
    assert.equal(orderResponse.status, 201);
    assert.equal(orderPayload.data.order.status, "paid");
    assert.equal(orderPayload.data.order.items.length, 1);
    assert.equal(orderPayload.data.order.subtotalCents, 1998);

    const orderId = orderPayload.data.order.id;
    const fulfillResponse = await fetch(
      `${baseUrl}/api/stores/${storeId}/orders/${orderId}/fulfill`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          carrier: "DHL",
          trackingNo: "TRACK123",
        }),
      },
    );
    const fulfilled = await fulfillResponse.json();
    assert.equal(fulfillResponse.status, 200);
    assert.equal(fulfilled.data.order.status, "fulfilled");
    assert.equal(fulfilled.data.order.shipments[0].trackingNo, "TRACK123");

    const listOrdersResponse = await fetch(`${baseUrl}/api/stores/${storeId}/orders`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listOrders = await listOrdersResponse.json();
    assert.equal(listOrdersResponse.status, 200);
    assert.equal(listOrders.data.items.length, 1);

    const deleteResponse = await fetch(`${baseUrl}/api/stores/${storeId}/products/${productId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    const deleted = await deleteResponse.json();
    assert.equal(deleteResponse.status, 200);
    assert.equal(deleted.data.deleted, true);

    const listProductsResponse = await fetch(`${baseUrl}/api/stores/${storeId}/products`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listProducts = await listProductsResponse.json();
    assert.equal(listProducts.data.items.length, 0);
  });
});

test("cart add update checkout creates pending payment order", async () => {
  await withApp(async ({ baseUrl }) => {
    const { token, storeId, storeSlug } = await authAndStore(baseUrl);

    const productResponse = await fetch(`${baseUrl}/api/stores/${storeId}/products`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: "Desk Lamp",
        status: "active",
        priceCents: 2500,
        stock: 5,
      }),
    });
    const productPayload = await productResponse.json();
    const productId = productPayload.data.product.id;

    const cartResponse = await fetch(`${baseUrl}/api/carts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storeSlug }),
    });
    const cartCreated = await cartResponse.json();
    assert.equal(cartResponse.status, 201);
    const cartId = cartCreated.data.cart.id;

    const addResponse = await fetch(`${baseUrl}/api/carts/${cartId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, quantity: 2 }),
    });
    const added = await addResponse.json();
    assert.equal(addResponse.status, 200);
    assert.equal(added.data.cart.itemCount, 2);
    assert.equal(added.data.cart.subtotalCents, 5000);

    const itemId = added.data.cart.items[0].id;
    const updateResponse = await fetch(`${baseUrl}/api/carts/${cartId}/items/${itemId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: 1 }),
    });
    const updated = await updateResponse.json();
    assert.equal(updated.data.cart.itemCount, 1);
    assert.equal(updated.data.cart.subtotalCents, 2500);

    const checkoutResponse = await fetch(`${baseUrl}/api/carts/${cartId}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "buyer@example.com",
        shippingAddress: { name: "Buyer", country: "US" },
      }),
    });
    const checkedOut = await checkoutResponse.json();
    assert.equal(checkoutResponse.status, 201);
    assert.equal(checkedOut.data.cart.status, "checked_out");
    assert.equal(checkedOut.data.order.status, "pending_payment");
    assert.equal(checkedOut.data.order.email, "buyer@example.com");
    assert.equal(checkedOut.data.order.items.length, 1);
  });
});

test("paypal mock create and capture marks order paid", async () => {
  await withApp(async ({ baseUrl }) => {
    const { token, storeId, storeSlug } = await authAndStore(baseUrl);

    const productResponse = await fetch(`${baseUrl}/api/stores/${storeId}/products`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: "PayPal Mug",
        status: "active",
        priceCents: 1500,
        stock: 3,
      }),
    });
    const productPayload = await productResponse.json();

    const cartResponse = await fetch(`${baseUrl}/api/carts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storeSlug }),
    });
    const cartCreated = await cartResponse.json();
    const cartId = cartCreated.data.cart.id;

    await fetch(`${baseUrl}/api/carts/${cartId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: productPayload.data.product.id, quantity: 1 }),
    });

    const checkoutResponse = await fetch(`${baseUrl}/api/carts/${cartId}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "buyer@example.com",
        shippingAddress: { name: "Buyer", country: "US" },
      }),
    });
    const checkedOut = await checkoutResponse.json();
    const orderId = checkedOut.data.order.id;

    const createPayResponse = await fetch(`${baseUrl}/api/payments/paypal/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, storeSlug }),
    });
    const createdPay = await createPayResponse.json();
    assert.equal(createPayResponse.status, 201);
    assert.ok(createdPay.data.approveUrl);
    assert.ok(createdPay.data.paypalOrderId);
    assert.equal(createdPay.data.mode, "mock");

    const captureResponse = await fetch(`${baseUrl}/api/payments/paypal/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paypalOrderId: createdPay.data.paypalOrderId }),
    });
    const captured = await captureResponse.json();
    assert.equal(captureResponse.status, 200);
    assert.equal(captured.data.order.status, "paid");
    assert.equal(captured.data.payment.status, "captured");

    const publicOrderResponse = await fetch(
      `${baseUrl}/api/storefront/${storeSlug}/orders/${orderId}`,
    );
    const publicOrder = await publicOrderResponse.json();
    assert.equal(publicOrderResponse.status, 200);
    assert.equal(publicOrder.data.order.status, "paid");

    const productsAfterPay = await fetch(`${baseUrl}/api/stores/${storeId}/products`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const catalog = await productsAfterPay.json();
    const paidProduct = catalog.data.items.find((item) => item.id === productPayload.data.product.id);
    assert.equal(paidProduct.stock, 2);
  });
});

test("checkout rejects insufficient stock", async () => {
  await withApp(async ({ baseUrl }) => {
    const { token, storeId, storeSlug } = await authAndStore(baseUrl);
    const productResponse = await fetch(`${baseUrl}/api/stores/${storeId}/products`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: "Low Stock Item",
        status: "active",
        priceCents: 500,
        stock: 1,
      }),
    });
    const productPayload = await productResponse.json();

    const cartResponse = await fetch(`${baseUrl}/api/carts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storeSlug }),
    });
    const cartCreated = await cartResponse.json();
    const cartId = cartCreated.data.cart.id;

    await fetch(`${baseUrl}/api/carts/${cartId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: productPayload.data.product.id, quantity: 1 }),
    });

    // Force cart quantity above stock via direct update is blocked; create order with qty 2.
    const orderResponse = await fetch(`${baseUrl}/api/stores/${storeId}/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        email: "buyer@example.com",
        status: "pending_payment",
        items: [{ productId: productPayload.data.product.id, quantity: 2 }],
      }),
    });
    const orderPayload = await orderResponse.json();
    assert.equal(orderResponse.status, 400);
    assert.match(orderPayload.message, /stock/i);
  });
});

test("seller can cancel unpaid order and sweeper cancels expired pending orders", async () => {
  await withApp(async ({ baseUrl, repository }) => {
    const { token, storeId } = await authAndStore(baseUrl);
    const productResponse = await fetch(`${baseUrl}/api/stores/${storeId}/products`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: "Timeout Item",
        status: "active",
        priceCents: 700,
        stock: 4,
      }),
    });
    const productPayload = await productResponse.json();

    const orderResponse = await fetch(`${baseUrl}/api/stores/${storeId}/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        email: "buyer@example.com",
        status: "pending_payment",
        items: [{ productId: productPayload.data.product.id, quantity: 1 }],
      }),
    });
    const orderPayload = await orderResponse.json();
    assert.equal(orderResponse.status, 201);
    const orderId = orderPayload.data.order.id;

    const cancelResponse = await fetch(`${baseUrl}/api/stores/${storeId}/orders/${orderId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const cancelled = await cancelResponse.json();
    assert.equal(cancelResponse.status, 200);
    assert.equal(cancelled.data.order.status, "cancelled");

    // Create another pending order and expire it via repository timestamp + sweeper helper.
    const second = await repository.createOrder({
      storeId,
      email: "buyer2@example.com",
      status: "pending_payment",
      items: [{ productId: productPayload.data.product.id, quantity: 1 }],
    });
    // Force createdAt into the past.
    const raw = repository.orders.find((item) => item.id === second.id);
    raw.createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const expired = await repository.cancelExpiredPendingOrders({ olderThanMs: 30 * 60 * 1000 });
    assert.ok(expired.some((item) => item.id === second.id && item.status === "cancelled"));
  });
});

test("generate product content applies english listing fields", async () => {
  await withApp(async ({ baseUrl }) => {
    const { token, storeId } = await authAndStore(baseUrl);
    const productResponse = await fetch(`${baseUrl}/api/stores/${storeId}/products`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: "Industrial Connector",
        description: "High protection rating",
        status: "active",
        priceCents: 120,
        stock: 10,
      }),
    });
    const created = await productResponse.json();
    const productId = created.data.product.id;

    const genResponse = await fetch(
      `${baseUrl}/api/stores/${storeId}/products/${productId}/generate-content`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ apply: true }),
      },
    );
    const generated = await genResponse.json();
    assert.equal(genResponse.status, 200);
    assert.equal(generated.data.applied, true);
    assert.ok(generated.data.product.title);
    assert.ok(generated.data.product.description);
    assert.ok(generated.data.generated.generationMeta);
    assert.match(generated.data.product.title, /Industrial Connector|buyers|for/i);
  });
});
