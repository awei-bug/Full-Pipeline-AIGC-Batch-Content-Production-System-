import assert from "node:assert/strict";
import test from "node:test";

import {
  CONSUMER_NAME,
  DRAFT_MARKER,
  buildDraft,
  consumeOnce,
  mergeDraftIntoHubItem,
  pushDraftToHub,
  resolveDraftConsumerConfig,
} from "./inventory-draft-consumer.js";

function memoryRepository() {
  const drafts = [];
  const statuses = new Map();
  const seen = new Set();
  let watermark = 0;
  return {
    drafts,
    statuses,
    async getWatermark() {
      return watermark;
    },
    async setWatermark(_consumer, value) {
      watermark = value;
    },
    async insertDraft(draft) {
      if (seen.has(draft.eventId)) return { inserted: false, id: null };
      seen.add(draft.eventId);
      drafts.push(draft);
      return { inserted: true, id: drafts.length };
    },
    async markHubStatus(id, status) {
      statuses.set(id, status);
    },
    get lastEventId() {
      return watermark;
    },
  };
}

function stubFetch(events) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          status: 200,
          data: { events, next_cursor: events.at(-1)?.id ?? 0, has_more: false },
        };
      },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const ENV = {
  EVENTS_URL: "http://127.0.0.1:5000/api/events",
  EVENTS_TOKEN: "token",
  INVENTORY_LOW_STOCK_THRESHOLD: "10",
};

test("缺少事件配置时不启用，且不发起请求", async () => {
  const config = resolveDraftConsumerConfig({ EVENTS_URL: "http://x", EVENTS_TOKEN: "" });
  assert.equal(config.enabled, false);

  let called = false;
  const result = await consumeOnce({
    env: { EVENTS_URL: "http://x" },
    repository: memoryRepository(),
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({ data: { events: [] } }) };
    },
    logger: { log() {} },
  });
  assert.equal(result.enabled, false);
  assert.equal(called, false);
});

test("库存高于阈值不生成草稿，只推进水位", async () => {
  const repo = memoryRepository();
  const fetchImpl = stubFetch([
    { id: 3, tenant_id: 1, event_type: "stock.changed", payload: JSON.stringify({ product_id: 1, stock_after: 40, item_title: "榨汁杯" }) },
  ]);

  const result = await consumeOnce({ env: ENV, repository: repo, fetchImpl, logger: { log() {} } });

  assert.equal(result.created, 0);
  assert.equal(result.skipped, 1);
  assert.equal(repo.drafts.length, 0);
  assert.equal(repo.lastEventId, 3);
});

test("低库存与缺货生成不同口径草稿，并带幂等键", async () => {
  const repo = memoryRepository();
  const fetchImpl = stubFetch([
    { id: 5, tenant_id: 1, event_type: "stock.changed", payload: JSON.stringify({ product_id: 1, stock_after: 3, item_title: "榨汁杯" }) },
    { id: 6, tenant_id: 1, event_type: "stock.changed", payload: JSON.stringify({ product_id: 2, stock_after: 0, item_title: "蓝牙耳机" }) },
    { id: 7, tenant_id: 1, event_type: "order.created", payload: "{}" },
  ]);

  const result = await consumeOnce({ env: ENV, repository: repo, fetchImpl, logger: { log() {} } });

  assert.equal(result.created, 2);
  assert.equal(result.skipped, 1);
  assert.equal(repo.drafts[0].kind, "low_stock");
  assert.match(repo.drafts[0].body, /仅剩 3 件/);
  assert.equal(repo.drafts[1].kind, "out_of_stock");
  assert.equal(repo.drafts[0].eventId, 5);
  assert.equal(repo.lastEventId, 7);
});

test("同一事件重复消费只落一行", async () => {
  const repo = memoryRepository();
  const event = { id: 9, tenant_id: 1, event_type: "stock.changed", payload: JSON.stringify({ product_id: 1, stock_after: 2, item_title: "榨汁杯" }) };

  await consumeOnce({ env: ENV, repository: repo, fetchImpl: stubFetch([event]), logger: { log() {} } });
  await consumeOnce({ env: ENV, repository: repo, fetchImpl: stubFetch([event]), logger: { log() {} } });

  assert.equal(repo.drafts.length, 1);
});

