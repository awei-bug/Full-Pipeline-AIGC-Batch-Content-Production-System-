import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

import {
  buildFieldMapping,
  parseCsvText,
  parseImportFile,
  sendChatMessage,
  startContentWorkflow,
} from "./batch-api.js";

test("parseImportFile 可以解析 csv 文件为表头和产品行", async () => {
  const file = new File(
    [
      "产品名称,核心卖点,报价/MOQ\n不锈钢水杯,食品级材质,FOB $2.8\n工业连接器,高防护等级,FOB $1.2",
    ],
    "export-products.csv",
    { type: "text/csv" },
  );

  const result = await parseImportFile(file);

  assert.equal(result.fileName, "export-products.csv");
  assert.deepEqual(result.headers, ["产品名称", "核心卖点", "报价/MOQ"]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].产品名称, "不锈钢水杯");
});

test("parseImportFile 可以解析 xlsx 文件为表头和产品行", async () => {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet([
    { 产品名称: "不锈钢水杯", 核心卖点: "食品级材质", "报价/MOQ": "FOB $2.8" },
    { 产品名称: "工业连接器", 核心卖点: "高防护等级", "报价/MOQ": "FOB $1.2" },
  ]);
  XLSX.utils.book_append_sheet(workbook, worksheet, "产品表");
  const workbookBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const file = new File([workbookBuffer], "export-products.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  const result = await parseImportFile(file);

  assert.equal(result.fileName, "export-products.xlsx");
  assert.deepEqual(result.headers, ["产品名称", "核心卖点", "报价/MOQ"]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[1].核心卖点, "高防护等级");
});

test("parseCsvText 支持引号字段内逗号", () => {
  const result = parseCsvText(
    [
      "产品名称,核心卖点,报价/MOQ",
      '"不锈钢水杯","食品级材质，支持定制 Logo, 激光刻字","FOB $2.8 / MOQ 500"',
    ].join("\n"),
  );

  assert.equal(result.rows[0].产品名称, "不锈钢水杯");
  assert.equal(result.rows[0].核心卖点, "食品级材质，支持定制 Logo, 激光刻字");
  assert.equal(result.rows[0]["报价/MOQ"], "FOB $2.8 / MOQ 500");
});

test("buildFieldMapping 识别外贸字段且不复用同一列", () => {
  const mapping = buildFieldMapping([
    "产品名称",
    "核心卖点",
    "报价/MOQ",
    "品类",
    "目标市场",
    "应用场景",
  ]);

  assert.deepEqual(mapping, {
    name: "产品名称",
    sellingPoint: "核心卖点",
    price: "报价/MOQ",
    category: "品类",
    audience: "目标市场",
    scenario: "应用场景",
  });
});

test("buildFieldMapping 缺少名称字段时抛错", () => {
  assert.throws(
    () => buildFieldMapping(["核心卖点", "报价/MOQ"]),
    /产品名称|名称/,
  );
});

test("sendChatMessage 原样提交文案对话消息", async () => {
  const originalFetch = globalThis.fetch;
  let observedRequest;
  globalThis.fetch = async (url, options) => {
    observedRequest = { url, options };
    return new Response(JSON.stringify({
      code: "SUCCESS",
      data: {
        content: "主标题：通勤轻一点",
        model: "agnes-2.5-flash",
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const messages = [
      { role: "system", content: "你是宣传文案助手。" },
      { role: "user", content: "帮我宣传一款通勤杯。" },
    ];
    const result = await sendChatMessage(messages);

    assert.match(observedRequest.url, /\/api\/chat$/);
    assert.equal(observedRequest.options.method, "POST");
    assert.deepEqual(JSON.parse(observedRequest.options.body), { messages });
    assert.equal(result.content, "主标题：通勤轻一点");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("startContentWorkflow 原样提交最终确认文案", async () => {
  const originalFetch = globalThis.fetch;
  let observedPayload;
  globalThis.fetch = async (_url, options) => {
    observedPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({
      code: "SUCCESS",
      data: { id: "cw_test", status: "queued" },
    }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const payload = {
      brief: "帮我宣传一款通勤杯",
      approvedCopy: "主标题：通勤轻一点\n正文：轻便保温，陪你从早到晚。",
      copyModel: "agnes-2.5-flash",
      imageStyles: [{ id: "product-studio", label: "产品棚拍", prompt: "clean studio" }],
      videoStyles: [],
    };
    const result = await startContentWorkflow(payload);

    assert.deepEqual(observedPayload, payload);
    assert.equal(result.id, "cw_test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
