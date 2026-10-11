const HUB_ID_PREFIX = "cc";

function splitPoints(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value)
    .split(/[\n;；。]|(?<=[!?！？])\s*/)
    .map((item) => item.trim().replace(/^[-·•\s]+/, ""))
    .filter(Boolean);
}

function normalizeTags(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value)
    .split(/[,，;；|/]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildHubExternalId(product, index) {
  const productId = String(product?.productId || "").trim();
  if (productId) {
    return `${HUB_ID_PREFIX}-${productId}`;
  }
  const name = String(product?.name || "").trim();
  if (name) {
    return `${HUB_ID_PREFIX}-slug-${index}-${name.slice(0, 24)}`;
  }
  return `${HUB_ID_PREFIX}-idx-${index}`;
}

export function toHubItem(product, index, jobId) {
  const images = Array.isArray(product?.image_urls) && product.image_urls.length > 0
    ? product.image_urls
    : Array.isArray(product?.images)
      ? product.images
      : [];

  return {
    external_id: buildHubExternalId(product, index),
    title: String(product?.name || "").slice(0, 128),
    subtitle: String(product?.sell_points || "").split(/[\n;；]/)[0]?.slice(0, 120) || undefined,
    title_en: String(product?.declare_name_en || "").slice(0, 128) || undefined,
    price: toNumberOrNull(product?.price),
    stock: toNumberOrNull(product?.stock),
    category: product?.category || undefined,
    brand: product?.brand || undefined,
    tags: normalizeTags(product?.tags),
    selling_points: splitPoints(product?.sell_points),
    scenario: product?.scenario || undefined,
    spec: product?.spec && typeof product.spec === "object" ? product.spec : undefined,
    faq: Array.isArray(product?.faq) ? product.faq : undefined,
    desc_zh: String(product?.introduce || "").slice(0, 4000) || undefined,
    desc_en: String(product?.desc_en || "").slice(0, 4000) || undefined,
    images: images.slice(0, 8),
    video_url: product?.video_url || undefined,
    declare_name_cn: String(product?.declare_name_cn || product?.name || "").slice(0, 128) || undefined,
    declare_name_en: String(product?.declare_name_en || "").slice(0, 128) || undefined,
    declare_value: toNumberOrNull(product?.declare_value),
    goods_type: product?.goods_type || "general",
    hs_code: product?.hs_code || undefined,
    source_job_id: jobId,
  };
}

function buildContentItem(row, normalized, images, videoUrl, jobId) {
  const name = String(row?.productName || normalized?.name || "").trim();
  if (!name) {
    return null;
  }
  const sellingPoint = String(normalized?.sellingPoint || "").trim();
  const scenario = String(normalized?.scenario || "").trim();
  const introduce = [sellingPoint, scenario ? `适用场景：${scenario}` : ""]
    .filter(Boolean)
    .join("。")
    .replace(/[;；]/g, "，");

  return {
    external_id: `cc-${row.productId || name}`,
    title: name.slice(0, 128),
    subtitle: sellingPoint.split(/[\n;；]/)[0]?.slice(0, 120) || undefined,
    title_en: String(row?.marketingCopyTitle || "").slice(0, 128) || undefined,
    price: toNumberOrNull(normalized?.price),
    stock: toNumberOrNull(normalized?.stock ?? normalized?.number),
    category: normalized?.category || undefined,
    brand: normalized?.brand || undefined,
    tags: normalizeTags(normalized?.tags || normalized?.keywords),
    selling_points: splitPoints(sellingPoint),
    scenario: scenario || undefined,
    spec: normalized?.spec || normalized?.attributes || undefined,
    faq: Array.isArray(normalized?.faq) ? normalized.faq : undefined,
    desc_zh: introduce.slice(0, 4000) || undefined,
    desc_en: String(row?.marketingCopyTitle || "").slice(0, 4000) || undefined,
    images: (images || []).slice(0, 8),
    video_url: videoUrl || undefined,
    declare_name_cn: name.slice(0, 128),
    declare_name_en: String(row?.marketingCopyTitle || "").slice(0, 128) || undefined,
    goods_type: normalized?.goodsType || "general",
    hs_code: normalized?.hsCode || undefined,
    source_job_id: jobId,
  };
}

export function createDataHubSyncService({ listingPackService, dataHubClient, repository }) {
  if (!listingPackService) {
    throw new Error("Missing listing pack service");
  }
  if (!dataHubClient) {
    throw new Error("Missing data hub client");
  }

  return {
    /**
     * 生成即入库：直接读任务产出写入数据中心，不要求图片已就绪。
     * 与 syncJob 的区别是不走成品包（成品包会因缺图跳过条目）。
     */
    async ingestJobContent({ jobId }) {
      if (!repository) {
        const error = new Error("缺少内容任务仓储，无法直接入库");
        error.statusCode = 503;
        throw error;
      }

      const normalizedJobId = String(jobId || "").trim();
      if (!normalizedJobId) {
        const error = new Error("jobId 不能为空");
        error.statusCode = 400;
        throw error;
      }

      const job = await repository.getJobById(normalizedJobId);
      if (!job) {
        const error = new Error("任务不存在");
        error.statusCode = 404;
        throw error;
      }

      const [rows, jobItems, outputs, batchProducts] = await Promise.all([
        repository.listExportRowsByJobId(normalizedJobId),
        repository.listJobItemsByJobId(normalizedJobId),
        repository.listOutputsByJobId(normalizedJobId),
        job.batchId ? repository.listProductsByBatchId(job.batchId) : Promise.resolve([]),
      ]);

      const productById = new Map(
        (batchProducts || []).map((item) => [item.id, item.normalizedData || {}]),
      );
      const productIdByJobItem = new Map(jobItems.map((item) => [item.id, item.productId]));
      const imagesByProduct = new Map();
      const videoByProduct = new Map();

      for (const output of outputs || []) {
        const productId = productIdByJobItem.get(output.jobItemId);
        if (!productId) {
          continue;
        }
        const url = String(output?.outputData?.metadata?.publicUrl || "").trim();
        if (!url) {
          continue;
        }
        if (output.outputType === "image_asset") {
          if (!imagesByProduct.has(productId)) {
            imagesByProduct.set(productId, []);
          }
          imagesByProduct.get(productId).push(url);
        } else if (output.outputType === "video_asset" && !videoByProduct.has(productId)) {
          videoByProduct.set(productId, url);
        }
      }

      const items = [];
      const skipped = [];
      for (const row of rows || []) {
        const item = buildContentItem(
          row,
          productById.get(row.productId) || {},
          imagesByProduct.get(row.productId) || [],
          videoByProduct.get(row.productId),
          normalizedJobId,
        );
        if (item) {
          items.push(item);
        } else {
          skipped.push({ productId: row.productId, reason: "缺少商品名称" });
        }
      }

      if (items.length === 0) {
        const error = new Error("该任务还没有可入库的内容");
        error.statusCode = 400;
        throw error;
      }

      const ingested = await dataHubClient.ingest({ items, jobId: normalizedJobId });

      return {
        jobId: normalizedJobId,
        mode: "content",
        hub: {
          target: dataHubClient.target,
          received: ingested.received,
          okCount: ingested.ok_count,
          created: ingested.created,
          updated: ingested.updated,
          unchanged: ingested.unchanged,
          errorCount: ingested.error_count,
          results: ingested.results,
        },
        skipped,
        items,
      };
    },

    async syncJob({
      jobId,
      prices = {},
      publish = false,
      derivePrice = false,
      defaultStock,
    }) {
      const result = await listingPackService.buildPack({
        jobId,
        prices,
        publish,
        derivePrice,
        defaultStock,
      });

      const items = (result.manifest?.products || []).map((product, index) =>
        toHubItem(product, index, result.jobId),
      );

      if (items.length === 0) {
        const error = new Error("该任务没有可同步到数据中心的商品");
        error.statusCode = 400;
        throw error;
      }

      const ingested = await dataHubClient.ingest({ items, jobId: result.jobId });

      return {
        jobId: result.jobId,
        summary: result.summary,
        pending: result.pending,
        skipped: result.skipped,
        hub: {
          target: dataHubClient.target,
          received: ingested.received,
          okCount: ingested.ok_count,
          created: ingested.created,
          updated: ingested.updated,
          unchanged: ingested.unchanged,
          errorCount: ingested.error_count,
          results: ingested.results,
        },
        items,
      };
    },
  };
}
