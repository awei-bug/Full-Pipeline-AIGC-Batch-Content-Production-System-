import express from "express";
import { canReadJob } from "../lib/data-scope.js";

export const contentOutputsRouter = express.Router();

contentOutputsRouter.get("/", async (request, response, next) => {
  try {
    const jobId = String(request.query?.jobId || "").trim();
    if (!jobId) {
      response.status(400).json({
        code: "INVALID_PARAM",
        message: "jobId is required",
        data: null,
      });
      return;
    }

    if (!await canReadJob(request, jobId)) {
      return response.status(404).json({ code: "NOT_FOUND", message: "任务不存在或无权访问", data: null });
    }
    const items = await request.app.locals.contentJobsRepository.listOutputsByJobId(jobId);
    response.json({
      code: "SUCCESS",
      message: "成功",
      data: { items },
    });
  } catch (error) {
    next(error);
  }
});
