import fs from "node:fs/promises";
import path from "node:path";

import { buildApp } from "../apps/api-server/src/server.js";

const rootDir = path.resolve(import.meta.dirname, "..");
const assetsDir = path.join(rootDir, "storage", "generated");

async function seed(repository, productsRepository) {
  const products = [
    {
      id: "prod_bottle",
      normalizedData: {
        name: "不锈钢真空保温杯",
        sellingPoint: "双层真空；防漏；食品级材质",
        price: "FOB $2.8 / MOQ 500",
        scenario: "礼品与商超渠道",
      },
    },
    {
      id: "prod_lamp",
      normalizedData: {
        name: "护眼 LED 台灯",
        sellingPoint: "无频闪；亮度可调；USB-C 供电",
        price: "FOB $6.8 / MOQ 300",
        scenario: "家庭办公",
      },
    },
    {
      id: "prod_blender",
      normalizedData: {
        name: "便携充电榨汁杯",
        sellingPoint: "USB 充电；六叶刀头；400ml",
        price: "",
        scenario: "旅行与健身",
      },
    },
  ];

  productsRepository.importBatchesRepository.products.push(
    ...products.map((product, index) => ({
      ...product,
      batchId: "batch_verify",
      sourceRowNo: index + 1,
      originalData: product.normalizedData,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  );

  const entries = await fs.readdir(assetsDir);
  const images = entries.filter((name) => name.toLowerCase().endsWith(".png")).slice(0, 6);

  const job = await repository.createJob({
    batchId: "batch_verify",
    contentTypes: ["marketing_copy", "image_asset"],
  });

  const jobItems = await repository.createJobItems(
    products.map((product) => ({
      jobId: job.id,
      productId: product.id,
      status: "success",
    })),
  );

  const titles = [
    "Vacuum Insulated Stainless Steel Bottle, 24h Cold 12h Hot",
    "Eye-Care LED Desk Lamp with Adjustable Brightness",
    "Portable USB Rechargeable Blender, 400ml",
  ];

  for (let index = 0; index < jobItems.length; index += 1) {
    await repository.createOutputs(jobItems[index].id, [
      { outputType: "marketing_copy", outputData: { title: titles[index] } },
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
  }

  return job.id;
}

async function main() {
  const app = await buildApp({
    env: { ...process.env, DATABASE_URL: "", PGHOST: "", POSTGRES_HOST: "" },
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const jobId = await seed(
      app.locals.contentJobsRepository,
      app.locals.productsRepository,
    );

    const previewResponse = await fetch(`${base}/api/listing-packs/${jobId}/preview`);
    const preview = await previewResponse.json();
    console.log("preview status:", previewResponse.status);
    console.log("summary:", JSON.stringify(preview.data?.summary));
    console.log("pending:", (preview.data?.pending || []).map((item) => `${item.name} 建议 ${item.suggestedPrice ?? "无"}`).join(" | "));

    const packResponse = await fetch(`${base}/api/listing-packs/${jobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prices: { prod_bottle: 89, prod_lamp: 159 },
        publish: false,
      }),
    });

    const buffer = Buffer.from(await packResponse.arrayBuffer());
    const outFile = path.join(rootDir, "storage", "listing-pack-demo.zip");
    await fs.writeFile(outFile, buffer);

    console.log("");
    console.log("download status:", packResponse.status);
    console.log("content-type:", packResponse.headers.get("content-type"));
    console.log("disposition:", packResponse.headers.get("content-disposition"));
    console.log("zip bytes:", buffer.length, `(${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
    console.log("输出:", outFile);

    const missing = await fetch(`${base}/api/listing-packs/job_none/preview`);
    console.log("");
    console.log("missing job:", missing.status, (await missing.json()).message);
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error("验证失败:", error);
  process.exit(1);
});
