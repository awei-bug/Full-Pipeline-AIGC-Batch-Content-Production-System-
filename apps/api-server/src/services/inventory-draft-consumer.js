/**
 * 库存事件 → 补货文案草稿 消费器。
 *
 * 数据源：云购 `GET /api/events`（内网增量事件端点）。
 * 只处理 `stock.changed`，且库存低于阈值时才生成草稿；其余事件只推进水位。
 *
 * 三条约束与跨境订单消费器保持一致：
 * 1. fail-closed：EVENTS_URL / EVENTS_TOKEN 缺一不启用，不出现"空配置即全开放"。
 * 2. 幂等：以云购事件自增 id 作幂等键，重复投递由唯一约束吞掉。
 * 3. 水位只在事件处理完成后再推进，中途失败下一轮自动重投。
 */

export const CONSUMER_NAME = "yungou-stock";
const DEFAULT_THRESHOLD = 10;
const DEFAULT_POLL_SECONDS = 30;
const FETCH_LIMIT = 100;

function toInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function resolveDraftConsumerConfig(env = process.env) {
  const eventsUrl = String(env.EVENTS_URL || "").trim();
  const eventsToken = String(env.EVENTS_TOKEN || "").trim();
  const rawThreshold = env.INVENTORY_LOW_STOCK_THRESHOLD;
  const threshold = rawThreshold === undefined || rawThreshold === ""
    ? DEFAULT_THRESHOLD
    : toInt(rawThreshold, DEFAULT_THRESHOLD);
  const rawInterval = env.EVENTS_POLL_INTERVAL_SECONDS;

  return {
    eventsUrl,
    eventsToken,
    threshold: Math.max(threshold, 0),
    pollIntervalMs:
      Math.max(toInt(rawInterval, DEFAULT_POLL_SECONDS) || DEFAULT_POLL_SECONDS, 2) * 1000,
    // 缺任一项即视为未配置：宁可不出草稿，也不猜一个数据源。
    enabled: Boolean(eventsUrl && eventsToken),
  };
}

