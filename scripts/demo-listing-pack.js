import fs from "node:fs/promises";
import path from "node:path";

import { MemoryContentJobsRepository } from "../apps/api-server/src/repositories/content-jobs-repository.js";
import { createListingPackService } from "../apps/api-server/src/services/listing-pack-service.js";

const rootDir = path.resolve(import.meta.dirname, "..");
const assetsDir = path.join(rootDir, "storage", "generated");

async function pickImages(count) {
  const entries = await fs.readdir(assetsDir);
  const images = entries.filter((name) => name.toLowerCase().endsWith(".png"));
  return images.slice(0, count);
}

function buildOutputs(imageNames) {
  return imageNames.map((name) => ({
    outputType: "image_asset",
    outputData: {
      assetType: "image",
      storageProvider: "local",
      objectKey: `generated/${name}`,
      fileName: name,
      mimeType: "image/png",
      metadata: {
        publicUrl: `/storage/assets/${name}`,
      },
    },
  }));
}

async function main() {
  const images = await pickImages(6);
  if (images.length < 4) {
    throw new Error("storage/generated 中可用的 PNG 不足 4 张，无法演示");
  }

  const products = [
    {
      id: "prod_bottle",
      normalizedData: {
        name: "不锈钢真空保温杯",
        sellingPoint: "双层真空；防漏；食品级材质",
        price: "FOB $2.8 / MOQ 500",
        category: "日用百货",
        audience: "美国/欧洲",
        scenario: "礼品与商超渠道",
      },
    },
    {
      id: "prod_lamp",
      normalizedData: {
        name: "护眼 LED 台灯",
        sellingPoint: "无频闪；亮度可调；USB-C 供电",
        price: "FOB $6.8 / MOQ 300",
        category: "家居办公",
        audience: "欧洲",
        scenario: "家庭办公",
      },
    },
    {
      id: "prod_blender",
      normalizedData: {
        name: "便携充电榨汁杯",
        sellingPoint: "USB 充电；六叶刀头；400ml",
        price: "",
        category: "厨房小电",
        audience: "东南亚",
        scenario: "旅行与健身",
      },
    },
  ];

  const productsRepository = {
    async listProductsByBatchId() {
      return products;
    },
    importBatchesRepository: { products },
  };

  const repository = new MemoryContentJobsRepository(productsRepository);

  const job = await repository.createJob({
    batchId: "batch_demo",
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
    const imageNames = [images[index * 2], images[index * 2 + 1]].filter(Boolean);
    await repository.createOutputs(jobItems[index].id, [
      {
        outputType: "marketing_copy",
        outputData: { title: titles[index] },
      },
      ...buildOutputs(imageNames),
    ]);
  }

  const service = createListingPackService({ repository, assetsDir });

  const preview = await service.buildPack({ jobId: job.id });
  console.log("=== 未补价预览 ===");
  console.log(JSON.stringify(preview.summary, null, 2));
  console.log("待补价:", preview.pending.map((item) => `${item.name}(建议 ${item.suggestedPrice ?? "无"})`).join(" / "));

  const priced = await service.buildPack({
    jobId: job.id,
    prices: { prod_bottle: 89, prod_lamp: 159 },
  });

  const outFile = path.join(rootDir, "storage", "listing-pack-demo.zip");
  await fs.writeFile(outFile, priced.buffer);

  console.log("");
  console.log("=== 补价后打包 ===");
  console.log(JSON.stringify(priced.summary, null, 2));
  console.log("输出:", outFile, `${(priced.buffer.length / 1024 / 1024).toFixed(2)} MB`);
  console.log("manifest:", JSON.stringify(priced.manifest.products, null, 2).slice(0, 900));
}

main().catch((error) => {
  console.error("演示失败:", error);
  process.exit(1);
});
