import express from "express";

import { fail, ok } from "../lib/response.js";

export const webhooksRouter = express.Router();

webhooksRouter.post("/paypal", async (request, response, next) => {
  try {
    const event = request.body || {};
    const eventType = String(event.event_type || event.eventType || "").trim();
    const resource = event.resource || {};

    // Prefer capture completed; also accept checkout order completed.
    let paypalOrderId =
      resource.supplementary_data?.related_ids?.order_id ||
      resource.id ||
      null;

    // For PAYMENT.CAPTURE.COMPLETED, resource.id is capture id; order id may be in supplementary_data
    if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
      paypalOrderId =
        resource.supplementary_data?.related_ids?.order_id ||
        resource.custom_id ||
        null;
    }

    if (eventType === "CHECKOUT.ORDER.APPROVED" || eventType === "CHECKOUT.ORDER.COMPLETED") {
      paypalOrderId = resource.id || paypalOrderId;
    }

    if (!paypalOrderId) {
      // Acknowledge unknown shapes so PayPal does not retry forever during skeleton phase.
      ok(response, { ignored: true, reason: "missing_paypal_order_id", eventType });
      return;
    }

    const repository = request.app.locals.repository;
    const payment = await repository.getPaymentByProviderRef("paypal", paypalOrderId);

    // Fallback: custom_id on purchase unit holds our order id
    let orderId = payment?.orderId || resource.custom_id || resource.purchase_units?.[0]?.custom_id || null;
    if (!payment && orderId) {
      // try mark via order id path after ensuring payment row exists is harder; ignore if no payment
      ok(response, { ignored: true, reason: "payment_not_found", paypalOrderId, eventType });
      return;
    }

    if (!payment) {
      ok(response, { ignored: true, reason: "payment_not_found", paypalOrderId, eventType });
      return;
    }

    if (
      eventType === "PAYMENT.CAPTURE.COMPLETED" ||
      eventType === "CHECKOUT.ORDER.COMPLETED" ||
      String(resource.status || "").toUpperCase() === "COMPLETED"
    ) {
      const result = await repository.markOrderPaidByPaypal({
        paypalOrderId: payment.providerRef,
        captureId: resource.id || null,
        rawPayload: event,
      });
      ok(response, {
        handled: true,
        eventType,
        orderId: result.order.id,
        status: result.order.status,
      });
      return;
    }

    ok(response, { ignored: true, reason: "unhandled_event", eventType });
  } catch (error) {
    if (error.code === "NOT_FOUND") {
      // Still 200 to avoid infinite retries on stale sandbox events
      ok(response, { ignored: true, reason: error.message });
      return;
    }
    next(error);
  }
});