function parsePayload(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 把一条库存事件折叠成草稿内容。库存高于阈值返回 null（无需草稿）。
 * 文案是确定性模板，不调用大模型：草稿的价值在于"事件驱动 + 可追溯"，
 * 而不是文采；接生成模型只需替换这一个函数。
 */
export function buildDraft(event, { threshold = DEFAULT_THRESHOLD } = {}) {
  if (!event || event.event_type !== "stock.changed") return null;

  const payload = parsePayload(event.payload);
  const stockAfter = toInt(payload.stock_after, Number.NaN);
  if (!Number.isFinite(stockAfter)) return null;
  if (stockAfter > threshold) return null;

  const itemTitle = String(payload.item_title || "").trim() || `商品 ${payload.product_id ?? ""}`.trim();
  const productId = String(payload.product_id ?? "").trim();
  if (!productId) return null;

  const kind = stockAfter <= 0 ? "out_of_stock" : "low_stock";
  const title = kind === "out_of_stock"
    ? `「${itemTitle}」缺货应对文案｜草稿`
    : `「${itemTitle}」补货提醒文案｜草稿`;
  const body = kind === "out_of_stock"
    ? `「${itemTitle}」当前库存为 0（阈值 ${threshold}）。建议改为到货提醒口径，暂停"现货速发"表述，并给出预计补货时间让顾客可预约。`
    : `「${itemTitle}」当前仅剩 ${stockAfter} 件（阈值 ${threshold}）。建议突出"库存有限"，避免承诺大批量现货，同时准备补货到仓后的第二版文案。`;

  return {
    tenantId: String(event.tenant_id ?? ""),
    eventId: toInt(event.id),
    productId,
    skuId: payload.sku_id == null ? null : String(payload.sku_id),
    externalId: payload.external_id ? String(payload.external_id) : null,
    itemTitle,
    stockAfter,
    threshold,
    kind,
    title,
    body,
    source: "yungou.stock.changed",
  };
}

/** 早期版本把运营提示拼在 desc_zh 尾部，回写时用于剥除历史遗留。 */
export const DRAFT_MARKER = "【运营提示】";
const LEGACY_STOCK_POINT_PREFIX = "库存提示：";

/**
 * 把草稿合并进数据中心返回的商品记录。
 *
 * 运营提示写进独立的 ops_note 字段，不再进入 desc_zh / selling_points：
 * 那两个字段会同步到商城 C 端商品详情与卖点，属于顾客可见内容。
 *
 * 数据中心 ingest 是整条覆盖语义，所以必须先读后写；只改 ops_note，
 * 并顺带剥掉早期版本留在 desc_zh / selling_points 里的历史文本（幂等）。
 */
export function mergeDraftIntoHubItem(record, draft) {
  const cleanDesc = String(record.desc_zh || "")
    .split(DRAFT_MARKER)[0]
    .trim()
    .slice(0, 4000);
  const points = (Array.isArray(record.selling_points) ? record.selling_points : [])
    .map((point) => String(point || "").trim())
    .filter((point) => point && !point.startsWith(LEGACY_STOCK_POINT_PREFIX));

  return {
    ...record,
    desc_zh: cleanDesc || null,
    selling_points: points.slice(-10),
    ops_note: `${DRAFT_MARKER}${draft.body}`.slice(0, 2000),
    // 标题/英文描述的生成内容不属于本次改动，交给数据中心保留。
    preserve_generated_copy: true,
    source_job_id: `inventory-draft:${draft.eventId}`,
  };
}

export async function pushDraftToHub({ draft, hubClient, logger = console } = {}) {
  if (!draft?.externalId) {
    return { status: "pending_mapping" };
  }
  if (!hubClient) {
    return { status: "hub_not_configured" };
  }
  const record = await hubClient.get({ externalId: draft.externalId });
  if (!record) {
    return { status: "hub_missing" };
  }
  await hubClient.ingest({
    items: [mergeDraftIntoHubItem(record, draft)],
    jobId: `inventory-draft:${draft.eventId}`,
    source: "inventory_alert",
  });
  logger.log?.(`[inventory-drafts] 草稿已回推数据中心 event=${draft.eventId} external=${draft.externalId}`);
  return { status: "pushed" };
}

async function fetchEvents({ config, after, fetchImpl }) {
  const url = new URL(config.eventsUrl);
  url.searchParams.set("after", String(after));
  url.searchParams.set("limit", String(FETCH_LIMIT));

  const response = await fetchImpl(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Events-Token": config.eventsToken,
    },
  });
  if (!response.ok) {
    const error = new Error(`云购事件端点返回 ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  const body = await response.json();
  return { events: body?.data?.events || [], nextCursor: body?.data?.next_cursor ?? after };
}

/**
 * 消费一轮。返回本轮统计，便于 worker 打印与验收脚本断言。
 */
export async function consumeOnce({
  env = process.env,
  repository,
  hubClient = null,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const config = resolveDraftConsumerConfig(env);
  if (!config.enabled) {
    return { enabled: false, fetched: 0, created: 0, skipped: 0, pushed: 0, watermark: 0 };
  }
  if (!repository) {
    throw new Error("库存草稿消费器缺少仓储");
  }

  const watermark = await repository.getWatermark(CONSUMER_NAME);
  const { events } = await fetchEvents({ config, after: watermark, fetchImpl });

  let created = 0;
  let skipped = 0;
  let pushed = 0;
  let cursor = watermark;

  for (const event of events) {
    const eventId = toInt(event.id);
    if (eventId <= cursor) continue;

    const tenantId = String(event.tenant_id ?? "");
    const draft = tenantId ? buildDraft(event, { threshold: config.threshold }) : null;
    if (!draft) {
      skipped += 1;
    } else {
      const result = await repository.insertDraft(draft);
      if (result.inserted) {
        created += 1;
        logger.log?.(`[inventory-drafts] 新增草稿 event=${eventId} product=${draft.productId} stock=${draft.stockAfter}`);
        // 回推失败不能让草稿丢失，也不能卡住水位：草稿已落库，状态单独记录。
        try {
          const outcome = await pushDraftToHub({ draft, hubClient, logger });
          await repository.markHubStatus?.(result.id, outcome.status);
          if (outcome.status === "pushed") pushed += 1;
        } catch (error) {
          logger.error?.(`[inventory-drafts] 回推失败 event=${eventId}：${error.message}`);
          await repository.markHubStatus?.(result.id, "push_failed");
        }
      } else {
        skipped += 1;
      }
    }
    // 单条处理成功后才推进水位；insertDraft 抛错会中断循环，下一轮重投同一批。
    cursor = eventId;
  }

  if (cursor > watermark) {
    await repository.setWatermark(CONSUMER_NAME, cursor);
  }

  return {
    enabled: true,
    fetched: events.length,
    created,
    skipped,
    pushed,
    watermark: cursor,
  };
}

/** worker 主循环：固定间隔拉取，单轮异常不退出进程。 */
export async function runLoop({ env = process.env, repository, hubClient = null, fetchImpl, logger = console } = {}) {
  const config = resolveDraftConsumerConfig(env);
  if (!config.enabled) {
    logger.log?.("[inventory-drafts] 未配置 EVENTS_URL / EVENTS_TOKEN，消费器不启动");
    return;
  }
  logger.log?.(`[inventory-drafts] 启动，阈值 ${config.threshold}，间隔 ${config.pollIntervalMs}ms`);

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (!stopping) {
    try {
      await consumeOnce({ env, repository, hubClient, fetchImpl, logger });
    } catch (error) {
      logger.error?.(`[inventory-drafts] 本轮失败：${error.message}`);
    }
    if (stopping) break;
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
  logger.log?.("[inventory-drafts] 已停止");
}
