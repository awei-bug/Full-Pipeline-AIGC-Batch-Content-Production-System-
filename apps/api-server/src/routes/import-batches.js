import express from "express";

import { ACTIONS, requirePlatformPermission } from "../lib/permissions.js";
import { UNSCOPED, resolveVisibleProjectIds } from "../lib/data-scope.js";
import { createImportBatchService } from "../services/import-batch-service.js";

export const importBatchesRouter = express.Router();

// 导入允许"无项目归属"的用户使用（allowUnscoped）：导入是把自己的数据带进来，
// 风险局限在调用者自己。生成/发布不享受这个豁免。
const requireImport = requirePlatformPermission({
  action: ACTIONS.PLATFORM_IMPORT,
  allowUnscoped: true,
});

/**
 * 项目归属校验中间件，**必须排在平台级守卫之前**。
 *
 * 原因：平台级守卫对"不属于任何项目"的用户返回 403。但如果请求显式指定了
 * 别人的 projectId，正确的响应是 404（不暴露项目是否存在）。若先跑平台级守卫，
 * 用户会拿到 403，既误导又泄漏"你可能不是成员"这层信息。
 *
 * 只校验"指定了 projectId 时调用者必须是该成员"，不指定则放行（归入未分配）。
 */
async function verifyProjectScope(request, response, next) {
  try {
    const authMode = request.identityMode || "off";
    const requestedProjectId = String(request.body?.projectId || "").trim() || null;
    request.resolvedProjectId = requestedProjectId;

    if (!requestedProjectId || authMode === "off") return next();

    const identity = request.identity;
    const repository = request.app.locals.projectsRepository;
    const roleCode = repository?.findMemberRole
      ? await repository.findMemberRole(requestedProjectId, identity?.userId)
      : null;

    if (!roleCode) {
      // 与项目级守卫一致：非成员返回 404，不暴露项目是否存在。
      return response.status(404).json({
        code: "PROJECT_NOT_FOUND",
        message: "项目不存在或无权访问",
        data: null,
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

importBatchesRouter.get("/", async (request, response, next) => {
  try {
    const repository = request.app.locals.importBatchesRepository;
    const projectIds = await resolveVisibleProjectIds(request);
    const items = await repository.listImportBatches({ projectIds });
    response.json({
      code: "SUCCESS",
      message: "成功",
      data: {
        items,
        // 让前端知道"未分配"是可见的，可提示用户归入项目
        includedUnscoped: Array.isArray(projectIds) && projectIds.includes(UNSCOPED),
      },
    });
  } catch (error) {
    next(error);
  }
});

// 顺序很关键：先校验项目归属（非成员 → 404），再校验平台级写权限（无角色 → 403）。
// 反过来的话，指定了别人 projectId 的请求会先拿到 403，既误导又泄漏信息。
importBatchesRouter.post("/", verifyProjectScope, requireImport, async (request, response, next) => {
  try {
    const requestedProjectId = request.resolvedProjectId || null;

    const service = createImportBatchService({
      repository: request.app.locals.importBatchesRepository,
    });
    const result = await service.createBatch({
      ...(request.body || {}),
      projectId: requestedProjectId,
    });
    response.status(201).json({
      code: "SUCCESS",
      message: result.projectId ? "批次已创建" : "批次已创建（未分配项目）",
      data: result,
    });
  } catch (error) {
    next(error);
  }
});
