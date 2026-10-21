import express from "express";

import { ACTIONS, requirePlatformPermission } from "../lib/permissions.js";
import { createImportBatchService } from "../services/import-batch-service.js";

export const importBatchesRouter = express.Router();

// import_batches 同样没有 project_id，按平台级资源处理。
const requireImport = requirePlatformPermission({ action: ACTIONS.PLATFORM_IMPORT });

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

importBatchesRouter.post("/", requireImport, async (request, response, next) => {
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
