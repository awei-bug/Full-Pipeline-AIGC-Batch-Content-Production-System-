import assert from "node:assert/strict";
import test from "node:test";

import { applyBatchItemEvent } from "./batch-item-event-service.js";
import {
  MemoryContentJobsRepository,
} from "../repositories/content-jobs-repository.js";
import {
  MemoryProductsRepository,
} from "../repositories/products-repository.js";
import {
  MemoryImportBatchesRepository,
} from "../repositories/import-batches-repository.js";

async function createBatchJobContext() {
  const importBatchesRepository = new MemoryImportBatchesRepository();
  const batch = await importBatchesRepository.createImportBatch({
    fileName: "products.csv",
    fieldMapping: { name: "title" },
  });
  const createdProducts = await importBatchesRepository.createProducts([
    {
      batchId: batch.id,
      sourceRowNo: 1,
      originalData: { title: "防晒喷雾" },
      normalizedData: { name: "防晒喷雾", sellingPoint: "清爽不油腻" },
    },
  ]);

  const productsRepository = new MemoryProductsRepository(importBatchesRepository);
  const contentJobsRepository = new MemoryContentJobsRepository(productsRepository);
  const job = await contentJobsRepository.createJob({
    batchId: batch.id,
    contentTypes: ["marketing_copy", "image_prompt"],
  });
  const jobItems = await contentJobsRepository.createJobItems([
    {
      jobId: job.id,
      productId: createdProducts[0].id,
      status: "pending",
    },
  ]);

  return {
    repository: contentJobsRepository,
    job,
    jobItem: jobItems[0],
  };
}

test("batch item success event updates item status and persists outputs", async () => {
  const { repository, jobItem } = await createBatchJobContext();

  const result = await applyBatchItemEvent({
    contentJobsRepository: repository,
    event: {
      jobItemId: jobItem.id,
      status: "succeeded",
      outputs: [
        {
          outputType: "marketing_copy",
          outputData: {
            title: "夏季清爽防晒喷雾",
            body: "通勤随手喷，防晒不黏腻。",
          },
        },
        {
          outputType: "image_prompt",
          outputData: {
            prompt: "一瓶防晒喷雾置于通勤包旁，干净明亮的夏季广告风格",
          },
        },
      ],
      usage: {
        estimatedTokens: 320,
        estimatedCost: 0.08,
      },
      riskStatus: "passed",
      warnings: [],
    },
  });

  assert.equal(result.jobItem.status, "success");
  assert.equal(result.outputs.length, 2);
  assert.equal(result.outputs[0].outputType, "marketing_copy");
  assert.equal(result.job.status, "success");
  assert.equal(result.job.progress, 100);

  const jobOutputs = await repository.listOutputsByJobId(jobItem.jobId);
  assert.equal(jobOutputs.length, 2);
  assert.equal(jobOutputs[0].jobItemId, jobItem.id);
});

test("batch item degraded success keeps outputs and warning summary", async () => {
  const { repository, jobItem } = await createBatchJobContext();

  const result = await applyBatchItemEvent({
    contentJobsRepository: repository,
    event: {
      jobItemId: jobItem.id,
      status: "succeeded",
      outputs: [
        {
          outputType: "marketing_copy",
          outputData: {
            title: "夏季清爽防晒喷雾",
          },
        },
      ],
      usage: {
        estimatedTokens: 180,
        estimatedCost: 0.05,
      },
      riskStatus: "degraded",
      warnings: [
        {
          stage: "image_asset",
          code: "IMAGE_ASSET_FAILED",
          message: "等待模型结果超时",
        },
      ],
    },
  });

  assert.equal(result.jobItem.status, "success");
  assert.equal(result.jobItem.resultSummary.riskStatus, "degraded");
  assert.equal(result.jobItem.resultSummary.warnings.length, 1);
  assert.equal(result.outputs.length, 1);
});

test("batch item failed event marks item failed without outputs", async () => {
  const { repository, jobItem } = await createBatchJobContext();

  const result = await applyBatchItemEvent({
    contentJobsRepository: repository,
    event: {
      jobItemId: jobItem.id,
      status: "failed",
      errorCode: "BATCH_ITEM_FAILED",
      errorMessage: "provider timeout",
    },
  });

  assert.equal(result.jobItem.status, "failed");
  assert.equal(result.jobItem.resultSummary.errorCode, "BATCH_ITEM_FAILED");
  assert.equal(result.job.status, "failed");

  const jobOutputs = await repository.listOutputsByJobId(jobItem.jobId);
  assert.equal(jobOutputs.length, 0);
});

test("replayed terminal event is idempotent and does not duplicate outputs", async () => {
  const { repository, jobItem } = await createBatchJobContext();
  const event = {
    jobItemId: jobItem.id,
    status: "succeeded",
    outputs: [
      {
        outputType: "marketing_copy",
        outputData: { title: "夏季清爽防晒喷雾" },
      },
    ],
  };

  const first = await applyBatchItemEvent({
    contentJobsRepository: repository,
    event,
  });
  const second = await applyBatchItemEvent({
    contentJobsRepository: repository,
    event,
  });

  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(second.outputs.length, 0);
  assert.equal((await repository.listOutputsByJobId(jobItem.jobId)).length, 1);
});
