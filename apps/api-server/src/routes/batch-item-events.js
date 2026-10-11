import express from "express";

import { applyBatchItemEvent } from "../services/batch-item-event-service.js";

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
      if (!request.app.locals.dataHubSyncService) {
        dataHubSync = {
          status: "not_configured",
          message: "数据中心同步服务未启用",
        };
      } else {
        try {
          await request.app.locals.dataHubSyncService.ingestJobContent({
            jobId: result.job.id,
          });
          dataHubSync = { status: "success" };
        } catch (error) {
          console.warn(
            `[data-hub] 自动入库失败，jobId=${result.job.id}:`,
            error.message || error,
          );
          dataHubSync = {
            status: "failed",
            message: error.message || "数据中心入库失败",
          };
        }
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
