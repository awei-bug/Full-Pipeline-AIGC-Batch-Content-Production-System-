/**
 * 隔离 PostgreSQL 下的统一身份验证脚本（临时库，端口 55555，不触碰业务库）。
 *
 * 验证三件事：
 * 1. `/api/health` 在配了 DATABASE_URL 时报告 projects/workflow 仓储为 postgres。
 * 2. 映射仓储真的落在 `content_platform.merchant_links` 表（可审计、跨进程一致）。
 * 3. 云购会话 → 映射 → 项目归属整条链路在数据库路径上成立，且无映射时拒绝。
 *
 * 用法：node scripts/verify-merchant-identity-pg.mjs
 * 需要环境变量 DATABASE_URL 指向**临时**库（脚本本身不做清理，避免误删）。
 */

import { createServer } from "node:http";
import pg from "pg";

import { buildApp } from "../src/server.js";
import { createMerchantLinksRepository } from "../src/repositories/merchant-links-repository.js";

const DATABASE_URL = process.env.DATABASE_URL;

function log(label, value) {
  console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function fakeMerchant() {
  const server = createServer((request, response) => {
    const token = String(request.headers.token || "");
    const ok = token === "tok-good";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(ok ? {
      status: 200,
      msg: "ok",
      data: {
        user: { id: 11, name: "staff_a", tenant_id: 7 },
        tenant: { id: 7, name: "甲店铺", status: 1 },
        permissions: { is_super: false, actions: ["product:read", "product:write"] },
      },
    } : { status: 401, msg: "token 无效或已过期", data: null }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function main() {
  if (!DATABASE_URL) throw new Error("需要 DATABASE_URL 指向临时库");

  const { server: merchantServer, url: merchantUrl } = await fakeMerchant();

  const env = {
    DATABASE_URL,
    MERCHANT_IDENTITY_URL: merchantUrl,
    DATA_HUB_URL: "",
    AI_ORCHESTRATOR_BASE_URL: "",
  };

  const app = await buildApp({ env });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { body, token } = {}) => {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    // --- 1. health ---
    const health = await call("GET", "/api/health");
    log("health.status", health.status);
    log("health.projectsRepository", health.body.data.projectsRepository);
    log("health.workflowRepository", health.body.data.workflowRepository);
    log("health.databaseMode", health.body.data.databaseMode);
    log("health.merchantLinksRepository", health.body.data.merchantLinksRepository);
    log("health.authMode", health.body.data.authMode);
    log("health.identityConfigured", health.body.data.identityConfigured);

    // --- 2. 无映射 → 403，且数据库里没有多出任何映射行 ---
    const before = await call("GET", "/api/projects", { token: "tok-good" });
    log("unmapped.read.status", before.status);
    log("unmapped.read.code", before.body.code);

    // --- 3. 写入映射（模拟运维操作）→ 放行 ---
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    const links = createMerchantLinksRepository(pool);
    const linked = await links.link({
      merchantTenantId: "7",
      merchantStaffId: "11",
      contentUserId: "user_demo",
      createdBy: "verify-script",
      note: "隔离库验证",
    });
    log("link.created", { tenant: linked.merchantTenantId, staff: linked.merchantStaffId, user: linked.contentUserId });

    const readAfter = await call("GET", "/api/projects", { token: "tok-good" });
    log("mapped.read.status", readAfter.status);

    const created = await call("POST", "/api/projects", {
      body: { name: "隔离库验证项目" },
      token: "tok-good",
    });
    log("mapped.write.status", created.status);
    log("mapped.write.ownerUserId", created.body.data?.ownerUserId);

    // --- 4. 映射表行数（可审计性证据） ---
    const rows = await pool.query(
      "select merchant_tenant_id, merchant_staff_id, content_user_id, created_by, status from content_platform.merchant_links",
    );
    log("merchant_links.rows", rows.rows);

    const projectRows = await pool.query(
      "select id, owner_user_id from content_platform.projects where name = '隔离库验证项目'",
    );
    log("projects.rows", projectRows.rows);

    await pool.end();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => merchantServer.close(resolve));
  }
}

main().catch((error) => {
  console.error("verify failed:", error.message);
  process.exit(1);
});
