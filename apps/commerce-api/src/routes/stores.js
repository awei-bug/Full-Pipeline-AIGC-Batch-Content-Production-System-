import express from "express";

import { getBearerToken } from "../lib/auth.js";
import { fail, ok } from "../lib/response.js";

export const storesRouter = express.Router();

async function requireUser(request, response) {
  const token = getBearerToken(request);
  const user = await request.app.locals.repository.getUserBySessionToken(token);
  if (!user) {
    fail(response, 401, "UNAUTHORIZED", "Not signed in");
    return null;
  }
  return user;
}

storesRouter.get("/", async (request, response, next) => {
  try {
    const user = await requireUser(request, response);
    if (!user) return;
    const items = await request.app.locals.repository.listStoresForUser(user.id);
    ok(response, { items });
  } catch (error) {
    next(error);
  }
});

storesRouter.post("/", async (request, response, next) => {
  try {
    const user = await requireUser(request, response);
    if (!user) return;
    const { name, slug, supportEmail } = request.body || {};
    const store = await request.app.locals.repository.createStore({
      ownerUserId: user.id,
      name,
      slug,
      supportEmail,
    });
    ok(response, { store }, "Store created", 201);
  } catch (error) {
    if (error.code === "INVALID_PARAM") {
      fail(response, 400, error.code, error.message);
      return;
    }
    if (error.code === "CONFLICT") {
      fail(response, 409, error.code, error.message);
      return;
    }
    next(error);
  }
});

storesRouter.get("/by-slug/:slug", async (request, response, next) => {
  try {
    const store = await request.app.locals.repository.getStoreBySlug(request.params.slug);
    if (!store || store.status !== "active") {
      fail(response, 404, "NOT_FOUND", "Store not found");
      return;
    }
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
    });
  } catch (error) {
    next(error);
  }
});