test("第二次消费从水位之后拉取", async () => {
  const repo = memoryRepository();
  const first = stubFetch([{ id: 11, tenant_id: 1, event_type: "order.created", payload: "{}" }]);
  await consumeOnce({ env: ENV, repository: repo, fetchImpl: first, logger: { log() {} } });

  const second = stubFetch([]);
  await consumeOnce({ env: ENV, repository: repo, fetchImpl: second, logger: { log() {} } });

  assert.match(second.calls[0], /after=11/);
});

test("消费者名固定，水位表不会被别的进程覆盖", () => {
  assert.equal(CONSUMER_NAME, "yungou-stock");
});

test("草稿带上数据中心商品标识", () => {
  const draft = buildDraft(
    {
      id: 12,
      tenant_id: 1,
      event_type: "stock.changed",
      payload: JSON.stringify({
        product_id: 1,
        stock_after: 4,
        item_title: "榨汁杯",
        external_id: "yg-1-1",
      }),
    },
    { threshold: 10 },
  );
  assert.equal(draft.externalId, "yg-1-1");
});

test("合并草稿只改运营提示与库存卖点，其余字段原样保留", () => {
  const record = {
    external_id: "yg-1-1",
    title: "榨汁杯",
    price: 129,
    stock: 4,
    images: ["http://img/1.png"],
    desc_zh: `原描述 ${DRAFT_MARKER}旧的提示，应当被替换`,
    selling_points: ["380ml 容量", "库存提示：当前仅剩 9 件"],
    status: "approved",
  };
  const merged = mergeDraftIntoHubItem(record, {
    eventId: 13,
    stockAfter: 4,
    body: "仅剩 4 件，建议改为预约口径。",
  });

  assert.equal(merged.price, 129);
  assert.deepEqual(merged.images, ["http://img/1.png"]);
  assert.equal(merged.status, "approved");
  assert.equal(merged.preserve_generated_copy, true);
  assert.ok(merged.desc_zh.startsWith("原描述"));
  assert.equal(merged.desc_zh.split(DRAFT_MARKER).length, 2, "旧提示必须被替换而不是叠加");
  assert.match(merged.desc_zh, /仅剩 4 件/);
  assert.deepEqual(merged.selling_points, ["380ml 容量", "库存提示：当前仅剩 4 件"]);
});

test("有标识时把草稿回推数据中心", async () => {
  const calls = [];
  const hubClient = {
    async get({ externalId }) {
      calls.push(["get", externalId]);
      return { external_id: externalId, title: "榨汁杯", desc_zh: "原描述", selling_points: [] };
    },
    async ingest({ items, jobId, source }) {
      calls.push(["ingest", jobId, source, items[0].desc_zh]);
      return { ok: true };
    },
  };

  const outcome = await pushDraftToHub({
    draft: { externalId: "yg-1-1", eventId: 21, stockAfter: 2, body: "仅剩 2 件" },
    hubClient,
    logger: { log() {} },
  });

  assert.equal(outcome.status, "pushed");
  assert.deepEqual(calls[0], ["get", "yg-1-1"]);
  assert.equal(calls[1][2], "inventory_alert");
  assert.match(calls[1][3], /仅剩 2 件/);
});

test("没有标识时草稿留在本地，不发任何请求", async () => {
  let called = false;
  const outcome = await pushDraftToHub({
    draft: { externalId: null, eventId: 22, stockAfter: 0, body: "缺货" },
    hubClient: {
      async get() {
        called = true;
        return null;
      },
      async ingest() {
        called = true;
      },
    },
    logger: { log() {} },
  });

  assert.equal(outcome.status, "pending_mapping");
  assert.equal(called, false);
});

test("回推成功后记录 hub_status，失败不丢草稿", async () => {
  const repo = memoryRepository();
  const event = {
    id: 30,
    tenant_id: 1,
    event_type: "stock.changed",
    payload: JSON.stringify({ product_id: 1, stock_after: 1, item_title: "榨汁杯", external_id: "yg-1-1" }),
  };
  const hubClient = {
    async get() {
      return { external_id: "yg-1-1", title: "榨汁杯", desc_zh: "", selling_points: [] };
    },
    async ingest() {
      throw new Error("数据中心 500");
    },
  };

  const result = await consumeOnce({ env: ENV, repository: repo, hubClient, fetchImpl: stubFetch([event]), logger: { log() {}, error() {} } });

  assert.equal(result.created, 1);
  assert.equal(result.pushed, 0);
  assert.equal(repo.drafts.length, 1, "回推失败不能丢草稿");
  assert.equal(repo.statuses.get(1), "push_failed");
});
