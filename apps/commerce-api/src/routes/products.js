import express from "express";

import { getBearerToken } from "../lib/auth.js";
import { fail, ok } from "../lib/response.js";

export const productsRouter = express.Router({ mergeParams: true });

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

function handleProductError(error, response, next) {
  if (error.code === "FORBIDDEN") {
    fail(response, 403, error.code, error.message);
    return;
  }
  if (error.code === "NOT_FOUND") {
    fail(response, 404, error.code, error.message);
    return;
  }
  if (error.code === "CONFLICT" || error.code === "INVALID_PARAM") {
    fail(response, error.code === "CONFLICT" ? 409 : 400, error.code, error.message);
    return;
  }
  next(error);
}

productsRouter.get("/", async (request, response, next) => {
  try {
    const ctx = await requireStoreMember(request, response);
    if (!ctx) return;
    const items = await request.app.locals.repository.listProductsByStore(ctx.storeId, {
      status: request.query.status,
    });
    ok(response, { items });
  } catch (error) {
    handleProductError(error, response, next);
  }
});

productsRouter.get("/:productId", async (request, response, next) => {
  try {
    const ctx = await requireStoreMember(request, response);
    if (!ctx) return;
    const product = await request.app.locals.repository.getProductById(
      ctx.storeId,
      request.params.productId,
    );
    if (!product) {
      fail(response, 404, "NOT_FOUND", "Product not found");
      return;
    }
    ok(response, { product });
  } catch (error) {
    handleProductError(error, response, next);
  }
});

productsRouter.post("/", async (request, response, next) => {
  try {
    const ctx = await requireStoreMember(request, response);
    if (!ctx) return;
    const body = request.body || {};
    const product = await request.app.locals.repository.createProduct({
      storeId: ctx.storeId,
      title: body.title,
      handle: body.handle,
      description: body.description,
      status: body.status || "draft",
      primaryImageUrl: body.primaryImageUrl || null,
      priceCents: body.priceCents,
      stock: body.stock,
      sku: body.sku || null,
    });
    ok(response, { product }, "Product created", 201);
  } catch (error) {
    handleProductError(error, response, next);
  }
});

productsRouter.patch("/:productId", async (request, response, next) => {
  try {
    const ctx = await requireStoreMember(request, response);
    if (!ctx) return;
    const body = request.body || {};
    const product = await request.app.locals.repository.updateProduct({
      storeId: ctx.storeId,
      productId: request.params.productId,
      title: body.title,
      handle: body.handle,
      description: body.description,
      status: body.status,
      primaryImageUrl: body.primaryImageUrl,
      priceCents: body.priceCents,
      stock: body.stock,
      sku: body.sku,
    });
    ok(response, { product }, "Product updated");
  } catch (error) {
    handleProductError(error, response, next);
  }
});

productsRouter.delete("/:productId", async (request, response, next) => {
  try {
    const ctx = await requireStoreMember(request, response);
    if (!ctx) return;
    const result = await request.app.locals.repository.deleteProduct(
      ctx.storeId,
      request.params.productId,
    );
    ok(response, result, "Product deleted");
  } catch (error) {
    handleProductError(error, response, next);
  }
});

productsRouter.post("/:productId/generate-content", async (request, response, next) => {
  try {
    const ctx = await requireStoreMember(request, response);
    if (!ctx) return;

    const product = await request.app.locals.repository.getProductById(
      ctx.storeId,
      request.params.productId,
    );
    if (!product) {
      fail(response, 404, "NOT_FOUND", "Product not found");
      return;
    }

    const body = request.body || {};
    const apply = body.apply !== false;
    const aiClient = request.app.locals.aiOrchestratorClient;
    const generated = await aiClient.generateProductCopy({
      title: body.title || product.title,
      name: body.title || product.title,
      description: body.description || product.description,
      category: body.category || product.metadata?.category,
      audience: body.audience || product.metadata?.audience,
      sellingPoint: body.sellingPoint || product.metadata?.sellingPoint,
      price:
        body.price ||
        (product.priceCents != null ? `$${(Number(product.priceCents) / 100).toFixed(2)}` : undefined),
    });

    let updatedProduct = product;
    if (apply) {
      const nextMetadata = {
        ...(product.metadata || {}),
        sellingPoints: generated.sellingPoints || [],
        aiGenerationMeta: generated.generationMeta || {},
      };
      updatedProduct = await request.app.locals.repository.updateProduct({
        storeId: ctx.storeId,
        productId: product.id,
        title: generated.title || product.title,
        description: generated.description || product.description,
        metadata: nextMetadata,
      });
    }

    ok(
      response,
      {
        product: updatedProduct,
        generated,
        applied: apply,
      },
      apply ? "AI content applied" : "AI content generated",
    );
  } catch (error) {
    handleProductError(error, response, next);
  }
});
