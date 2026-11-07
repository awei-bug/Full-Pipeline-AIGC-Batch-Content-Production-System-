/**
 * 库存联动草稿仓储（PostgreSQL）。
 *
 * 链路：云购库存扣减 → stock.changed 事件 → 内容平台消费器生成补货/清货文案草稿。
 * 草稿必须可追溯、可重放：event_id 唯一约束保证同一事件的重复投递只落一行，
 * 水位表记录消费者读到的最大事件 id，重启后从断点继续。
 *
 * 建表采用「仓储层幂等 DDL」而不是改 infra/sql 基线，与 merchant-links-repository
 * 同一策略：不侵入既有 schema 版本，缺失时自行补齐。
 */

const DDL = [
  `CREATE TABLE IF NOT EXISTS inventory_content_drafts (
     id BIGSERIAL PRIMARY KEY,
     tenant_id TEXT NOT NULL,
     event_id BIGINT NOT NULL,
     product_id TEXT NOT NULL,
     sku_id TEXT,
     item_title TEXT NOT NULL,
     stock_after INTEGER NOT NULL,
     threshold INTEGER NOT NULL DEFAULT 0,
     kind TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'draft',
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     source TEXT NOT NULL DEFAULT 'yungou.stock.changed',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT uq_inventory_draft_event UNIQUE (event_id)
   )`,
  `CREATE INDEX IF NOT EXISTS ix_inventory_drafts_tenant
     ON inventory_content_drafts (tenant_id, id DESC)`,
  // 商品身份与回推状态。表已存在时 CREATE TABLE IF NOT EXISTS 不会补列，
  // 因此单独 ALTER：老库升级与新库初始化走同一条路径。
  `ALTER TABLE inventory_content_drafts ADD COLUMN IF NOT EXISTS external_id TEXT`,
  `ALTER TABLE inventory_content_drafts ADD COLUMN IF NOT EXISTS hub_status TEXT NOT NULL DEFAULT 'local'`,
  `ALTER TABLE inventory_content_drafts ADD COLUMN IF NOT EXISTS hub_pushed_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS inventory_draft_watermark (
     consumer TEXT PRIMARY KEY,
     last_event_id BIGINT NOT NULL DEFAULT 0,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

function toInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

export function createInventoryDraftsRepository(pool) {
  if (!pool) {
    return null;
  }

  let ready = null;

  function ensure() {
    if (!ready) {
      ready = (async () => {
        for (const statement of DDL) {
          await pool.query(statement);
        }
      })().catch((error) => {
        // 失败不缓存，下一次调用重试；否则一次瞬时故障会让整进程永久不可用。
        ready = null;
        throw error;
      });
    }
    return ready;
  }

  async function insertDraft(draft) {
    await ensure();
    const result = await pool.query(
      `INSERT INTO inventory_content_drafts
         (tenant_id, event_id, product_id, sku_id, item_title, stock_after,
          threshold, kind, title, body, source, external_id, hub_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id`,
      [
        String(draft.tenantId),
        toInt(draft.eventId),
        String(draft.productId),
        draft.skuId == null ? null : String(draft.skuId),
        String(draft.itemTitle),
        toInt(draft.stockAfter),
        toInt(draft.threshold),
        String(draft.kind),
        String(draft.title),
        String(draft.body),
        String(draft.source || "yungou.stock.changed"),
        draft.externalId == null ? null : String(draft.externalId),
        draft.externalId ? "pending_push" : "pending_mapping",
      ],
    );
    return {
      inserted: result.rowCount === 1,
      id: result.rows?.[0]?.id ?? null,
    };
  }

  async function listDrafts({ tenantId = null, limit = 50, status = "" } = {}) {
    await ensure();
    const params = [];
    const where = [];
    if (tenantId !== null && tenantId !== undefined && String(tenantId) !== "") {
      params.push(String(tenantId));
      where.push(`tenant_id = $${params.length}`);
    }
    if (status) {
      params.push(String(status));
      where.push(`status = $${params.length}`);
    }
    params.push(Math.min(Math.max(toInt(limit) || 50, 1), 200));
    const result = await pool.query(
      `SELECT id, tenant_id, event_id, product_id, sku_id, item_title, stock_after,
              threshold, kind, status, title, body, source, external_id,
              hub_status, hub_pushed_at, created_at
         FROM inventory_content_drafts
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY id DESC
        LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      tenantId: row.tenant_id,
      eventId: Number(row.event_id),
      productId: row.product_id,
      skuId: row.sku_id,
      itemTitle: row.item_title,
      stockAfter: Number(row.stock_after),
      threshold: Number(row.threshold),
      kind: row.kind,
      status: row.status,
      title: row.title,
      body: row.body,
      source: row.source,
      externalId: row.external_id,
      hubStatus: row.hub_status,
      hubPushedAt: row.hub_pushed_at instanceof Date ? row.hub_pushed_at.toISOString() : row.hub_pushed_at,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    }));
  }

  async function getWatermark(consumer) {
    await ensure();
    const result = await pool.query(
      "SELECT last_event_id FROM inventory_draft_watermark WHERE consumer = $1",
      [String(consumer)],
    );
    return result.rowCount === 0 ? 0 : toInt(result.rows[0].last_event_id);
  }

  async function setWatermark(consumer, lastEventId) {
    await ensure();
    await pool.query(
      `INSERT INTO inventory_draft_watermark (consumer, last_event_id, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (consumer) DO UPDATE
         SET last_event_id = EXCLUDED.last_event_id, updated_at = now()`,
      [String(consumer), toInt(lastEventId)],
    );
  }

  async function markHubStatus(id, hubStatus) {
    await ensure();
    await pool.query(
      `UPDATE inventory_content_drafts
          SET hub_status = $2,
              hub_pushed_at = CASE WHEN $2 = 'pushed' THEN now() ELSE hub_pushed_at END,
              updated_at = now()
        WHERE id = $1`,
      [toInt(id), String(hubStatus)],
    );
  }

  return {
    mode: "postgres",
    ensure,
    insertDraft,
    listDrafts,
    getWatermark,
    setWatermark,
    markHubStatus,
  };
}
