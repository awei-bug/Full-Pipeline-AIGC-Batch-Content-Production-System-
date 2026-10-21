import express from "express";

import { resolveVisibleProjectIds } from "../lib/data-scope.js";
import { ACTIONS, requirePlatformPermission } from "../lib/permissions.js";
import { createContentJobService } from "../services/content-job-service.js";

export const contentJobsRouter = express.Router();

// content_jobs 本身没有 project_id（见 infra/sql/005），但它通过 import_batch_id
// 归属到批次，批次再归属到项目。写操作用平台级权限点，**读操作按批次的项目过滤**
// ——不按项目过滤的话，任何登录用户都能看到别人项目里的任务与产出。
const requireGenerate = requirePlatformPermission({ action: ACTIONS.PLATFORM_GENERATE });

contentJobsRouter.get("/", async (request, response, next) => {
  try {
    const projectIds = await resolveVisibleProjectIds(request);
    const items = await request.app.locals.contentJobsRepository.listJobs({ projectIds });
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

    const batchId = String(request.body?.batchId || "").trim();
    const authMode = request.identityMode || "off";

    // 创建任务前确认该批次对调用者可见。否则用户可以拿别人批次的 id 直接建任务，
    // 从而间接读到他没权限看的商品数据。
    if (batchId && authMode !== "off") {
      const batches = request.app.locals.importBatchesRepository;
      const batch = batches?.getImportBatch ? await batches.getImportBatch(batchId) : null;
      if (!batch) {
        response.status(404).json({
          code: "BATCH_NOT_FOUND",
          message: "批次不存在或无权访问",
          data: null,
        });
        return;
      }
      if (batch.projectId) {
        const projectsRepository = request.app.locals.projectsRepository;
        const roleCode = projectsRepository?.findMemberRole
          ? await projectsRepository.findMemberRole(batch.projectId, request.identity.userId)
          : null;
        if (!roleCode) {
          // 与其它守卫一致：非成员返回 404，不暴露批次是否存在。
          response.status(404).json({
            code: "BATCH_NOT_FOUND",
            message: "批次不存在或无权访问",
            data: null,
          });
          return;
        }
      }
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
