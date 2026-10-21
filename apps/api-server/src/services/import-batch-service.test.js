import assert from "node:assert/strict";
import test from "node:test";

import { createImportBatchService } from "./import-batch-service.js";

test("create import batch persists batch metadata and product rows", async () => {
  const repositoryCalls = [];
  const repository = {
    async createImportBatch(input) {
      repositoryCalls.push({ type: "batch", input });
      return { id: "ib_001" };
    },
    async createProducts(rows) {
      repositoryCalls.push({ type: "products", rows });
      return rows;
    },
  };
  const service = createImportBatchService({ repository });

  const result = await service.createBatch({
    fileName: "products.csv",
    fieldMapping: { name: "title", price: "sale_price" },
    rows: [{ title: "Item A", sale_price: "99" }],
  });

  assert.equal(result.batchId, "ib_001");
  assert.equal(result.productCount, 1);
  assert.equal(result.projectId, null);
  assert.deepEqual(repositoryCalls, [
    {
      type: "batch",
      input: {
        fileName: "products.csv",
        fieldMapping: { name: "title", price: "sale_price" },
        // 未传 projectId 时显式记为 null（未分配），而不是省略字段——
        // 省略会让"没传"和"传了空"在后端难以区分。
        projectId: null,
      },
    },
    {
      type: "products",
      rows: [
        {
          batchId: "ib_001",
          sourceRowNo: 1,
          originalData: { title: "Item A", sale_price: "99" },
          normalizedData: {
            name: "Item A",
            price: "99",
          },
        },
      ],
    },
  ]);
});

test("create import batch rejects empty rows", async () => {
  const repository = {
    async createImportBatch() {
      throw new Error("should not be called");
    },
    async createProducts() {
      throw new Error("should not be called");
    },
  };
  const service = createImportBatchService({ repository });

  await assert.rejects(
    () =>
      service.createBatch({
        fileName: "products.csv",
        fieldMapping: { name: "title" },
        rows: [],
      }),
    /rows/i,
  );
});
