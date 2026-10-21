import express from "express";

import { ACTIONS, requirePlatformPermission } from "../lib/permissions.js";
import { createContentJobService } from "../services/content-job-service.js";

export const contentJobsRouter = express.Router();

// content_jobs 没有 project_id（见 infra/sql/005），是平台级资源：
// 用平台级权限点，而不是伪造一个 projectId 来做"假的隔离"。
const requireGenerate = requirePlatformPermission({ action: ACTIONS.PLATFORM_GENERATE });

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

contentJobsRouter.post("/", requireGenerate, async (request, response, next) => {
  try {
    const orchestratorClient = request.app.locals.aiOrchestratorClient;
    if (!orchestratorClient) {
      response.status(503).json({
        code: "ORCHESTRATOR_UNAVAILABLE",
        message: "AI 编排服务未配置，无法创建批量任务",
        data: null,
      });
      return;
    }

    const service = createContentJobService({
      repository: request.app.locals.contentJobsRepository,
      orchestratorClient,
    });
    const result = await service.createJob(request.body || {});
    response.status(202).json({
      code: "SUCCESS",
      message: "成功",
      data: result,
    });
  } catch (error) {
    if (/batch id|content type/i.test(error.message || "")) {
      response.status(400).json({
        code: "INVALID_PARAM",
        message: error.message,
        data: null,
      });
      return;
    }
    next(error);
  }
});
