import express from "express";

import { applyBatchItemEvent } from "../services/batch-item-event-service.js";

export const batchItemEventsRouter = express.Router();

batchItemEventsRouter.post("/", async (request, response, next) => {
  try {
    const result = await applyBatchItemEvent({
      contentJobsRepository: request.app.locals.contentJobsRepository,
      event: request.body || {},
    });

    response.json({
      code: "SUCCESS",
      message: "批量子任务事件已处理",
      data: result,
    });
  } catch (error) {
    if (error.code === "INVALID_PARAM" || error.code === "INVALID_STATUS") {
      response.status(400).json({
        code: error.code,
        message: error.message,
        data: null,
      });
      return;
    }

    next(error);
  }
});
