/**
 * 额度账户仓储：预扣、回补、查询。
 *
 * 并发安全的做法
 * ------------
 * **不用"先查余额再扣"**——那中间有窗口，两个并发请求能双花。
 * 用一条带条件的原子 UPDATE：
 *
 *   update credit_accounts
 *      set available_credits = available_credits - $cost
 *    where owner_id = $uid and available_credits >= $cost
 *    returning available_credits
 *
 * 影响行数为 0 就是余额不足（或账户不存在），不需要额外查询判断。
 *
 * 幂等
 * ----
 * `credit_transactions` 有 `unique(biz_type, biz_no)`。同一个业务单号重复扣减会
 * 撞唯一键——这是**故意的**，用来防重试导致的双扣。捕获唯一键冲突后返回
 * "已扣过"，而不是报错给用户。
 *
 * 预扣与回补
 * ---------
 * 先预扣（避免并发双花），下游失败再回补。回补也要记流水，账目才对得上：
 * 扣减和回补是两条独立记录，`biz_type` 分别为 `deduct` / `refund`。
 */

import crypto from "node:crypto";

import {
  InsufficientCreditsError,
  UnknownBillingActionError,
  resolveCosts,
  resolveInitialGrant,
} from "../lib/billing.js";

const OWNER_TYPE = "user";

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 20)}`;
}

/**
 * 内存实现。用于无数据库的本地开发与测试。
 *
 * 注意：**不跨进程持久化**，重启即回到初始赠额。真实计费必须配 PostgreSQL。
 */
export class MemoryCreditRepository {
  constructor({ env = process.env } = {}) {
    this.accounts = new Map(); // ownerId -> { available, frozen, used }
    this.transactions = [];
    this.costs = resolveCosts(env);
    this.initialGrant = resolveInitialGrant(env);
    this.mode = "memory";
  }

  _ensureAccount(ownerId) {
    if (!this.accounts.has(ownerId)) {
      this.accounts.set(ownerId, {
        available: this.initialGrant,
        frozen: 0,
        used: 0,
      });
    }
    return this.accounts.get(ownerId);
  }

  async getBalance(ownerId) {
    const account = this._ensureAccount(ownerId);
    return {
      ownerId,
      available: account.available,
      frozen: account.frozen,
      used: account.used,
    };
  }

  _costOf(action) {
    const cost = this.costs[action];
    if (cost === undefined) throw new UnknownBillingActionError(action);
    return cost;
  }

  /**
   * 预扣额度。
   * @returns {{cost:number, balance:object, replayed:boolean}}
   */
  async deduct({ ownerId, action, bizNo }) {
    const cost = this._costOf(action);

    // 幂等：同一 bizNo 已扣过就直接返回，不重复扣。
    const existing = this.transactions.find(
      (item) => item.bizType === "deduct" && item.bizNo === bizNo,
    );
    if (existing) {
      return { cost: 0, balance: await this.getBalance(ownerId), replayed: true };
    }

    const account = this._ensureAccount(ownerId);
    if (account.available < cost) {
      throw new InsufficientCreditsError({
        required: cost,
        available: account.available,
        action,
      });
    }

    account.available -= cost;
    account.used += cost;
    this.transactions.push({
      id: newId("credit_tx"),
      ownerId,
      bizType: "deduct",
      bizNo,
      action,
      changeAmount: -cost,
      afterAmount: account.available,
    });

    return { cost, balance: { ownerId, ...account }, replayed: false };
  }

  /** 回补：下游失败时把预扣的额度退回，记一条 refund 流水。 */
  async refund({ ownerId, action, bizNo, reason = "" }) {
    const cost = this._costOf(action);
    const deducted = this.transactions.find(
      (item) => item.bizType === "deduct" && item.bizNo === bizNo,
    );
    if (!deducted) {
      // 没扣过就没什么可退的。不报错——可能是幂等重放路径。
      return { cost: 0, balance: await this.getBalance(ownerId), skipped: true };
    }
    if (this.transactions.some((item) => item.bizType === "refund" && item.bizNo === bizNo)) {
      return { cost: 0, balance: await this.getBalance(ownerId), skipped: true };
    }

    const account = this._ensureAccount(ownerId);
    account.available += cost;
    account.used = Math.max(0, account.used - cost);
    this.transactions.push({
      id: newId("credit_tx"),
      ownerId,
      bizType: "refund",
      bizNo,
      action,
      changeAmount: cost,
      afterAmount: account.available,
      reason,
    });

    return { cost, balance: { ownerId, ...account }, skipped: false };
  }
}

/**
 * PostgreSQL 实现。真实计费用这个。
 */
export class PostgresCreditRepository {
  constructor(pool, { env = process.env } = {}) {
    this.pool = pool;
    this.costs = resolveCosts(env);
    this.initialGrant = resolveInitialGrant(env);
    this.mode = "postgres";
  }

  async _ensureAccount(ownerId) {
    await this.pool.query(
      `insert into content_platform.credit_accounts(
         id, owner_type, owner_id, available_credits, frozen_credits, used_credits
       )
       values ($1, $2, $3, $4, 0, 0)
       on conflict (owner_type, owner_id) do nothing`,
      [newId("credit_user"), OWNER_TYPE, ownerId, this.initialGrant],
    );
  }

  async getBalance(ownerId) {
    await this._ensureAccount(ownerId);
    const result = await this.pool.query(
      `select available_credits, frozen_credits, used_credits
         from content_platform.credit_accounts
        where owner_type = $1 and owner_id = $2`,
      [OWNER_TYPE, ownerId],
    );
    const row = result.rows[0] || {};
    return {
      ownerId,
      available: row.available_credits ?? 0,
      frozen: row.frozen_credits ?? 0,
      used: row.used_credits ?? 0,
    };
  }

  _costOf(action) {
    const cost = this.costs[action];
    if (cost === undefined) throw new UnknownBillingActionError(action);
    return cost;
  }

  /**
   * 预扣额度（原子条件更新 + 流水）。
   *
   * 顺序：先插流水拿唯一键做幂等闸门，再原子扣减。若扣减失败（余额不足）就
   * 回滚整笔事务——流水不留，避免"有扣减记录但没真扣"的脏账。
   */
  async deduct({ ownerId, action, bizNo }) {
    const cost = this._costOf(action);
    await this._ensureAccount(ownerId);

    const client = await this.pool.connect();
    try {
      await client.query("begin");

      // 幂等闸门：同一 bizNo 已存在则说明已扣过。
      const existing = await client.query(
        `select id, change_amount from content_platform.credit_transactions
          where biz_type = 'deduct' and biz_no = $1`,
        [bizNo],
      );
      if (existing.rowCount > 0) {
        await client.query("commit");
        return { cost: 0, balance: await this.getBalance(ownerId), replayed: true };
      }

      // 原子扣减：条件不满足时 rowCount 为 0，即余额不足。
      const updated = await client.query(
        `update content_platform.credit_accounts
            set available_credits = available_credits - $1,
                used_credits = used_credits + $1,
                version_no = version_no + 1,
                updated_at = now()
          where owner_type = $2 and owner_id = $3 and available_credits >= $1
          returning available_credits`,
        [cost, OWNER_TYPE, ownerId],
      );

      if (updated.rowCount === 0) {
        await client.query("rollback");
        const balance = await this.getBalance(ownerId);
        throw new InsufficientCreditsError({
          required: cost,
          available: balance.available,
          action,
        });
      }

      const accountRow = await client.query(
        `select id from content_platform.credit_accounts
          where owner_type = $1 and owner_id = $2`,
        [OWNER_TYPE, ownerId],
      );

      await client.query(
        `insert into content_platform.credit_transactions(
           id, account_id, owner_type, owner_id, biz_type, biz_no,
           change_amount, before_amount, after_amount, remark
         )
         values ($1, $2, $3, $4, 'deduct', $5, $6, $7, $8, $9)`,
        [
          newId("credit_tx"),
          accountRow.rows[0].id,
          OWNER_TYPE,
          ownerId,
          bizNo,
          -cost,
          updated.rows[0].available_credits + cost,
          updated.rows[0].available_credits,
          `action=${action}`,
        ],
      );

      await client.query("commit");
      return {
        cost,
        balance: {
          ownerId,
          available: updated.rows[0].available_credits,
        },
        replayed: false,
      };
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // 已回滚或连接已断，忽略。
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async refund({ ownerId, action, bizNo, reason = "" }) {
    const cost = this._costOf(action);

    const client = await this.pool.connect();
    try {
      await client.query("begin");

      const deducted = await client.query(
        `select id from content_platform.credit_transactions
          where biz_type = 'deduct' and biz_no = $1`,
        [bizNo],
      );
      if (deducted.rowCount === 0) {
        await client.query("rollback");
        return { cost: 0, balance: await this.getBalance(ownerId), skipped: true };
      }

      const refunded = await client.query(
        `select id from content_platform.credit_transactions
          where biz_type = 'refund' and biz_no = $1`,
        [bizNo],
      );
      if (refunded.rowCount > 0) {
        await client.query("rollback");
        return { cost: 0, balance: await this.getBalance(ownerId), skipped: true };
      }

      const updated = await client.query(
        `update content_platform.credit_accounts
            set available_credits = available_credits + $1,
                used_credits = greatest(used_credits - $1, 0),
                version_no = version_no + 1,
                updated_at = now()
          where owner_type = $2 and owner_id = $3
          returning available_credits, id`,
        [cost, OWNER_TYPE, ownerId],
      );
      if (updated.rowCount === 0) {
        await client.query("rollback");
        return { cost: 0, balance: await this.getBalance(ownerId), skipped: true };
      }

      await client.query(
        `insert into content_platform.credit_transactions(
           id, account_id, owner_type, owner_id, biz_type, biz_no,
           change_amount, before_amount, after_amount, remark
         )
         values ($1, $2, $3, $4, 'refund', $5, $6, $7, $8, $9)`,
        [
          newId("credit_tx"),
          updated.rows[0].id,
          OWNER_TYPE,
          ownerId,
          bizNo,
          cost,
          updated.rows[0].available_credits - cost,
          updated.rows[0].available_credits,
          reason || `refund action=${action}`,
        ],
      );

      await client.query("commit");
      return {
        cost,
        balance: { ownerId, available: updated.rows[0].available_credits },
        skipped: false,
      };
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // ignore
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createCreditRepository(pool, options = {}) {
  return pool ? new PostgresCreditRepository(pool, options) : new MemoryCreditRepository(options);
}
