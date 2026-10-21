/**
 * 用户仓储（内容平台 identity 层）。
 *
 * 两种后端与项目既有约定一致：有 PostgreSQL 走 `content_platform.users` 表
 * （schema 已存在，见 infra/sql/001_init_core_schema.sql），否则用内存实现，
 * 保证双击启动 / 无数据库的本地开发仍可用。
 *
 * 密码处理
 * --------
 * 用 scrypt（node:crypto 内置）而不是明文或裸 sha256：
 * - scrypt 是内存硬（memory-hard）KDF，抵抗 GPU 暴力破解；
 * - 每个用户独立 salt，防彩虹表；
 * - 存储格式 `scrypt$N$r$p$salt$hash` 自带参数，将来调参不需要迁移逻辑。
 * 比较用 timingSafeEqual。
 *
 * 与 memory 后端的取舍
 * ------------------
 * 内存后端**不跨进程持久化**：重启后用户消失。这是刻意的——内存模式用于本地演示，
 * 演示用户由 AUTH_MODE=off 直接覆盖，不需要真实注册。真实多用户必须配 PostgreSQL，
 * 这点在 README 与错误信息里写明，不假装内存模式能当生产用。
 */

import crypto from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function scryptAsync(password, salt, { n = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P } = {}) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      String(password),
      salt,
      KEY_LEN,
      // maxmem 必须显式给：默认 32MB 在 n=16384,r=8 时刚好卡边界会抛错。
      { N: n, r, p, maxmem: 128 * 1024 * 1024 },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt);
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = String(stored || "").split("$");
    if (scheme !== "scrypt") return false;
    const derived = await scryptAsync(password, Buffer.from(saltB64, "base64"), {
      n: Number(n),
      r: Number(r),
      p: Number(p),
    });
    const expected = Buffer.from(hashB64, "base64");
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function mapUserRow(row) {
  return {
    id: row.id,
    userNo: row.user_no,
    username: row.username,
    email: row.email,
    status: row.status,
    tenantId: row.tenant_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MemoryUsersRepository {
  constructor() {
    // 两个索引各司其职：byUsername 用于登录（大小写不敏感），byId 用于 token 校验。
    // 早先只用 username 当 Map 的 key，导致 findById 永远查不到——登录能过、
    // /me 拿到 null，这种半坏状态最难排查。
    this.byUsername = new Map();
    this.byId = new Map();
    this.mode = "memory";
  }

  async findByUsername(username) {
    const key = String(username || "").trim().toLowerCase();
    const item = this.byUsername.get(key);
    return item && item.status === "active" ? item : null;
  }

  async findById(id) {
    const item = this.byId.get(String(id));
    return item && item.status === "active" ? item : null;
  }

  async create({ username, email = null, password, tenantId = null }) {
    const key = String(username || "").trim().toLowerCase();
    if (this.byUsername.has(key)) {
      throw Object.assign(new Error("用户名已存在"), { statusCode: 409, code: "USER_EXISTS" });
    }
    const now = new Date().toISOString();
    const record = {
      id: `user_${crypto.randomUUID().slice(0, 12)}`,
      userNo: `U_${Date.now()}`,
      username: String(username).trim(),
      email,
      status: "active",
      tenantId,
      passwordHash: await hashPassword(password),
      createdAt: now,
      updatedAt: now,
    };
    this.byUsername.set(key, record);
    this.byId.set(record.id, record);
    return record;
  }
}

export class PostgresUsersRepository {
  constructor(pool) {
    this.pool = pool;
    this.mode = "postgres";
  }

  /**
   * `users` 表没有 password_hash 列（schema 是早期设计的）。
   * 密码单独存 `user_credentials`，不 ALTER 既有业务表——加列会要求所有部署
   * 都跑迁移，而凭证表可以按需创建（幂等）。这也符合"凭证与业务分离"的常见做法。
   */
  async ensureCredentialTable() {
    await this.pool.query(
      `create table if not exists content_platform.user_credentials (
         user_id text primary key references content_platform.users(id) on delete cascade,
         password_hash text not null,
         created_at timestamptz not null default now(),
         updated_at timestamptz not null default now()
       )`,
    );
  }

  async findByUsername(username) {
    const result = await this.pool.query(
      `select id, user_no, username, email, status, tenant_id, created_at, updated_at
         from content_platform.users
        where lower(username) = lower($1) and status = 'active'
        limit 1`,
      [String(username || "").trim()],
    );
    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async findById(id) {
    const result = await this.pool.query(
      `select id, user_no, username, email, status, tenant_id, created_at, updated_at
         from content_platform.users
        where id = $1 and status = 'active'
        limit 1`,
      [String(id)],
    );
    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async findCredential(userId) {
    await this.ensureCredentialTable();
    const result = await this.pool.query(
      "select password_hash from content_platform.user_credentials where user_id = $1",
      [String(userId)],
    );
    return result.rows[0]?.password_hash || null;
  }

  async create({ username, email = null, password, tenantId = null }) {
    await this.ensureCredentialTable();
    const existing = await this.findByUsername(username);
    if (existing) {
      throw Object.assign(new Error("用户名已存在"), { statusCode: 409, code: "USER_EXISTS" });
    }
    const id = `user_${crypto.randomUUID().slice(0, 12)}`;
    const userNo = `U_${Date.now()}`;
    const passwordHash = await hashPassword(password);

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const inserted = await client.query(
        `insert into content_platform.users(id, user_no, username, email, status, tenant_id)
         values ($1, $2, $3, $4, 'active', $5)
         returning id, user_no, username, email, status, tenant_id, created_at, updated_at`,
        [id, userNo, String(username).trim(), email, tenantId],
      );
      await client.query(
        `insert into content_platform.user_credentials(user_id, password_hash)
         values ($1, $2)`,
        [id, passwordHash],
      );
      await client.query("commit");
      return mapUserRow(inserted.rows[0]);
    } catch (error) {
      await client.query("rollback");
      if (String(error.message || "").includes("duplicate key")) {
        throw Object.assign(new Error("用户名已存在"), { statusCode: 409, code: "USER_EXISTS" });
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createUsersRepository(pool) {
  return pool ? new PostgresUsersRepository(pool) : new MemoryUsersRepository();
}
