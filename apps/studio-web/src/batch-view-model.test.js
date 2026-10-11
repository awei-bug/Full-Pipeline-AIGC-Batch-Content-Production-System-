import test from "node:test";
import assert from "node:assert/strict";

import { deriveBatchWorkspaceView, shouldPollContentJob } from "./batch-view-model.js";

test("polls only active content jobs", () => {
  for (const status of ["created", "queued", "pending", "running"]) {
    assert.equal(shouldPollContentJob({ status }), true);
  }

  for (const status of ["success", "partial_success", "failed", "", undefined]) {
    assert.equal(shouldPollContentJob({ status }), false);
  }

  assert.equal(shouldPollContentJob(null), false);
});

test("workspace empty state", () => {
  const view = deriveBatchWorkspaceView({
    batches: [],
    products: [],
    jobs: [],
    outputs: [],
  });

  assert.equal(view.batchCount, 0);
  assert.equal(view.empty, true);
  assert.match(view.emptyMessage, /产品|商品/);
  assert.equal(view.steps.length, 3);
  assert.match(view.steps[0].title, /导入/);
  assert.equal(view.overviewCards[0].label, "导入批次");
  assert.equal(view.resultSection.state, "empty");
});

test("workspace product table", () => {
  const view = deriveBatchWorkspaceView({
    batches: [
      {
        id: "ib_001",
        fileName: "export-products.csv",
        productCount: 2,
        createdAt: "2026-06-18T09:00:00.000Z",
      },
    ],
    products: [
      {
        id: "product_001",
        batchId: "ib_001",
        name: "不锈钢水杯",
        sellingPoint: "食品级材质",
        price: "FOB $2.8",
        category: "日用百货",
        audience: "美国/欧洲",
        scenario: "礼品渠道",
      },
      {
        id: "product_002",
        batchId: "ib_001",
        name: "工业连接器",
        sellingPoint: "高防护等级",
        price: "FOB $1.2",
        category: "电子元器件",
        audience: "东南亚/中东",
        scenario: "工程采购",
      },
    ],
    jobs: [
      {
        id: "job_001",
        jobNo: "JOB_001",
        batchId: "ib_001",
        status: "partial_success",
        progress: 100,
        contentTypes: ["marketing_copy", "video_script", "image_prompt"],
        createdAt: "2026-06-18T09:10:00.000Z",
      },
    ],
    outputs: [],
    selectedBatchId: "ib_001",
  });

  assert.equal(view.empty, false);
  assert.equal(view.activeBatch.title, "export-products.csv");
  assert.match(view.activeBatch.subtitle, /2/);
  assert.equal(view.activeProducts.length, 2);
  assert.equal(view.productTable.rows[0].cells[0], "不锈钢水杯");
  assert.equal(view.productTable.rows[0].cells[1], "食品级材质");
  assert.equal(view.productTable.rows[0].cells[2], "FOB $2.8");
  assert.equal(view.jobTable.rows[0].statusLabel, "部分完成");
  assert.equal(view.jobTable.rows[0].statusTone, "warning");
  assert.equal(view.jobTable.rows[0].progressText, "100%");
  assert.match(view.jobTable.rows[0].contentTypeText, /Listing/);
  assert.equal(view.overviewCards[1].value, "1");
  assert.equal(view.overviewCards[2].value, "100%");
});

