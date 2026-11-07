import assert from "node:assert/strict";
import test from "node:test";
import { createDataHubSyncService } from "./data-hub-sync-service.js";
import { createListingPackService } from "./listing-pack-service.js";
import { mkdtemp, unlink, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("partial job only sends successful products and reports skipped items", async () => {
  let sent;
  const repository = {
    getJobById: async () => ({ batchId: "batch" }),
    listExportRowsByJobId: async () => [{ productId: "a", productName: "成功" }, { productId: "b", productName: "失败" }],
    listJobItemsByJobId: async () => [{ id: "a1", productId: "a", status: "success" }, { id: "b1", productId: "b", status: "failed" }],
    listOutputsByJobId: async () => [],
    listProductsByBatchId: async () => [],
  };
  const client = { ingest: async ({ items }) => { sent = items; return { received: 1, ok_count: 1, error_count: 0 }; } };
  const result = await createDataHubSyncService({ repository, listingPackService: {}, dataHubClient: client }).ingestJobContent({ jobId: "job" });
  assert.deepEqual(sent.map((item) => item.external_id), ["cc-a"]);
  assert.equal(result.skipped[0].productId, "b");
});

test("generated listing title and body remain paired and source facts remain separate", async () => {
  let sent;
  const repository = {
    getJobById: async () => ({ batchId: "batch" }),
    listExportRowsByJobId: async () => [{ productId: "a", productName: "商品", marketingCopyTitle: "old title" }],
    listJobItemsByJobId: async () => [{ id: "item", productId: "a", status: "success" }],
    listOutputsByJobId: async () => [
      { id: "1", jobItemId: "item", outputType: "marketing_copy", createdAt: "2026-01-01", outputData: { title: "old title", body: "old body" } },
      { id: "2", jobItemId: "item", outputType: "marketing_copy", createdAt: new Date("2026-01-02"), outputData: { title: "New title", body: "Generated body", sellingPoints: ["unverified claim"] } },
    ],
    listProductsByBatchId: async () => [{ id: "a", normalizedData: { sellingPoint: "商家提供的卖点" } }],
  };
  const client = { ingest: async ({ items }) => { sent = items; return { received: 1, ok_count: 1, error_count: 0 }; } };
  await createDataHubSyncService({ repository, listingPackService: {}, dataHubClient: client }).ingestJobContent({ jobId: "job" });
  assert.equal(sent[0].title_en, "New title");
  assert.equal(sent[0].desc_en, "Generated body");
  assert.deepEqual(sent[0].selling_points, ["商家提供的卖点"]);
  repository.listOutputsByJobId = async () => [{ id: "3", jobItemId: "item", outputType: "marketing_copy", outputData: { title: "Title only" } }];
  await createDataHubSyncService({ repository, listingPackService: {}, dataHubClient: client }).ingestJobContent({ jobId: "job" });
  assert.equal(sent[0].desc_en, undefined);
});

test("listing pack includes generated body, not the title as description", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "listing-pack-test-"));
  try {
    await writeFile(path.join(dir, "image.png"), Buffer.from("test image"));
    const repository = {
      getJobById: async () => ({ batchId: "batch" }),
      listExportRowsByJobId: async () => [{ productId: "a", productName: "商品", marketingCopyTitle: "Title" }],
      listJobItemsByJobId: async () => [{ id: "item", productId: "a", status: "success" }],
      listOutputsByJobId: async () => [{ id: "1", jobItemId: "item", outputType: "marketing_copy", outputData: { title: "Title", body: "Actual description" } }, { id: "2", jobItemId: "item", outputType: "image_asset", outputData: { metadata: { publicUrl: "/storage/assets/image.png" } } }],
      listProductsByBatchId: async () => [{ id: "a", normalizedData: {} }],
    };
    const pack = await createListingPackService({ repository, assetsDir: dir }).buildPack({ jobId: "job" });
    assert.equal(pack.manifest.products[0].desc_en, "Actual description");
  } finally { await unlink(path.join(dir, "image.png")); await rmdir(dir); }
});
