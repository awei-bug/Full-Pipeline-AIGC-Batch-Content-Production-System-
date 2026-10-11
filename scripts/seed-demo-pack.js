import fs from "node:fs/promises";
import path from "node:path";

import { buildApp } from "../apps/api-server/src/server.js";

const rootDir = path.resolve(import.meta.dirname, "..");
const assetsDir = path.join(rootDir, "storage", "generated");
const PORT = Number(process.env.API_PORT || 3100);

const DEMO_PRODUCTS = [
  {
    name: "不锈钢真空保温杯",
    sellingPoint: "双层真空；防漏；食品级材质",
    price: "FOB $2.8 / MOQ 500",
    category: "日用百货",
    audience: "美国/欧洲",
    scenario: "礼品与商超渠道",
  },
  {
    name: "护眼 LED 台灯",
    sellingPoint: "无频闪；亮度可调；USB-C 供电",
    price: "FOB $6.8 / MOQ 300",
    category: "家居办公",
    audience: "欧洲",
    scenario: "家庭办公",
  },
  {
    name: "便携充电榨汁杯",
    sellingPoint: "USB 充电；六叶刀头；400ml",
    price: "",
    category: "厨房小电",
    audience: "东南亚",
    scenario: "旅行与健身",
  },
];

const DEMO_TITLES = [
  "Vacuum Insulated Stainless Steel Bottle, 24h Cold 12h Hot",
  "Eye-Care LED Desk Lamp with Adjustable Brightness",
  "Portable USB Rechargeable Blender, 400ml",
];

async function seed(app) {
  const batches = app.locals.importBatchesRepository;
  const jobs = app.locals.contentJobsRepository;

  const batch = await batches.createImportBatch({
    fileName: "demo-products.csv",
    fieldMapping: {
      name: "name",
      sellingPoint: "sellingPoint",
      price: "price",
      category: "category",
      audience: "audience",
      scenario: "scenario",
    },
  });

  const products = await batches.createProducts(
    DEMO_PRODUCTS.map((item, index) => ({
      batchId: batch.id,
      sourceRowNo: index + 1,
      originalData: item,
      normalizedData: item,
    })),
  );

  const entries = await fs.readdir(assetsDir);
  const images = entries.filter((name) => name.toLowerCase().endsWith(".png")).slice(0, 6);

  const job = await jobs.createJob({
    batchId: batch.id,
    contentTypes: ["marketing_copy", "image_asset"],
  });

  const jobItems = await jobs.createJobItems(
    products.map((product) => ({
      jobId: job.id,
      productId: product.id,
      status: "pending",
    })),
  );

  for (let index = 0; index < jobItems.length; index += 1) {
    await jobs.createOutputs(jobItems[index].id, [
      { outputType: "marketing_copy", outputData: { title: DEMO_TITLES[index] } },
      ...[images[index * 2], images[index * 2 + 1]].filter(Boolean).map((name) => ({
        outputType: "image_asset",
        outputData: {
          assetType: "image",
          storageProvider: "local",
          objectKey: `generated/${name}`,
          fileName: name,
          metadata: { publicUrl: `/storage/assets/${name}` },
        },
      })),
    ]);
    await jobs.updateJobItemResult({
      jobItemId: jobItems[index].id,
      status: "success",
      resultSummary: { outputCount: 3 },
    });
  }

  return { batchId: batch.id, jobId: job.id };
}

async function main() {
  const app = await buildApp({
    env: { ...process.env, DATABASE_URL: "", PGHOST: "", POSTGRES_HOST: "" },
  });

  const seeded = await seed(app);
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`api-server listening on http://127.0.0.1:${PORT}`);
    console.log(`demo batch: ${seeded.batchId}`);
    console.log(`demo job:   ${seeded.jobId}`);
    console.log(`preview:    http://127.0.0.1:${PORT}/api/listing-packs/${seeded.jobId}/preview`);
  });
}

main().catch((error) => {
  console.error("启动失败:", error);
  process.exit(1);
});
