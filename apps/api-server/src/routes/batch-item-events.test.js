import assert from "node:assert/strict";
import express from "express";
import test from "node:test";

import { batchItemEventsRouter } from "./batch-item-events.js";
import { MemoryContentJobsRepository } from "../repositories/content-jobs-repository.js";
import { MemoryImportBatchesRepository } from "../repositories/import-batches-repository.js";
import { MemoryProductsRepository } from "../repositories/products-repository.js";

async function createContext() {
  const importBatchesRepository = new MemoryImportBatchesRepository();
  const batch = await importBatchesRepository.createImportBatch({
    fileName: "products.csv",
    fieldMapping: { name: "title" },
  });
  const productsRepository = new MemoryProductsRepository(importBatchesRepository);
  const [product] = await importBatchesRepository.createProducts([
    {
      batchId: batch.id,
      sourceRowNo: 1,
      originalData: { title: "防晒喷雾" },
      normalizedData: { name: "防晒喷雾", sellingPoint: "清爽不油腻" },
    },
  ]);
  const repository = new MemoryContentJobsRepository(productsRepository);
  const job = await repository.createJob({
    batchId: batch.id,
    contentTypes: ["marketing_copy"],
  });
  const [jobItem] = await repository.createJobItems([
    { jobId: job.id, productId: product.id, status: "pending" },
  ]);

  return { repository, jobItem };
}

async function withRouter({ repository, dataHubSyncService }, run) {
  const app = express();
  app.use(express.json());
  app.locals.contentJobsRepository = repository;
  app.locals.dataHubSyncService = dataHubSyncService;
  app.use("/internal/batch-items/events", batchItemEventsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function postEvent(baseUrl, event) {
  const response = await fetch(`${baseUrl}/internal/batch-items/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  return { response, body: await response.json() };
}

test("terminal batch event automatically ingests completed job content", async () => {
  const { repository, jobItem } = await createContext();
  const ingestedJobIds = [];

  await withRouter(
    {
      repository,
      dataHubSyncService: {
        async ingestJobContent({ jobId }) {
          ingestedJobIds.push(jobId);
        },
      },
    },
    async (baseUrl) => {
      const result = await postEvent(baseUrl, {
        jobItemId: jobItem.id,
        status: "succeeded",
        outputs: [{ outputType: "marketing_copy", outputData: { title: "清爽防晒" } }],
      });

      assert.equal(result.response.status, 200);
      assert.deepEqual(ingestedJobIds, [jobItem.jobId]);
      assert.equal(result.body.data.dataHubSync.status, "success");
    },
  );
});

test("data hub failure does not turn a persisted callback into an HTTP failure", async () => {
  const { repository, jobItem } = await createContext();

  await withRouter(
    {
      repository,
      dataHubSyncService: {
        async ingestJobContent() {
          throw new Error("data hub unavailable");
        },
      },
    },
    async (baseUrl) => {
      const result = await postEvent(baseUrl, {
        jobItemId: jobItem.id,
        status: "succeeded",
        outputs: [{ outputType: "marketing_copy", outputData: { title: "清爽防晒" } }],
      });

      assert.equal(result.response.status, 200);
      assert.equal(result.body.code, "SUCCESS");
      assert.equal(result.body.data.jobItem.status, "success");
      assert.equal(result.body.data.dataHubSync.status, "failed");
      assert.equal(result.body.data.dataHubSync.message, "data hub unavailable");
    },
  );
});
