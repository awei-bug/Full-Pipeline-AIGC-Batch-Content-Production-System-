/**
 * 云购商家身份 ↔ 内容平台用户 的显式映射仓储。
 *
 * 为什么必须显式映射，且**默认不自动创建**
 * ------------------------------------
 * 云购的 `tenant_id` / `staff_id` 和内容平台的 `user_id` 是两套 id 空间，没有任何
 * 可靠的共同字段可以直接推导。任何「按名字猜」「按第一个员工猜」「把所有商家都当
 * `user_demo`」的做法，都会让 A 商家看到 B 商家的项目——这是本项目最不能出的问题。
 *
 * 因此映射只能由运维/管理员显式写入（见 `scripts/link-merchant-account.js`），
 * 每次写入记录 `created_by` 与 `note`，可审计；查询侧找不到映射就拒绝访问
 * （`identity.js` 返回 403 IDENTITY_NOT_MAPPED），**不会**顺手建一条。
 *
 * 表结构
 * -----
 * 幂等建表而不是放进 `infra/sql`：`infra/` 不属本轮可动范围，且既有
 * `users-repository.js` 的 `user_credentials` 已经采用同样的「按需幂等建表」策略，
 * 保持一致比多一个迁移文件更重要。表只增不改，不删任何数据。
 *
 * 映射的是「云购员工 → 内容平台用户」，项目内角色仍由既有 `project_members`
 * 决定——不给映射附加角色，避免出现「映射里写的角色」和「成员表里的角色」
 * 两份互相矛盾的事实。
 */

import crypto from "node:crypto";

function normalizeKey(value) {
  return String(value ?? "").trim();
}

function mapLinkRow(row) {
  return {
    id: row.id,
    merchantTenantId: row.merchant_tenant_id,
    merchantStaffId: row.merchant_staff_id,
    contentUserId: row.content_user_id,
    status: row.status,
    note: row.note || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertLinkInput({ merchantTenantId, merchantStaffId, contentUserId, createdBy }) {
  const tenantId = normalizeKey(merchantTenantId);
  const staffId = normalizeKey(merchantStaffId);
  const userId = normalizeKey(contentUserId);
  const actor = normalizeKey(createdBy);
  if (!tenantId || !staffId) throw Object.assign(new Error("缺少云购租户或员工 id"), { statusCode: 400 });
  if (!userId) throw Object.assign(new Error("缺少内容平台用户 id"), { statusCode: 400 });
  if (!actor) {
    // 审计字段是必填：没有「谁做的映射」，事后无法追责也无法判断是否被误配。
    throw Object.assign(new Error("缺少 createdBy（操作人），映射必须可审计"), { statusCode: 400 });
  }
  return { tenantId, staffId, userId, actor };
}

export class MemoryMerchantLinksRepository {
  constructor() {
    this.items = [];
    this.mode = "memory";
  }

  async findLink({ merchantTenantId, merchantStaffId } = {}) {
    const tenantId = normalizeKey(merchantTenantId);
    const staffId = normalizeKey(merchantStaffId);
    if (!tenantId || !staffId) return null;
    const found = this.items.find(
      (item) => item.merchantTenantId === tenantId
        && item.merchantStaffId === staffId
        && item.status === "active",
    );
    return found || null;
  }

  async link({ merchantTenantId, merchantStaffId, contentUserId, createdBy, note = null }) {
    const input = assertLinkInput({ merchantTenantId, merchantStaffId, contentUserId, createdBy });
    const existing = this.items.find(
      (item) => item.merchantTenantId === input.tenantId && item.merchantStaffId === input.staffId,
    );
    const now = new Date().toISOString();
    if (existing) {
      existing.contentUserId = input.userId;
      existing.status = "active";
      existing.note = note;
      existing.createdBy = input.actor;
      existing.updatedAt = now;
      return { ...existing };
    }
    const record = {
      id: `mlink_${crypto.randomUUID()}`,
      merchantTenantId: input.tenantId,
      merchantStaffId: input.staffId,
      contentUserId: input.userId,
      status: "active",
      note,
      createdBy: input.actor,
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(record);
    return { ...record };
  }

  async listLinks() {
    return this.items.map((item) => ({ ...item }));
  }
}

export class PostgresMerchantLinksRepository {
  constructor(pool) {
    this.pool = pool;
    this.mode = "postgres";
    this.ready = null;
  }

  async ensureTable() {
    if (!this.ready) {
      this.ready = this.pool.query(
        `create table if not exists content_platform.merchant_links (
           id text primary key,
           merchant_tenant_id text not null,
           merchant_staff_id text not null,
           content_user_id text not null references content_platform.users(id),
           status text not null default 'active',
           note text,
           created_by text not null,
           created_at timestamptz not null default now(),
           updated_at timestamptz not null default now(),
           unique (merchant_tenant_id, merchant_staff_id)
         )`,
      ).catch((error) => {
        // 建表失败（例如 users 表尚未初始化）时不要缓存这个失败，
        // 否则数据库修好后本进程仍然永远失败。
        this.ready = null;
        throw error;
      });
    }
    await this.ready;
  }

  async findLink({ merchantTenantId, merchantStaffId } = {}) {
    const tenantId = normalizeKey(merchantTenantId);
    const staffId = normalizeKey(merchantStaffId);
    if (!tenantId || !staffId) return null;
    await this.ensureTable();
    const result = await this.pool.query(
      `select id, merchant_tenant_id, merchant_staff_id, content_user_id,
              status, note, created_by, created_at, updated_at
         from content_platform.merchant_links
        where merchant_tenant_id = $1 and merchant_staff_id = $2 and status = 'active'
        limit 1`,
      [tenantId, staffId],
    );
    return result.rows[0] ? mapLinkRow(result.rows[0]) : null;
  }

  async link({ merchantTenantId, merchantStaffId, contentUserId, createdBy, note = null }) {
    const input = assertLinkInput({ merchantTenantId, merchantStaffId, contentUserId, createdBy });
    await this.ensureTable();
    const result = await this.pool.query(
      `insert into content_platform.merchant_links(
         id, merchant_tenant_id, merchant_staff_id, content_user_id, status, note, created_by
       )
       values ($1, $2, $3, $4, 'active', $5, $6)
       on conflict (merchant_tenant_id, merchant_staff_id)
       do update set content_user_id = excluded.content_user_id,
                     status = 'active',
                     note = excluded.note,
                     created_by = excluded.created_by,
                     updated_at = now()
       returning id, merchant_tenant_id, merchant_staff_id, content_user_id,
                 status, note, created_by, created_at, updated_at`,
      [
        `mlink_${crypto.randomUUID()}`,
        input.tenantId,
        input.staffId,
        input.userId,
        note,
        input.actor,
      ],
    );
    return mapLinkRow(result.rows[0]);
  }

  async listLinks() {
    await this.ensureTable();
    const result = await this.pool.query(
      `select id, merchant_tenant_id, merchant_staff_id, content_user_id,
              status, note, created_by, created_at, updated_at
         from content_platform.merchant_links
        order by created_at asc`,
    );
    return result.rows.map(mapLinkRow);
  }
}

export function createMerchantLinksRepository(pool) {
  return pool ? new PostgresMerchantLinksRepository(pool) : new MemoryMerchantLinksRepository();
}
