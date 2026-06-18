import express from "express";

import { createImportBatchService } from "../services/import-batch-service.js";

export const importBatchesRouter = express.Router();

importBatchesRouter.get("/", async (request, response, next) => {
  try {
    const repository = request.app.locals.importBatchesRepository;
    const items = await repository.listImportBatches();
    response.json({
      code: "SUCCESS",
      message: "成功",
      data: { items },
    });
  } catch (error) {
    next(error);
  }
});

importBatchesRouter.post("/", async (request, response, next) => {
  try {
    const service = createImportBatchService({
      repository: request.app.locals.importBatchesRepository,
    });
    const result = await service.createBatch(request.body || {});
    response.status(201).json({
      code: "SUCCESS",
      message: "成功",
      data: result,
    });
  } catch (error) {
    next(error);
  }
});
