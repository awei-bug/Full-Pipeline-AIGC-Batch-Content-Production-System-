// 库存事件消费 worker。
//
// 由统一电商工作台拉起，与 api-server 共用同一个 PostgreSQL 与事件配置。
// 单独进程而不是放进 api-server 的启动流程：消费进度与 API 可用性解耦，
// 重启 API 不会重置水位，消费失败也不会拖垮页面。
import { createPool } from "../src/lib/database.js";
import { createDataHubClient } from "../src/lib/data-hub-client.js";
import { createInventoryDraftsRepository } from "../src/repositories/inventory-drafts-repository.js";
import { runLoop } from "../src/services/inventory-draft-consumer.js";

const pool = createPool();
if (!pool) {
  console.error("[inventory-drafts] 未配置数据库，退出");
  process.exit(1);
}

const repository = createInventoryDraftsRepository(pool);
// 未配置数据中心时草稿只留在本地（hub_status=pending_push），不阻断消费。
const hubClient = createDataHubClient(process.env);
try {
  await repository.ensure();
  await runLoop({ repository, hubClient });
} catch (error) {
  console.error(`[inventory-drafts] 启动失败：${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
