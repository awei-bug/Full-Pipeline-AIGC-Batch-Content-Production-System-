import express from "express";

import { fail, ok } from "../lib/response.js";

export const cartsRouter = express.Router();

function handleCartError(error, response, next) {
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

cartsRouter.post("/", async (request, response, next) => {
  try {
    const body = request.body || {};
    let storeId = String(body.storeId || "").trim();
    const storeSlug = String(body.storeSlug || "").trim().toLowerCase();

    if (!storeId && storeSlug) {
      const store = await request.app.locals.repository.getStoreBySlug(storeSlug);
      if (!store || store.status !== "active") {
        fail(response, 404, "NOT_FOUND", "Store not found");
        return;
      }
      storeId = store.id;
    }

    if (!storeId) {
      fail(response, 400, "INVALID_PARAM", "storeId or storeSlug is required");
      return;
    }

    const cart = await request.app.locals.repository.createCart({
      storeId,
      email: body.email || null,
    });
    ok(response, { cart }, "Cart created", 201);
  } catch (error) {
    handleCartError(error, response, next);
  }
});

cartsRouter.get("/:cartId", async (request, response, next) => {
  try {
    const cart = await request.app.locals.repository.getCartById(request.params.cartId);
    if (!cart) {
      fail(response, 404, "NOT_FOUND", "Cart not found");
      return;
    }
    ok(response, { cart });
  } catch (error) {
    handleCartError(error, response, next);
  }
});

cartsRouter.post("/:cartId/items", async (request, response, next) => {
  try {
    const body = request.body || {};
    const cart = await request.app.locals.repository.addCartItem({
      cartId: request.params.cartId,
      productId: body.productId,
      quantity: body.quantity,
    });
    ok(response, { cart }, "Item added");
  } catch (error) {
    handleCartError(error, response, next);
  }
});

cartsRouter.patch("/:cartId/items/:itemId", async (request, response, next) => {
  try {
    const body = request.body || {};
    const cart = await request.app.locals.repository.updateCartItem({
      cartId: request.params.cartId,
      itemId: request.params.itemId,
      quantity: body.quantity,
    });
    ok(response, { cart }, "Item updated");
  } catch (error) {
    handleCartError(error, response, next);
  }
});

cartsRouter.delete("/:cartId/items/:itemId", async (request, response, next) => {
  try {
    const cart = await request.app.locals.repository.removeCartItem({
      cartId: request.params.cartId,
      itemId: request.params.itemId,
    });
    ok(response, { cart }, "Item removed");
  } catch (error) {
    handleCartError(error, response, next);
  }
});

cartsRouter.patch("/:cartId", async (request, response, next) => {
  try {
    const body = request.body || {};
    if (body.email === undefined) {
      fail(response, 400, "INVALID_PARAM", "email is required");
      return;
    }
    const cart = await request.app.locals.repository.updateCartEmail({
      cartId: request.params.cartId,
      email: body.email,
    });
    ok(response, { cart }, "Cart updated");
  } catch (error) {
    handleCartError(error, response, next);
  }
});

cartsRouter.post("/:cartId/checkout", async (request, response, next) => {
  try {
    const body = request.body || {};
    const result = await request.app.locals.repository.checkoutCart({
      cartId: request.params.cartId,
      email: body.email,
      shippingAddress: body.shippingAddress || {},
    });
    ok(response, result, "Checkout created pending payment", 201);
  } catch (error) {
    handleCartError(error, response, next);
  }
});
