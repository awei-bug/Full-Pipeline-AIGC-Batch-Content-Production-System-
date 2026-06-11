import express from "express";
import { applyTaskEvent } from "../services/task-event-service.js";

export const orchestratorEventsRouter = express.Router();

orchestratorEventsRouter.post("/task-events", async (request, response, next) => {
  try {
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
