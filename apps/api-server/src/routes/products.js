import express from "express";

import { createProductsService } from "../services/products-service.js";

export const productsRouter = express.Router();

productsRouter.get("/", async (request, response, next) => {
  try {
    const service = createProductsService({
      repository: request.app.locals.productsRepository,
    });
    const batchId = String(request.query?.batchId || "").trim();
    const items = await service.listByBatchId(batchId);

    response.json({
      code: "SUCCESS",
      message: "成功",
      data: { items },
    });
  } catch (error) {
    next(error);
  }
});
