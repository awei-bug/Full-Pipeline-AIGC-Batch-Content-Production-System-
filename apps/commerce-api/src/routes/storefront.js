import express from "express";

import { fail, ok } from "../lib/response.js";

export const storefrontRouter = express.Router();

storefrontRouter.get("/:slug", async (request, response, next) => {
  try {
    const store = await request.app.locals.repository.getStoreBySlug(request.params.slug);
    if (!store || store.status !== "active") {
      fail(response, 404, "NOT_FOUND", "Store not found");
      return;
    }
    const products = await request.app.locals.repository.listProductsByStore(store.id, {
      status: "active",
    });
    ok(response, {
      store: {
        id: store.id,
        name: store.name,
        slug: store.slug,
        currency: store.currency,
        logoUrl: store.logoUrl,
        flatShippingCents: store.flatShippingCents,
        supportEmail: store.supportEmail,
      },
      products,
    });
  } catch (error) {
    next(error);
  }
});

storefrontRouter.get("/:slug/products/:handle", async (request, response, next) => {
  try {
    const store = await request.app.locals.repository.getStoreBySlug(request.params.slug);
    if (!store || store.status !== "active") {
      fail(response, 404, "NOT_FOUND", "Store not found");
      return;
    }
    const product = await request.app.locals.repository.getProductByHandle(
      store.id,
      request.params.handle,
    );
    if (!product || product.status !== "active") {
      fail(response, 404, "NOT_FOUND", "Product not found");
      return;
    }
    ok(response, { store, product });
  } catch (error) {
    next(error);
  }
});

storefrontRouter.get("/:slug/orders/:orderId", async (request, response, next) => {
  try {
    const store = await request.app.locals.repository.getStoreBySlug(request.params.slug);
    if (!store || store.status !== "active") {
      fail(response, 404, "NOT_FOUND", "Store not found");
      return;
    }
    const order = await request.app.locals.repository.getOrderById(
      store.id,
      request.params.orderId,
    );
    if (!order) {
      fail(response, 404, "NOT_FOUND", "Order not found");
      return;
    }
    const payment = await request.app.locals.repository.getPaymentByOrderId(order.id);
    ok(response, {
      store: {
        id: store.id,
        name: store.name,
        slug: store.slug,
        currency: store.currency,
      },
      order,
      payment,
    });
  } catch (error) {
    next(error);
  }
});
