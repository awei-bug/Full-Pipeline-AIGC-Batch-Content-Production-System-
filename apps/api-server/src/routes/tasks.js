import express from "express";

export const tasksRouter = express.Router();

tasksRouter.get("/", async (request, response, next) => {
  try {
    const projectId = String(request.query?.projectId || "").trim() || null;
    const items = await request.app.locals.workflowRepository.listTasks({ projectId });
    response.json({
      code: "SUCCESS",
      message: "成功",
      data: {
        items,
        hasMore: false,
      },
    });
  } catch (error) {
    next(error);
  }
});

tasksRouter.get("/:taskId", async (request, response, next) => {
  try {
    const task = await request.app.locals.workflowRepository.getTaskById(request.params.taskId);
    if (!task) {
      response.status(404).json({
        code: "TASK_NOT_FOUND",
        message: "任务不存在",
        data: null,
      });
      return;
    }

    response.json({
      code: "SUCCESS",
      message: "成功",
      data: task,
    });
  } catch (error) {
    next(error);
  }
});
