import express from "express";

import { ACTIONS, requirePlatformPermission } from "../lib/permissions.js";

export const listingPacksRouter = express.Router();

// 推送到商城是对外动作，与 data-hub /sync 同级风险：只允许 owner。
// 下载成品包（GET /:jobId）与生成包（POST /:jobId）不在此列，它们是普通生产动作。
const requirePublish = requirePlatformPermission({ action: ACTIONS.CONTENT_PUBLISH });

function parsePrices(value) {
  if (!value) {
    return {};
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  const result = {};
  for (const chunk of String(value).split(",")) {
    const [productId, price] = chunk.split(":");
    const id = String(productId || "").trim();
    if (id && price !== undefined) {
      result[id] = String(price).trim();
    }
  }
  return result;
}

listingPacksRouter.get("/:jobId", async (request, response, next) => {
  try {
    const service = request.app.locals.listingPackService;
    if (!service) {
      response.status(503).json({
        code: "SERVICE_UNAVAILABLE",
        message: "成品包服务未启用",
        data: null,
      });
      return;
    }

    const result = await service.buildPack({
      jobId: request.params.jobId,
      prices: parsePrices(request.query?.prices),
      publish: String(request.query?.publish || "") === "1",
      derivePrice: String(request.query?.derivePrice || "") === "1",
    });

    response.setHeader("Content-Type", "application/zip");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${result.fileName}"`,
    );
    response.setHeader("X-Listing-Pack-Summary", encodeURIComponent(JSON.stringify(result.summary)));
    response.status(200).end(result.buffer);
  } catch (error) {
    next(error);
  }
});

listingPacksRouter.get("/:jobId/preview", async (request, response, next) => {
  try {
    const service = request.app.locals.listingPackService;
    if (!service) {
      response.status(503).json({
        code: "SERVICE_UNAVAILABLE",
        message: "成品包服务未启用",
        data: null,
      });
      return;
    }

    const result = await service.buildPack({
      jobId: request.params.jobId,
      prices: parsePrices(request.query?.prices),
      publish: String(request.query?.publish || "") === "1",
      derivePrice: String(request.query?.derivePrice || "") === "1",
    });

    response.json({
      code: "SUCCESS",
      message: "成功",
      data: {
        jobId: result.jobId,
        fileName: result.fileName,
        summary: result.summary,
        pending: result.pending,
        skipped: result.skipped,
        manifest: result.manifest,
      },
    });
  } catch (error) {
    next(error);
  }
});

listingPacksRouter.post("/:jobId/push", requirePublish, async (request, response, next) => {
  try {
    const service = request.app.locals.listingPackService;
    const commerceClient = request.app.locals.commerceIntegrationClient;

    if (!service) {
      response.status(503).json({
        code: "SERVICE_UNAVAILABLE",
        message: "成品包服务未启用",
        data: null,
      });
      return;
    }

    if (!commerceClient) {
      response.status(503).json({
        code: "COMMERCE_NOT_CONFIGURED",
        message: "未配置商城直推参数（COMMERCE_IMPORT_URL / COMMERCE_IMPORT_TOKEN / COMMERCE_TENANT_SLUG）",
        data: null,
      });
      return;
    }

    const result = await service.buildPack({
      jobId: request.params.jobId,
      prices: request.body?.prices || {},
      publish: Boolean(request.body?.publish),
      derivePrice: Boolean(request.body?.derivePrice),
      defaultStock: request.body?.defaultStock,
    });

    const pushed = await commerceClient.pushListingPack({
      buffer: result.buffer,
      fileName: result.fileName,
    });

    response.json({
      code: "SUCCESS",
      message: pushed?.msg || "已推送到商城",
      data: {
        jobId: result.jobId,
        fileName: result.fileName,
        target: commerceClient.target,
        summary: result.summary,
        createdCount: pushed?.createdCount ?? 0,
        errorCount: pushed?.errorCount ?? 0,
        created: pushed?.created || [],
        errors: pushed?.errors || [],
        pending: result.pending,
        skipped: result.skipped,
      },
    });
  } catch (error) {
    next(error);
  }
});

listingPacksRouter.post("/:jobId", async (request, response, next) => {
  try {
    const service = request.app.locals.listingPackService;
    if (!service) {
      response.status(503).json({
        code: "SERVICE_UNAVAILABLE",
        message: "成品包服务未启用",
        data: null,
      });
      return;
    }

    const result = await service.buildPack({
      jobId: request.params.jobId,
      prices: request.body?.prices || {},
      publish: Boolean(request.body?.publish),
      derivePrice: Boolean(request.body?.derivePrice),
      defaultStock: request.body?.defaultStock,
    });

    response.setHeader("Content-Type", "application/zip");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${result.fileName}"`,
    );
    response.setHeader("X-Listing-Pack-Summary", encodeURIComponent(JSON.stringify(result.summary)));
    response.status(200).end(result.buffer);
  } catch (error) {
    next(error);
  }
});
