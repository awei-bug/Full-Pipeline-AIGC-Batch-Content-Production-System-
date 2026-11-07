import express from "express";

import { applyBatchItemEvent } from "../services/batch-item-event-service.js";
import { runTrackedHubSync } from "../services/hub-sync-tracker.js";

export const batchItemEventsRouter = express.Router();

function assertInternalAccess(request, response) {
  const expected = String(process.env.INTERNAL_CALLBACK_TOKEN || "").trim();
  if (!expected) {
    return true;
  }

  const provided = String(
    request.get("x-internal-token") || request.get("x-callback-token") || "",
  ).trim();
  if (provided && provided === expected) {
    return true;
  }

  response.status(401).json({
    code: "UNAUTHORIZED",
    message: "Invalid internal callback token",
    data: null,
  });
  return false;
}

batchItemEventsRouter.post("/", async (request, response, next) => {
  try {
    if (!assertInternalAccess(request, response)) {
      return;
    }

    const result = await applyBatchItemEvent({
      contentJobsRepository: request.app.locals.contentJobsRepository,
      event: request.body || {},
    });

    let dataHubSync = null;
    if (
      !result.idempotent &&
      result.job &&
      ["success", "partial_success"].includes(result.job.status)
    ) {
      try {
        dataHubSync = await runTrackedHubSync({ jobId: result.job.id, service: request.app.locals.dataHubSyncService, statusRepository: request.app.locals.hubSyncStatusRepository });
      } catch {
        // Task completion is durable even if the separate status store is unavailable.
        console.error("[data-hub] 无法记录同步状态");
        dataHubSync = { status: "unknown", message: "无法记录同步状态，请检查数据库" };
      }
    }

    response.json({
      code: "SUCCESS",
      message: "批量子任务事件已处理",
      data: { ...result, dataHubSync },
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
