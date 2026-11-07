import express from "express";

import { DEFAULT_AUTH_MODE } from "../lib/identity.js";

export const inventoryDraftsRouter = express.Router();

function requireIdentity(request, response) {
  const mode = request.identityMode || DEFAULT_AUTH_MODE;
  if (mode !== "off" && (!request.identity || request.identity.kind === "anonymous")) {
    response.status(401).json({ code: "UNAUTHORIZED", message: "请先登录", data: null });
    return null;
  }
  return request.identity || { kind: "demo", tenantId: null };
}

/**
 * 库存联动草稿列表。
 *
 * 只读：草稿由后台消费器从云购库存事件生成，前端不提供手工写入口，
 * 避免"页面上补一条"变成第二个未经事件驱动的数据源。
 * 租户过滤用云购租户 id（identity.tenantId），与事件里的 tenant_id 同一空间。
 */
inventoryDraftsRouter.get("/", async (request, response, next) => {
  try {
    const identity = requireIdentity(request, response);
    if (!identity) return undefined;

    const repository = request.app.locals.inventoryDraftsRepository;
    if (!repository) {
      return response.status(503).json({
        code: "DATABASE_NOT_CONFIGURED",
        message: "未配置数据库，库存草稿不可用",
        data: null,
      });
    }

    const limit = Number(request.query.limit || 50);
    const status = String(request.query.status || "").trim();
    const items = await repository.listDrafts({
      tenantId: identity.tenantId ?? null,
      limit: Number.isFinite(limit) ? limit : 50,
      status,
    });

    return response.json({
      code: "SUCCESS",
      message: "成功",
      data: {
        items,
        total: items.length,
        tenantId: identity.tenantId ?? null,
        source: "yungou.stock.changed",
      },
    });
  } catch (error) {
    return next(error);
  }
});
