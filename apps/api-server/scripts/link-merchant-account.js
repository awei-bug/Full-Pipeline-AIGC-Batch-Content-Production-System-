/**
 * 运维脚本：把云购商家员工显式映射到内容平台用户。
 *
 * 为什么是脚本而不是自动流程
 * ------------------------
 * 映射是「谁信任谁」的决策，必须由人做出并留下记录。任何自动创建（例如
 * 「第一次登录就建一个账号」）都会让未开通的商家直接拿到一个内容平台身份，
 * 或者让两个商家撞到同一个账号上。
 *
 * 用法
 * ----
 *   node scripts/link-merchant-account.js \
 *     --tenant 7 --staff 11 --user user_abc --by "ops@example.com" [--note "甲店铺运营"]
 *
 *   node scripts/link-merchant-account.js --list
 *
 *   # 内容平台侧还没有这个用户时，显式建号（仍是一次人工决定，不是自动创建）
 *   node scripts/link-merchant-account.js --tenant 7 --staff 11 --user user_abc \
 *     --by "ops@example.com" --create-user --username "甲店铺运营"
 *
 * 需要 `DATABASE_URL`（或 PGHOST/PGUSER/PGPASSWORD/PGDATABASE）指向目标库。
 * 没有数据库时脚本拒绝执行——内存映射重启即丢，不适合当正式映射来源。
 *
 * 为什么需要 `--create-user`
 * ------------------------
 * `merchant_links.content_user_id` 有外键指向 `content_platform.users`，而
 * `AUTH_MODE=merchant` 下不提供注册接口（内容平台不签发自己的会话）。所以新商家
 * 第一次接入时，必须先有一个内容平台用户行。这里把它做成**显式开关**而不是
 * 「登录时自动建」：自动建号会让任何拿到有效云购 token 的人凭空获得一个内容平台
 * 身份，且没人知道它是谁建的。
 *
 * 脚本**不删任何数据**：重复执行同一 (tenant, staff) 只会更新映射目标并刷新
 * 审计字段（`created_by` / `note` / `updated_at`）；`--create-user` 对已存在的
 * 用户 id 只补建、不覆盖。
 */

import pg from "pg";

import { hasDatabaseConfig } from "../src/lib/database.js";
import { createMerchantLinksRepository } from "../src/repositories/merchant-links-repository.js";

function parseArgs(argv) {
  const args = { list: false };
  const flags = new Set(["list", "create-user"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (flags.has(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`参数 ${token} 缺少值`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function buildPool() {
  if (process.env.DATABASE_URL) {
    return new pg.Pool({ connectionString: process.env.DATABASE_URL });
  }
  return new pg.Pool({
    host: process.env.PGHOST || process.env.POSTGRES_HOST,
    port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
    user: process.env.PGUSER || process.env.POSTGRES_USER,
    password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
    database: process.env.PGDATABASE || process.env.POSTGRES_DB,
  });
}

async function ensureContentUser(pool, { userId, username, actor }) {
  const id = String(userId || "").trim();
  if (!id) throw new Error("--create-user 需要 --user 指定用户 id");
  if (!String(actor || "").trim()) throw new Error("--create-user 需要 --by（操作人），建号必须可审计");

  const existing = await pool.query("select id from content_platform.users where id = $1", [id]);
  if (existing.rows.length) return { id, created: false };

  // user_no 唯一：用时间戳 + 随机后缀，避免并发建号撞键。
  const userNo = `U_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `insert into content_platform.users(id, user_no, username, status)
     values ($1, $2, $3, 'active')
     on conflict (id) do nothing`,
    [id, userNo, String(username || id).trim()],
  );
  console.log(`审计：${actor} 新建内容平台用户 ${id}`);
  return { id, created: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!hasDatabaseConfig(process.env)) {
    console.error("缺少数据库配置（DATABASE_URL 或 PGHOST/PGUSER/PGPASSWORD/PGDATABASE）。");
    console.error("内存映射重启即丢，不能作为正式映射来源，因此拒绝执行。");
    process.exit(2);
  }

  const pool = buildPool();
  const repository = createMerchantLinksRepository(pool);
  try {
    if (args.list) {
      const items = await repository.listLinks();
      if (!items.length) {
        console.log("（暂无映射）");
        return;
      }
      for (const item of items) {
        console.log([
          `tenant=${item.merchantTenantId}`,
          `staff=${item.merchantStaffId}`,
          `user=${item.contentUserId}`,
          `status=${item.status}`,
          `by=${item.createdBy}`,
          `note=${item.note || "-"}`,
          `updated=${item.updatedAt}`,
        ].join(" "));
      }
      return;
    }

    if (args["create-user"]) {
      const user = await ensureContentUser(pool, {
        userId: args.user,
        username: args.username || args.user,
        actor: args.by,
      });
      console.log(`内容平台用户已就绪：${user.id}（${user.created ? "新建" : "已存在"}）`);
    }

    const record = await repository.link({
      merchantTenantId: args.tenant,
      merchantStaffId: args.staff,
      contentUserId: args.user,
      createdBy: args.by,
      note: args.note || null,
    });
    console.log("映射已写入：");
    console.log(JSON.stringify(record, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exit(1);
});
