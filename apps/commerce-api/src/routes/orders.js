import express from "express";

import { getBearerToken } from "../lib/auth.js";
import { fail, ok } from "../lib/response.js";

export const ordersRouter = express.Router({ mergeParams: true });

async function requireStoreMember(request, response) {
  const token = getBearerToken(request);
  const user = await request.app.locals.repository.getUserBySessionToken(token);
  if (!user) {
    fail(response, 401, "UNAUTHORIZED", "Not signed in");
    return null;
  }
  const storeId = request.params.storeId;
  await request.app.locals.repository.assertStoreMember(storeId, user.id);
  return { user, storeId };
}

function handleOrderError(error, response, next) {
  if (error.code === "FORBIDDEN") {
    fail(response, 403, error.code, error.message);
    return;
  }
  if (error.code === "NOT_FOUND") {
    fail(response, 404, error.code, error.message);
    return;
  }
  if (error.code === "INVALID_PARAM" || error.code === "INVALID_STATUS") {
    fail(response, 400, error.code, error.message);
    return;
  }
  next(error);
}

ordersRouter.get("/", async (request, response, next) => {
  try {
    const ctx = await requireStoreMember(request, response);
    if (!ctx) return;
    const items = await request.app.locals.repository.listOrdersByStore(ctx.storeId, {
      status: request.query.status,
    });
    ok(response, { items });
  } catch (error) {
    handleOrderError(error, response, next);
  }
});

ordersRouter.get("/:orderId", async (request, response, next) => {
  try {
    const ctx = await requireStoreMember(request, response);
    if (!ctx) return;
    const order = await request.app.locals.repository.getOrderById(ctx.storeId, request.params.orderId);
    if (!order) {
      fail(response, 404, "NOT_FOUND", "Order not found");
      return;
    }
    ok(response, { order });
  } catch (error) {
    handleOrderError(error, response, next);
  }
});

ordersRouter.post("/", async (request, response, next) => {
  try {
    const ctx = await requireStoreMember(request, response);
    if (!ctx) return;
    const body = request.body || {};
    const order = await request.app.locals.repository.createOrder({
      storeId: ctx.storeId,
      email: body.email,
      items: body.items,
      shippingAddress: body.shippingAddress,
      status: body.status,
      shippingCents: body.shippingCents,
    });
    ok(response, { order }, "Order created", 201);
  } catch (error) {
    handleOrderError(error, response, next);
  }
});

ordersRouter.post("/:orderId/fulfill", async (request, response, next) => {
  try {
    const ctx = await requireStoreMember(request, response);
    if (!ctx) return;
    const body = request.body || {};
    const order = await request.app.locals.repository.fulfillOrder({
      storeId: ctx.storeId,
      orderId: request.params.orderId,
      carrier: body.carrier,
      trackingNo: body.trackingNo,
    });
    ok(response, { order }, "Order fulfilled");
  } catch (error) {
    handleOrderError(error, response, next);
  }
});

ordersRouter.post("/:orderId/cancel", async (request, response, next) => {
  try {
    const ctx = await requireStoreMember(request, response);
    if (!ctx) return;
    const order = await request.app.locals.repository.cancelOrder({
      storeId: ctx.storeId,
      orderId: request.params.orderId,
    });
    ok(response, { order }, "Order cancelled");
  } catch (error) {
    handleOrderError(error, response, next);
  }
});
