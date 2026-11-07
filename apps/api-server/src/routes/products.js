import express from "express";

import { createProductsService } from "../services/products-service.js";
import { canReadBatch } from "../lib/data-scope.js";

export const productsRouter = express.Router();

productsRouter.get("/", async (request, response, next) => {
  try {
    const service = createProductsService({
      repository: request.app.locals.productsRepository,
    });
    const batchId = String(request.query?.batchId || "").trim();
    if (!await canReadBatch(request, batchId)) {
      return response.status(404).json({ code: "NOT_FOUND", message: "批次不存在或无权访问", data: null });
    }
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
