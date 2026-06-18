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
  const service = createContentJobService({ repository, orchestratorClient });

  const result = await service.createJob({
    batchId: "ib_001",
    contentTypes: ["marketing_copy", "image_prompt"],
  });

  assert.equal(result.jobId, "job_001");
  assert.equal(result.itemCount, 2);
  assert.deepEqual(repositoryCalls, [
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
    {
      type: "dispatch",
      item: {
        jobItemId: "item_001",
        jobId: "job_001",
        productId: "p_001",
        contentTypes: ["marketing_copy", "image_prompt"],
        productSnapshot: {
          id: "p_001",
          name: "Item A",
          sellingPoint: "Point A",
        },
      },
    },
    {
      type: "dispatch",
      item: {
        jobItemId: "item_002",
        jobId: "job_001",
        productId: "p_002",
        contentTypes: ["marketing_copy", "image_prompt"],
        productSnapshot: {
          id: "p_002",
          name: "Item B",
          sellingPoint: "Point B",
        },
      },
    },
  ]);
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
