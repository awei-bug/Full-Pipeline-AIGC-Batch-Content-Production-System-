import assert from "node:assert/strict";
import test from "node:test";

import {
  CONSUMER_NAME,
  buildDraft,
  consumeOnce,
  resolveDraftConsumerConfig,
} from "./inventory-draft-consumer.js";

function memoryRepository() {
  const drafts = [];
  const seen = new Set();
  let watermark = 0;
  return {
    drafts,
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
