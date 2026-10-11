import assert from "node:assert/strict";
import test from "node:test";

import { createContentJobService } from "./content-job-service.js";

test("create content job expands products into job items", async () => {
  const repositoryCalls = [];
  const repository = {
    async createJob(input) {
      repositoryCalls.push({ type: "job", input });
      return { id: "job_001" };
    },
    async listProductsByBatchId(batchId) {
      repositoryCalls.push({ type: "products", batchId });
      return [
        { id: "p_001", name: "Item A", sellingPoint: "Point A" },
        { id: "p_002", name: "Item B", sellingPoint: "Point B" },
      ];
    },
    async createJobItems(items) {
      repositoryCalls.push({ type: "items", items });
      return [
        { id: "item_001", ...items[0] },
        { id: "item_002", ...items[1] },
      ];
    },
  };
  const orchestratorClient = {
    async submitBatchItem(item) {
      repositoryCalls.push({ type: "dispatch", item });
      return { status: "queued" };
    },
  };
  const service = createContentJobService({
    repository,
    orchestratorClient,
    concurrency: 1,
  });

  const result = await service.createJob({
    batchId: "ib_001",
    contentTypes: ["marketing_copy", "image_prompt"],
  });

  assert.equal(result.jobId, "job_001");
  assert.equal(result.itemCount, 2);
  assert.equal(result.dispatchErrorCount, 0);
  assert.deepEqual(
    repositoryCalls.filter((item) => item.type !== "dispatch"),
    [
      {
        type: "job",
        input: {
          batchId: "ib_001",
          contentTypes: ["marketing_copy", "image_prompt"],
        },
      },
      {
        type: "products",
        batchId: "ib_001",
      },
      {
        type: "items",
        items: [
          { jobId: "job_001", productId: "p_001", status: "pending" },
          { jobId: "job_001", productId: "p_002", status: "pending" },
        ],
      },
    ],
  );
  assert.deepEqual(
    repositoryCalls
      .filter((item) => item.type === "dispatch")
      .map((item) => item.item.jobItemId)
      .sort(),
    ["item_001", "item_002"],
  );
});

test("create content job rejects empty batch id", async () => {
  const repository = {
    async createJob() {
      throw new Error("should not be called");
    },
    async listProductsByBatchId() {
      throw new Error("should not be called");
    },
    async createJobItems() {
      throw new Error("should not be called");
    },
  };
  const service = createContentJobService({
    repository,
    orchestratorClient: { submitBatchItem: async () => {} },
  });

  await assert.rejects(
    () =>
      service.createJob({
        batchId: "",
        contentTypes: ["marketing_copy"],
      }),
    /batch id/i,
  );
});

test("create content job rejects empty content types", async () => {
  const service = createContentJobService({
    repository: {
      async createJob() {
        throw new Error("should not be called");
      },
      async listProductsByBatchId() {
        throw new Error("should not be called");
      },
      async createJobItems() {
        throw new Error("should not be called");
      },
    },
    orchestratorClient: { submitBatchItem: async () => {} },
  });

  await assert.rejects(
    () =>
      service.createJob({
        batchId: "ib_001",
        contentTypes: [],
      }),
    /content type/i,
  );
});

test("create content job isolates dispatch failures", async () => {
  const failedItems = [];
  const repository = {
    async createJob() {
      return { id: "job_001" };
    },
    async listProductsByBatchId() {
      return [
        { id: "p_001", name: "Item A" },
        { id: "p_002", name: "Item B" },
      ];
    },
    async createJobItems(items) {
      return [
        { id: "item_001", ...items[0] },
        { id: "item_002", ...items[1] },
      ];
    },
    async updateJobItemResult(input) {
      failedItems.push(input);
      return input;
    },
  };
  let callCount = 0;
  const service = createContentJobService({
    repository,
    orchestratorClient: {
      async submitBatchItem() {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("orchestrator down");
        }
        return { status: "queued" };
      },
    },
    concurrency: 1,
  });

  const result = await service.createJob({
    batchId: "ib_001",
    contentTypes: ["marketing_copy"],
  });

  assert.equal(result.itemCount, 2);
  assert.equal(result.dispatchErrorCount, 1);
  assert.equal(failedItems.length, 1);
  assert.equal(failedItems[0].status, "failed");
  assert.equal(failedItems[0].resultSummary.errorCode, "DISPATCH_FAILED");
});
