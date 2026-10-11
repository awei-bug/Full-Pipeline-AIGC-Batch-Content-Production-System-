import express from "express";
import { applyTaskEvent } from "../services/task-event-service.js";

export const orchestratorEventsRouter = express.Router();

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

orchestratorEventsRouter.post("/task-events", async (request, response, next) => {
  try {
    if (!assertInternalAccess(request, response)) {
      return;
    }

    const result = await applyTaskEvent({
      workflowRepository: request.app.locals.workflowRepository,
      event: request.body || {},
    });

    response.json({
      code: "SUCCESS",
      message: "任务事件已处理",
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
