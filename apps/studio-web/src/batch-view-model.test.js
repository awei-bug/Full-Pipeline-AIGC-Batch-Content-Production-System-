import test from "node:test";
import assert from "node:assert/strict";

import { deriveBatchWorkspaceView } from "./batch-view-model.js";

test("工作台在无数据时返回中文空状态和默认步骤", () => {
  const view = deriveBatchWorkspaceView({
    batches: [],
    products: [],
    jobs: [],
    outputs: [],
  });

  assert.equal(view.batchCount, 0);
  assert.equal(view.jobCount, 0);
  assert.equal(view.outputCount, 0);
  assert.equal(view.empty, true);
  assert.equal(view.emptyMessage, "先导入商品数据，再创建批量内容任务。");
  assert.equal(view.steps.length, 3);
  assert.equal(view.steps[0].title, "导入商品数据");
  assert.equal(view.steps[0].statusLabel, "当前步骤");
  assert.equal(view.overviewCards[0].label, "导入批次");
  assert.equal(view.resultSection.state, "empty");
  assert.equal(view.resultSection.title, "等待生成结果");
});

test("工作台会生成当前批次的商品表格、任务摘要和顶部指标", () => {
  const view = deriveBatchWorkspaceView({
    batches: [
      {
        id: "ib_001",
        fileName: "夏季防晒商品.csv",
        productCount: 2,
        createdAt: "2026-06-18T09:00:00.000Z",
      },
    ],
    products: [
      {
        id: "product_001",
        batchId: "ib_001",
        name: "防晒喷雾",
        sellingPoint: "清爽不黏腻",
        price: "89",
        category: "个护美妆",
        audience: "都市白领",
        scenario: "通勤补喷",
      },
      {
        id: "product_002",
        batchId: "ib_001",
        name: "修护面膜",
        sellingPoint: "夜间补水修护",
        price: "129",
        category: "护肤",
        audience: "25-35岁女性",
        scenario: "居家夜间护理",
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
  assert.equal(view.activeBatch.title, "夏季防晒商品.csv");
  assert.equal(view.activeBatch.subtitle, "共 2 条商品，已导入工作台");
  assert.equal(view.activeProducts.length, 2);
  assert.deepEqual(view.productTable.columns, [
    "商品名称",
    "核心卖点",
    "价格",
    "分类",
    "目标人群",
    "使用场景",
  ]);
  assert.equal(view.productTable.rows[0].cells[0], "防晒喷雾");
  assert.equal(view.productTable.rows[0].cells[1], "清爽不黏腻");
  assert.equal(view.productTable.rows[0].cells[2], "89");
  assert.equal(view.jobTable.rows[0].statusLabel, "部分完成");
  assert.equal(view.jobTable.rows[0].statusTone, "warning");
  assert.equal(view.jobTable.rows[0].progressText, "100%");
  assert.equal(view.jobTable.rows[0].contentTypeText, "营销文案、视频脚本、海报提示词");
  assert.equal(view.overviewCards[1].value, "1");
  assert.equal(view.overviewCards[2].value, "100%");
});

test("工作台会把结果卡片转换成中文标签并区分模型生成和系统兜底", () => {
  const view = deriveBatchWorkspaceView({
    batches: [{ id: "ib_001", fileName: "夏季防晒商品.csv", productCount: 1 }],
    products: [{ id: "product_001", batchId: "ib_001", name: "防晒喷雾" }],
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
          title: "通勤防晒喷雾主文案",
          body: "早八通勤也能随手补喷，持妆不泛白。",
          generationMeta: {
            source: "agnes",
            fallbackUsed: false,
            model: "agnes-2.0-flash",
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
            "开场展示喷雾外观和使用动作，中段强调清爽不黏和通勤补喷场景，结尾加上下单引导和限时福利说明。",
          generationMeta: {
            source: "fallback",
            fallbackUsed: true,
            reason: "invalid_json_response",
            model: "agnes-2.0-flash",
          },
        },
      },
      {
        id: "output_003",
        jobItemId: "item_001",
        outputType: "image_asset",
        createdAt: "2026-06-18T09:14:00.000Z",
        outputData: {
          prompt: "都市通勤风格防晒喷雾海报",
          generationMeta: {
            source: "agnes",
            fallbackUsed: false,
            model: "agnes-image-2.1-flash",
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
  assert.deepEqual(
    view.resultSection.filters.map((item) => [item.key, item.count]),
    [
      ["all", 3],
      ["marketing_copy", 1],
      ["video_script", 1],
      ["image_asset", 1],
    ],
  );
  assert.equal(view.resultSection.cards.length, 3);
  assert.equal(view.resultSection.cards[0].typeLabel, "营销文案");
  assert.equal(view.resultSection.cards[0].sourceLabel, "模型生成");
  assert.equal(view.resultSection.cards[0].sourceTone, "model");
  assert.equal(view.resultSection.cards[0].showExpand, false);
  assert.equal(view.resultSection.cards[1].typeLabel, "视频脚本");
  assert.equal(view.resultSection.cards[1].sourceLabel, "系统兜底");
  assert.equal(view.resultSection.cards[1].sourceTone, "fallback");
  assert.equal(
    view.resultSection.cards[1].reasonLabel,
    "模型返回格式异常，系统已自动切换为兜底内容。",
  );
  assert.equal(view.resultSection.cards[1].showExpand, true);
  assert.equal(view.resultSection.cards[2].typeLabel, "效果图片");
  assert.equal(view.resultSection.cards[2].imageUrl, "/storage/assets/poster-001.png");
});

test("工作台会在任务执行中返回生成中提示和筛选后的结果列表", () => {
  const view = deriveBatchWorkspaceView({
    batches: [{ id: "ib_001", fileName: "夏季防晒商品.csv", productCount: 1 }],
    products: [{ id: "product_001", batchId: "ib_001", name: "防晒喷雾" }],
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
            "第一秒抛出通勤补喷痛点，随后展示喷雾细腻肤感和妆面表现，最后给出清爽防晒的口播收尾。",
          generationMeta: {
            source: "agnes",
            fallbackUsed: false,
            model: "agnes-2.0-flash",
          },
        },
      },
    ],
    selectedBatchId: "ib_001",
    selectedResultType: "video_script",
    expandedResultIds: ["output_001"],
  });

  assert.equal(view.resultSection.state, "pending");
  assert.equal(view.resultSection.title, "图片正在生成中");
  assert.equal(
    view.resultSection.message,
    "任务已提交，系统正在继续生成剩余内容，请稍后刷新查看最终结果。",
  );
  assert.equal(view.resultSection.activeFilterKey, "video_script");
  assert.equal(view.resultSection.cards.length, 1);
  assert.equal(view.resultSection.cards[0].expanded, true);
  assert.equal(view.resultSection.cards[0].showExpand, true);
  assert.equal(view.resultSection.cards[0].copyText.includes("第一秒抛出通勤补喷痛点"), true);
});

test("image asset urls are resolved against api base url", () => {
  const view = deriveBatchWorkspaceView({
    batches: [{ id: "ib_001", fileName: "persist-demo-products.csv", productCount: 1 }],
    products: [{ id: "product_001", batchId: "ib_001", name: "防晒喷雾" }],
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
