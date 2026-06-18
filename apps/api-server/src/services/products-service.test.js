import assert from "node:assert/strict";
import test from "node:test";

import { createProductsService } from "./products-service.js";

test("list products returns normalized product rows by batch id", async () => {
  const repository = {
    async listProductsByBatchId(batchId) {
      assert.equal(batchId, "ib_001");
      return [{ id: "p_001", name: "Item A", price: "99" }];
    },
  };
  const service = createProductsService({ repository });

  const result = await service.listByBatchId("ib_001");

  assert.deepEqual(result, [
    { id: "p_001", name: "Item A", price: "99" },
  ]);
});

test("list products rejects empty batch id", async () => {
  const repository = {
    async listProductsByBatchId() {
      throw new Error("should not be called");
    },
  };
  const service = createProductsService({ repository });

  await assert.rejects(() => service.listByBatchId(""), /batch id/i);
});
