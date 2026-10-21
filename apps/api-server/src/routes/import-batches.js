import express from "express";

import { ACTIONS, requirePlatformPermission } from "../lib/permissions.js";
import { createImportBatchService } from "../services/import-batch-service.js";

export const importBatchesRouter = express.Router();

// 导入允许"无项目归属"的用户使用（allowUnscoped）：导入是把自己的数据带进来，
// 风险局限在调用者自己。生成/发布不享受这个豁免。
const requireImport = requirePlatformPermission({
  action: ACTIONS.PLATFORM_IMPORT,
  allowUnscoped: true,
});

/** 未分配批次的哨兵值，与仓储层约定保持一致。 */
const UNSCOPED = "__unscoped__";

/**
 * 计算"当前请求能看哪些项目的批次"。
 *
 * 三种情况：
 * - `AUTH_MODE=off`：本地演示，不做过滤（返回 null，仓储层不过滤）。
 *   这是刻意的向后兼容，否则单机演示会看不到自己刚导入的批次。
 * - 已登录：只返回该用户是成员的项目；**额外包含未分配批次**——
 *   理由见下。
 * - 匿名：返回空数组，看不到任何批次。
 *
 * 为什么已登录用户还能看见「未分配」批次
 * ------------------------------------
 * 历史数据与"导入时未指定项目"的批次没有归属。如果完全隐藏，用户会发现自己
 * 刚导入的东西消失了（因为前端还没要求选项目）。折中：可见但明确标注
 * `projectId: null`，前端可以提示"未分配，建议归入项目"。等前端接上选择器后，
 * 这个口子应该关掉。
 */
async function resolveVisibleProjectIds(request) {
  if ((request.identityMode || "off") === "off") return null;

  const identity = request.identity;
  if (!identity || identity.kind === "anonymous") return [];

  const repository = request.app.locals.projectsRepository;
  if (!repository?.listRolesForUser) return [UNSCOPED];

  const memberships = await repository.listRolesForUser(identity.userId);
  const projectIds = [...new Set(memberships.map((item) => item.projectId).filter(Boolean))];
  return [...projectIds, UNSCOPED];
}

/**
 * 项目归属校验中间件，**必须排在平台级守卫之前**。
 *
 * 原因：平台级守卫对"不属于任何项目"的用户返回 403（什么都不能做）。但如果
 * 请求显式指定了别人的 projectId，正确的响应是 404（不暴露项目是否存在）。
 * 若先跑平台级守卫，用户会拿到 403，既误导又泄漏了"你可能不是成员"这层信息。
 *
 * 这里只校验"指定了 projectId 时调用者必须是该成员"，不指定则放行（归入未分配）。
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
