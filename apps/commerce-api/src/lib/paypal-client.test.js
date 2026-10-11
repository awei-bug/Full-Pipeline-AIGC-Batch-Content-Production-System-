import assert from "node:assert/strict";
import test from "node:test";

import { createPaypalClient, resolvePaypalConfig } from "./paypal-client.js";

test("resolvePaypalConfig defaults to mock without credentials", () => {
  const config = resolvePaypalConfig({});
  assert.equal(config.mode, "mock");
  assert.equal(config.configured, true);
});

test("mock paypal client creates approve url and captures", async () => {
  const client = createPaypalClient({ PAYPAL_MODE: "mock" });
  const created = await client.createOrder({
    orderId: "order_123",
    orderNo: "ORD-1",
    amountCents: 1999,
    currency: "USD",
    returnUrl: "http://127.0.0.1:3000/s/demo/order/order_123?paypal=return",
    cancelUrl: "http://127.0.0.1:3000/s/demo/order/order_123?paypal=cancel",
  });

  assert.ok(created.paypalOrderId);
  assert.ok(created.approveUrl.includes("token="));
  assert.ok(created.approveUrl.includes("paypal=return"));

  const captured = await client.captureOrder(created.paypalOrderId);
  assert.equal(captured.status, "COMPLETED");
  assert.ok(captured.captureId);
});