test("result cards labels", () => {
  const view = deriveBatchWorkspaceView({
    batches: [{ id: "ib_001", fileName: "export-products.csv", productCount: 1 }],
    products: [{ id: "product_001", batchId: "ib_001", name: "不锈钢水杯" }],
    jobs: [
      {
        id: "job_001",
        jobNo: "JOB_001",
        batchId: "ib_001",
        status: "success",
        progress: 100,
        contentTypes: ["marketing_copy", "video_script", "image_prompt"],
      },
    ],
    outputs: [
      {
        id: "output_001",
        jobItemId: "item_001",
        outputType: "marketing_copy",
        createdAt: "2026-06-18T09:12:00.000Z",
        outputData: {
          title: "Stainless Steel Water Bottle for US Buyers",
          body: "Food-grade material, logo customization supported.",
          generationMeta: {
            source: "agnes",
            fallbackUsed: false,
            model: "agnes-2.5-flash",
          },
        },
      },
      {
        id: "output_002",
        jobItemId: "item_001",
        outputType: "video_script",
        createdAt: "2026-06-18T09:13:00.000Z",
        outputData: {
          script:
            "Dear Buyer, we supply stainless steel water bottles with food-grade material and custom logo support. If you are sourcing now, I can send MOQ and FOB details.",
          generationMeta: {
            source: "fallback",
            fallbackUsed: true,
            reason: "invalid_json_response",
            model: "agnes-2.5-flash",
          },
        },
      },
      {
        id: "output_003",
        jobItemId: "item_001",
        outputType: "image_asset",
        createdAt: "2026-06-18T09:14:00.000Z",
        outputData: {
          prompt: "export catalog poster for stainless bottle",
          generationMeta: {
            source: "agnes",
            fallbackUsed: false,
            model: "agnes-image-2.5-flash",
          },
          metadata: {
            publicUrl: "/storage/assets/poster-001.png",
          },
        },
      },
    ],
    selectedBatchId: "ib_001",
    selectedResultType: "all",
    expandedResultIds: [],
  });

  assert.equal(view.resultSection.state, "ready");
  assert.equal(view.resultSection.previewImageUrl, "/storage/assets/poster-001.png");
  assert.equal(view.resultSection.cards.length, 3);
  assert.match(view.resultSection.cards[0].typeLabel, /Listing/);
  assert.equal(view.resultSection.cards[0].sourceTone, "model");
  assert.equal(view.resultSection.cards[1].sourceTone, "fallback");
  assert.equal(view.resultSection.cards[1].showExpand, true);
  assert.equal(view.resultSection.cards[2].imageUrl, "/storage/assets/poster-001.png");
});

test("pending generation state", () => {
  const view = deriveBatchWorkspaceView({
    batches: [{ id: "ib_001", fileName: "export-products.csv", productCount: 1 }],
    products: [{ id: "product_001", batchId: "ib_001", name: "不锈钢水杯" }],
    jobs: [
      {
        id: "job_001",
        batchId: "ib_001",
        status: "running",
        progress: 66,
        contentTypes: ["marketing_copy", "video_script", "image_prompt"],
      },
    ],
    outputs: [
      {
        id: "output_001",
        jobItemId: "item_001",
        outputType: "video_script",
        outputData: {
          script:
            "Dear Buyer, we can supply stainless steel water bottles with food-grade material and logo customization. Let me know if you need MOQ and FOB.",
          generationMeta: {
            source: "agnes",
            fallbackUsed: false,
            model: "agnes-2.5-flash",
          },
        },
      },
    ],
    selectedBatchId: "ib_001",
    selectedResultType: "video_script",
    expandedResultIds: ["output_001"],
  });

  assert.equal(view.resultSection.state, "pending");
  assert.equal(view.resultSection.activeFilterKey, "video_script");
  assert.equal(view.resultSection.cards.length, 1);
  assert.equal(view.resultSection.cards[0].expanded, true);
  assert.equal(view.resultSection.cards[0].copyText.includes("Dear Buyer"), true);
});

test("image asset urls are resolved against api base url", () => {
  const view = deriveBatchWorkspaceView({
    batches: [{ id: "ib_001", fileName: "export-products.csv", productCount: 1 }],
    products: [{ id: "product_001", batchId: "ib_001", name: "不锈钢水杯" }],
    jobs: [
      {
        id: "job_001",
        batchId: "ib_001",
        status: "success",
        progress: 100,
        contentTypes: ["image_prompt"],
      },
    ],
    outputs: [
      {
        id: "output_003",
        jobItemId: "item_001",
        outputType: "image_asset",
        outputData: {
          metadata: {
            publicUrl: "/storage/assets/poster-001.png",
          },
        },
      },
    ],
    selectedBatchId: "ib_001",
    apiBaseUrl: "http://127.0.0.1:3100",
  });

  assert.equal(
    view.resultSection.previewImageUrl,
    "http://127.0.0.1:3100/storage/assets/poster-001.png",
  );
  assert.equal(
    view.resultSection.cards[0].imageUrl,
    "http://127.0.0.1:3100/storage/assets/poster-001.png",
  );
});
