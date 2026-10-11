import fs from "node:fs/promises";
import path from "node:path";

import { createZipWriter } from "../lib/zip-writer.js";

const MAX_PACK_BYTES = 28 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const DEFAULT_STOCK = 10;

function safeFileName(value, fallback = "product") {
  const cleaned = String(value || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .trim();
  return cleaned ? cleaned.slice(0, 60) : fallback;
}

function parsePriceValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const text = String(value);
  const match = text.match(/(\d+(?:\.\d+)?)/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildIntroduce(product, copyTitle) {
  const parts = [];
  const sellingPoint = String(product?.sellingPoint || "").trim();
  const scenario = String(product?.scenario || "").trim();
  if (sellingPoint) {
    parts.push(sellingPoint.replace(/[;；]/g, "，"));
  }
  if (scenario) {
    parts.push(`适用场景：${scenario}`);
  }
  if (!parts.length && copyTitle) {
    parts.push(String(copyTitle).slice(0, 120));
  }
  return parts.join("。").slice(0, 2000);
}

function resolveImageFile(publicUrl, assetsDir) {
  const raw = String(publicUrl || "").trim();
  if (!raw) {
    return null;
  }
  const base = raw.split("?")[0].split("/").pop();
  if (!base) {
    return null;
  }
  if (!IMAGE_EXTENSIONS.has(path.extname(base).toLowerCase())) {
    return null;
  }
  return { name: base, filePath: path.join(assetsDir, base) };
}

async function readImage(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size === 0) {
      return null;
    }
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

export function createListingPackService({ repository, assetsDir }) {
  if (!repository) {
    throw new Error("Missing content jobs repository");
  }
  if (!assetsDir) {
    throw new Error("Missing generated assets directory");
  }

  return {
    async buildPack({
      jobId,
      prices = {},
      publish = false,
      derivePrice = false,
      defaultStock = DEFAULT_STOCK,
    }) {
      const normalizedJobId = String(jobId || "").trim();
      if (!normalizedJobId) {
        throw new Error("Listing pack job id is required");
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

      const productIdByJobItem = new Map(
        jobItems.map((item) => [item.id, item.productId]),
      );

      const imagesByProduct = new Map();
      const imageUrlsByProduct = new Map();
      for (const output of outputs) {
        if (output.outputType !== "image_asset") {
          continue;
        }
        const productId = productIdByJobItem.get(output.jobItemId);
        if (!productId) {
          continue;
        }
        const publicUrl = String(output.outputData?.metadata?.publicUrl || "").trim();
        if (publicUrl) {
          if (!imageUrlsByProduct.has(productId)) {
            imageUrlsByProduct.set(productId, []);
          }
          imageUrlsByProduct.get(productId).push(publicUrl);
        }
        const resolved = resolveImageFile(
          output.outputData?.metadata?.publicUrl,
          assetsDir,
        );
        if (!resolved) {
          continue;
        }
        if (!imagesByProduct.has(productId)) {
          imagesByProduct.set(productId, []);
        }
        imagesByProduct.get(productId).push(resolved);
      }

      const videoUrlsByProduct = new Map();
      for (const output of outputs) {
        if (output.outputType !== "video_asset") {
          continue;
        }
        const productId = productIdByJobItem.get(output.jobItemId);
        if (!productId) {
          continue;
        }
        const publicUrl = String(output.outputData?.metadata?.publicUrl || "").trim();
        if (publicUrl && !videoUrlsByProduct.has(productId)) {
          videoUrlsByProduct.set(productId, publicUrl);
        }
      }

      const products = [];
      const pending = [];
      const skipped = [];
      const files = [];
      let packBytes = 0;

      for (const row of rows) {
        const name = String(row.productName || "").trim();
        if (!name) {
          skipped.push({ productId: row.productId, reason: "缺少商品名称" });
          continue;
        }

        const images = imagesByProduct.get(row.productId) || [];
        if (images.length === 0) {
          skipped.push({ productId: row.productId, name, reason: "没有可用图片" });
          continue;
        }

        const normalized = productById.get(row.productId) || {};
        const explicitPrice = parsePriceValue(prices?.[row.productId]);
        const derivedPrice = derivePrice ? parsePriceValue(normalized.price) : null;
        const price = explicitPrice ?? derivedPrice;

        if (price === null) {
          pending.push({
            productId: row.productId,
            name,
            suggestedPrice: parsePriceValue(normalized.price),
            imageCount: images.length,
          });
        }

        const stem = safeFileName(name, `product-${products.length + 1}`);
        const imagePaths = [];

        for (const image of images) {
          const data = await readImage(image.filePath);
          if (!data) {
            continue;
          }
          if (packBytes + data.length > MAX_PACK_BYTES) {
            break;
          }
          const entryName = `images/${stem}-${imagePaths.length + 1}${path.extname(image.name)}`;
          files.push({ name: entryName, data });
          imagePaths.push(entryName);
          packBytes += data.length;
        }

        if (imagePaths.length === 0) {
          skipped.push({ productId: row.productId, name, reason: "图片读取失败或超出单包体积上限" });
          continue;
        }

        const scenario = String(normalized.scenario || "").trim();
        const product = {
          name: name.slice(0, 128),
          productId: row.productId,
          stock: Number.isFinite(Number(defaultStock)) ? Number(defaultStock) : DEFAULT_STOCK,
          category: String(normalized.category || "").slice(0, 64) || undefined,
          brand: String(normalized.brand || "").slice(0, 64) || undefined,
          scenario: scenario || undefined,
          tags: normalized.tags || normalized.keywords || undefined,
          spec: normalized.spec || normalized.attributes || undefined,
          introduce: buildIntroduce(
            {
              sellingPoint: normalized.sellingPoint,
              scenario: normalized.scenario,
            },
            row.marketingCopyTitle,
          ),
          images: imagePaths,
          image_urls: imageUrlsByProduct.get(row.productId) || undefined,
          video_url: videoUrlsByProduct.get(row.productId) || undefined,
          desc_en: String(row.marketingCopyTitle || "").slice(0, 2000),
          sell_points: String(normalized.sellingPoint || "").slice(0, 2000),
          declare_name_en: String(row.marketingCopyTitle || "").slice(0, 128),
          declare_name_cn: name.slice(0, 128),
          goods_type: String(normalized.goodsType || "general").slice(0, 32),
          hs_code: String(normalized.hsCode || "").slice(0, 32) || undefined,
        };

        if (price !== null) {
          product.price = price;
        }

        products.push(product);
      }

      if (products.length === 0) {
        const error = new Error(
          skipped.length > 0
            ? `没有可打包的商品：${skipped[0].reason}`
            : "该任务还没有可打包的商品，请确认已生成图片",
        );
        error.statusCode = 400;
        throw error;
      }

      const manifest = {
        publish: Boolean(publish),
        generatedAt: new Date().toISOString(),
        sourceJobId: normalizedJobId,
        products,
      };

      const priceSheet = [
        "productId,name,suggestedPrice,fillPriceHere",
        ...pending.map((item) =>
          [
            item.productId,
            `"${String(item.name).replace(/"/g, '""')}"`,
            item.suggestedPrice ?? "",
            "",
          ].join(","),
        ),
      ].join("\n");

      const readme = [
        "成品包说明",
        "",
        `来源任务：${normalizedJobId}`,
        `商品数量：${products.length}`,
        `待补价：${pending.length}`,
        `跳过：${skipped.length}`,
        "",
        "1. 本包可直接上传到商家后台的「成品包导入」。",
        "2. 缺 price 的商品会被跳过，请先填 price-sheet.csv 的 fillPriceHere 列。",
        "3. desc_en 与 sell_points 是内容侧产出，需商家后台开启跨境字段写入才会落库。",
        "4. publish 为 false 时商品以下架态导入，需人工确认后再发布。",
      ].join("\n");

      const zip = createZipWriter();
      zip.addFile(
        "products.json",
        Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
      );
      zip.addFile("README.txt", Buffer.from(readme, "utf8"));
      if (pending.length > 0) {
        zip.addFile("price-sheet.csv", Buffer.from("\ufeff" + priceSheet, "utf8"));
      }
      for (const file of files) {
        zip.addFile(file.name, file.data);
      }

      return {
        jobId: normalizedJobId,
        fileName: `listing-pack-${normalizedJobId}.zip`,
        buffer: zip.toBuffer(),
        summary: {
          productCount: products.length,
          imageCount: files.length,
          pendingPriceCount: pending.length,
          skippedCount: skipped.length,
          packBytes: packBytes + 4096,
          publish: Boolean(publish),
        },
        pending,
        skipped,
        manifest,
      };
    },
  };
}
