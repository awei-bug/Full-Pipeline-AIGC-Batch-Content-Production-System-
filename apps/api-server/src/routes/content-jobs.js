import express from "express";

import { createContentJobService } from "../services/content-job-service.js";

export const contentJobsRouter = express.Router();

contentJobsRouter.get("/", async (request, response, next) => {
  try {
    const items = await request.app.locals.contentJobsRepository.listJobs();
    response.json({
      code: "SUCCESS",
      message: "成功",
      data: { items },
    });
  } catch (error) {
    next(error);
  }
});

contentJobsRouter.post("/", async (request, response, next) => {
  try {
    const service = createContentJobService({
      repository: request.app.locals.contentJobsRepository,
      orchestratorClient: request.app.locals.aiOrchestratorClient,
    });
    const result = await service.createJob(request.body || {});
    response.status(202).json({
      code: "SUCCESS",
      message: "成功",
      data: result,
    });
  } catch (error) {
    next(error);
  }
});
