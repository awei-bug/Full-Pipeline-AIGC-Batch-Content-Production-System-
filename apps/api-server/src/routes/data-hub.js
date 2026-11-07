import express from "express";

import { DEFAULT_AUTH_MODE } from "../lib/identity.js";
import { ACTIONS, can, requirePlatformPermission } from "../lib/permissions.js";
import { runTrackedHubSync } from "../services/hub-sync-tracker.js";

export const dataHubRouter = express.Router();

// 注意区分：
// - `/search` 只是读检索，不挂写权限；
// - `/ingest` 写入权威源，按平台级生成权限；
// - `/sync` 带 publish 时会触发对外上架，与 /api/listing-packs/:jobId/push 同级风险，
//   因此同样按发布权限（只给 owner）处理，而不是普通的生成权限。
const requireHubIngest = requirePlatformPermission({ action: ACTIONS.PLATFORM_GENERATE });
const requireHubPublish = requirePlatformPermission({ action: ACTIONS.CONTENT_PUBLISH });

function jobScope(action = null) {
  return async (request, response, next) => {
    try {
      if ((request.identityMode || DEFAULT_AUTH_MODE) !== "off" && (!request.identity || request.identity.kind === "anonymous")) {
        return response.status(401).json({ code: "UNAUTHORIZED", message: "请先登录", data: null });
      }
      const job = await request.app.locals.contentJobsRepository.getJobById(request.params.jobId);
      const batch = job && await request.app.locals.importBatchesRepository.getImportBatch(job.batchId);
      if (!job || !batch) return response.status(404).json({ code: "NOT_FOUND", message: "任务不存在或无权访问", data: null });
      if ((request.identityMode || DEFAULT_AUTH_MODE) !== "off" && batch.projectId) {
        const role = await request.app.locals.projectsRepository.findMemberRole(batch.projectId, request.identity.userId);
        if (!role) return response.status(404).json({ code: "NOT_FOUND", message: "任务不存在或无权访问", data: null });
        if (action && !can(role, action).allowed) return response.status(403).json({ code: "FORBIDDEN", message: "当前角色无权同步商品", data: null });
      }
      request.hubJob = job;
      return next();
    } catch (error) { return next(error); }
  };
}

function requireClient(request, response) {
  const client = request.app.locals.dataHubClient;
  if (!client) {
    response.status(503).json({
      code: "DATA_HUB_NOT_CONFIGURED",
      message: "未配置数据中心参数（DATA_HUB_URL / DATA_HUB_TENANT_SLUG）",
      data: null,
    });
    return null;
  }
  return client;
}

dataHubRouter.get("/status", async (request, response, next) => {
  const client = requireClient(request, response);
  if (!client) {
    return;
  }
  try {
    const [health, stats] = await Promise.all([
      client.health().catch((error) => ({ ok: false, error: error.message })),
      client.stats().catch(() => null),
    ]);
    response.json({
      code: "SUCCESS",
      message: "成功",
      data: {
        target: client.target,
        hub: health,
        stats: stats?.ok ? { total: stats.total, byStatus: stats.by_status } : null,
      },
    });
  } catch (error) {
    next(error);
  }
});

dataHubRouter.get("/products", async (request, response, next) => {
  const client = requireClient(request, response);
  if (!client) {
    return;
  }
  try {
    const payload = await client.listProducts({
      status: String(request.query?.status || "").trim(),
      since: String(request.query?.since || "").trim(),
      limit: Number(request.query?.limit || 50),
    });
    response.json({ code: "SUCCESS", message: "成功", data: payload });
  } catch (error) {
    next(error);
  }
});

dataHubRouter.post("/search", async (request, response, next) => {
  const client = requireClient(request, response);
  if (!client) {
    return;
  }
  try {
    const query = String(request.body?.query || "").trim();
    if (!query) {
      response.status(400).json({ code: "BAD_REQUEST", message: "query 不能为空", data: null });
      return;
    }
    const payload = await client.search({
      query,
      limit: Number(request.body?.limit || 5),
      publishedOnly: request.body?.publishedOnly !== false,
    });
    response.json({ code: "SUCCESS", message: "成功", data: payload });
  } catch (error) {
    next(error);
  }
});

dataHubRouter.get("/jobs/:jobId/status", jobScope(), async (request, response, next) => {
  try {
    const state = await request.app.locals.hubSyncStatusRepository.get(request.params.jobId);
    response.json({ code: "SUCCESS", message: "成功", data: state || { status: "unknown", message: "暂无同步记录" } });
  } catch (error) { next(error); }
});

dataHubRouter.post("/jobs/:jobId/ingest", jobScope(ACTIONS.CONTENT_WRITE), requireHubIngest, async (request, response, next) => {
  if (!["success", "partial_success"].includes(request.hubJob.status)) {
    return response.status(409).json({ code: "JOB_NOT_READY", message: "任务尚未完成，不能同步", data: null });
  }
  try {
    const result = await runTrackedHubSync({ jobId: request.params.jobId, service: request.app.locals.dataHubSyncService, statusRepository: request.app.locals.hubSyncStatusRepository });
    response.json({
      code: "SUCCESS",
      message: result.message,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

dataHubRouter.post("/jobs/:jobId/sync", jobScope(ACTIONS.CONTENT_PUBLISH), requireHubPublish, async (request, response, next) => {
  const client = requireClient(request, response);
  if (!client) {
    return;
  }
  const service = request.app.locals.dataHubSyncService;
  if (!service) {
    response.status(503).json({
      code: "SERVICE_UNAVAILABLE",
      message: "数据中心同步服务未启用",
      data: null,
    });
    return;
  }
  try {
    const result = await service.syncJob({
      jobId: request.params.jobId,
      prices: request.body?.prices || {},
      publish: Boolean(request.body?.publish),
      derivePrice: Boolean(request.body?.derivePrice),
      defaultStock: request.body?.defaultStock,
    });
    response.json({
      code: "SUCCESS",
      message: `已同步 ${result.hub.okCount}/${result.hub.received} 条到数据中心`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});
