import express from "express";

import { fail, ok } from "../lib/response.js";

export const paymentsRouter = express.Router();

function handlePaymentError(error, response, next) {
  if (error.code === "NOT_FOUND") {
    fail(response, 404, error.code, error.message);
    return;
  }
  if (
    error.code === "INVALID_PARAM" ||
    error.code === "INVALID_STATUS" ||
    error.code === "PAYPAL_NOT_CONFIGURED"
  ) {
    fail(response, 400, error.code, error.message);
    return;
  }
  if (error.code === "PAYPAL_API_ERROR" || error.code === "PAYPAL_AUTH_FAILED") {
    fail(response, 502, error.code, error.message);
    return;
  }
  next(error);
}

function buildStorefrontUrls({ storeSlug, orderId, env }) {
  const storefrontBase = String(env.STOREFRONT_BASE_URL || "http://127.0.0.1:3000").replace(
    /\/+$/,
    "",
  );
  const returnUrl = `${storefrontBase}/s/${encodeURIComponent(storeSlug)}/order/${encodeURIComponent(orderId)}?paypal=return`;
  const cancelUrl = `${storefrontBase}/s/${encodeURIComponent(storeSlug)}/order/${encodeURIComponent(orderId)}?paypal=cancel`;
  return { returnUrl, cancelUrl, storefrontBase };
}

paymentsRouter.post("/paypal/create", async (request, response, next) => {
  try {
    const body = request.body || {};
    const orderId = String(body.orderId || "").trim();
    const storeSlug = String(body.storeSlug || "").trim().toLowerCase();
    if (!orderId) {
      fail(response, 400, "INVALID_PARAM", "orderId is required");
      return;
    }

    const repository = request.app.locals.repository;
    const paypal = request.app.locals.paypalClient;
    const order = await repository.getOrderByIdGlobal(orderId);
    if (!order) {
      fail(response, 404, "NOT_FOUND", "Order not found");
      return;
    }
    if (!["pending_payment", "payment_failed"].includes(order.status)) {
      fail(response, 400, "INVALID_STATUS", "Order is not awaiting payment");
      return;
    }

    const store = await repository.getStoreById(order.storeId);
    if (!store) {
      fail(response, 404, "NOT_FOUND", "Store not found");
      return;
    }
    const slug = storeSlug || store.slug;
    const { returnUrl, cancelUrl } = buildStorefrontUrls({
      storeSlug: slug,
      orderId: order.id,
      env: request.app.locals.env || process.env,
    });

    const existing = await repository.getPaymentByOrderId(order.id);
    if (existing?.providerRef && existing.status === "created" && existing.rawPayload?.approveUrl) {
      ok(response, {
        order,
        payment: existing,
        approveUrl: existing.rawPayload.approveUrl,
        paypalOrderId: existing.providerRef,
        reused: true,
        mode: paypal.config.mode,
      });
      return;
    }

    const created = await paypal.createOrder({
      orderId: order.id,
      orderNo: order.orderNo,
      amountCents: order.totalCents,
      currency: order.currency,
      returnUrl,
      cancelUrl,
    });

    const payment = await repository.upsertPaypalPayment({
      orderId: order.id,
      storeId: order.storeId,
      providerRef: created.paypalOrderId,
      amountCents: order.totalCents,
      status: "created",
      rawPayload: {
        ...created.raw,
        approveUrl: created.approveUrl,
      },
    });

    ok(
      response,
      {
        order,
        payment,
        approveUrl: created.approveUrl,
        paypalOrderId: created.paypalOrderId,
        mode: paypal.config.mode,
      },
      "PayPal order created",
      201,
    );
  } catch (error) {
    handlePaymentError(error, response, next);
  }
});

paymentsRouter.post("/paypal/capture", async (request, response, next) => {
  try {
    const body = request.body || {};
    const paypalOrderId = String(body.paypalOrderId || body.token || "").trim();
    if (!paypalOrderId) {
      fail(response, 400, "INVALID_PARAM", "paypalOrderId is required");
      return;
    }

    const repository = request.app.locals.repository;
    const paypal = request.app.locals.paypalClient;
    const payment = await repository.getPaymentByProviderRef("paypal", paypalOrderId);
    if (!payment) {
      fail(response, 404, "NOT_FOUND", "Payment not found");
      return;
    }

    if (payment.status === "captured") {
      const order = await repository.getOrderByIdGlobal(payment.orderId);
      ok(response, { order, payment, alreadyCaptured: true });
      return;
    }

    const captured = await paypal.captureOrder(paypalOrderId);
    if (!["COMPLETED", "APPROVED"].includes(String(captured.status || "").toUpperCase()) &&
        captured.status !== "COMPLETED") {
      // Still try to mark based on capture presence
    }

    const isCompleted =
      String(captured.status || "").toUpperCase() === "COMPLETED" ||
      Boolean(captured.captureId);

    if (!isCompleted) {
      await repository.upsertPaypalPayment({
        orderId: payment.orderId,
        storeId: payment.storeId,
        providerRef: paypalOrderId,
        amountCents: payment.amountCents,
        status: "failed",
        rawPayload: captured.raw || captured,
      });
      fail(response, 400, "INVALID_STATUS", `PayPal capture status is ${captured.status}`);
      return;
    }

    const result = await repository.markOrderPaidByPaypal({
      paypalOrderId,
      captureId: captured.captureId,
      rawPayload: captured.raw || captured,
    });

    ok(response, {
      order: result.order,
      payment: result.payment,
      mode: paypal.config.mode,
    }, "Payment captured");
  } catch (error) {
    handlePaymentError(error, response, next);
  }
});
