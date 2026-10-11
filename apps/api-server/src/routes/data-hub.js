import express from "express";

export const dataHubRouter = express.Router();

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

dataHubRouter.post("/jobs/:jobId/ingest", async (request, response, next) => {
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
    const result = await service.ingestJobContent({ jobId: request.params.jobId });
    response.json({
      code: "SUCCESS",
      message: `已入库 ${result.hub.okCount}/${result.hub.received} 条`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

dataHubRouter.post("/jobs/:jobId/sync", async (request, response, next) => {
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
