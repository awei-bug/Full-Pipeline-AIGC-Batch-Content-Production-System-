import assert from "node:assert/strict";
import test from "node:test";

import {
  createPendingOrderSweeper,
  resolvePendingOrderTimeoutMs,
} from "./pending-order-sweeper.js";

test("resolvePendingOrderTimeoutMs defaults to 30 minutes", () => {
  assert.equal(resolvePendingOrderTimeoutMs({}), 30 * 60 * 1000);
  assert.equal(resolvePendingOrderTimeoutMs({ PENDING_ORDER_TIMEOUT_MINUTES: "15" }), 15 * 60 * 1000);
});

test("pending order sweeper cancels expired orders", async () => {
  const calls = [];
  const repository = {
    async cancelExpiredPendingOrders(input) {
      calls.push(input);
      return [{ id: "order_1", status: "cancelled" }];
    },
  };
  const logs = [];
  const sweeper = createPendingOrderSweeper({
    repository,
    olderThanMs: 1000,
    intervalMs: 60_000,
    logger: { info: (msg) => logs.push(msg), warn: () => {} },
  });

  const result = await sweeper.tick();
  assert.equal(result.length, 1);
  assert.deepEqual(calls[0], { olderThanMs: 1000 });
  assert.match(logs[0], /cancelled 1/);
});
