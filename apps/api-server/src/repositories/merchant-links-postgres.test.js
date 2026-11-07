/**
 * 映射仓储的 PostgreSQL 路径自检。
 *
 * 只在 `TEST_DATABASE_URL` 指向**隔离/临时**库时执行；未配置则整组跳过并打印
 * 原因，避免开发者误以为它通过了。绝不用 `DATABASE_URL`——那可能指向业务库，
 * 测试不该写生产数据。
 *
 * 覆盖：
 * 1. 表按需幂等创建，映射可写入、可按 (tenant, staff) 反查。
 * 2. 重复写入同一 (tenant, staff) 只更新目标，不产生第二行（可审计）。
 * 3. 缺少 createdBy 时拒绝写入（审计字段必填）。
 * 4. 云购会话 → 映射 → 项目归属在数据库路径上成立。
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import pg from "pg";

import { buildApp } from "../server.js";
import { PostgresMerchantLinksRepository } from "../repositories/merchant-links-repository.js";

const TEST_DATABASE_URL = String(process.env.TEST_DATABASE_URL || "").trim();
const skip = TEST_DATABASE_URL
  ? false
  : "未配置 TEST_DATABASE_URL（指向临时/隔离库），跳过数据库路径自检";

function withPool(run) {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  return run(pool).finally(() => pool.end());
}

async function withApp(env, run) {
  const app = await buildApp({ env });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, app);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withMerchant(run) {
  const server = createServer((request, response) => {
    const token = String(request.headers.token || "");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(token === "tok-good" ? {
      status: 200,
      msg: "ok",
      data: {
        user: { id: 11, name: "staff_a", tenant_id: 7 },
        tenant: { id: 7, name: "甲店铺", status: 1 },
        permissions: { is_super: false, actions: ["product:read", "product:write"] },
      },
    } : { status: 401, msg: "token 无效或已过期", data: null }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("映射仓储在 PostgreSQL 上幂等建表、可写入与反查", { skip }, async () => {
  await withPool(async (pool) => {
    const repository = new PostgresMerchantLinksRepository(pool);
    assert.equal(repository.mode, "postgres");

    const created = await repository.link({
      merchantTenantId: "tenant_pg_1",
      merchantStaffId: "staff_pg_1",
      contentUserId: "user_demo",
      createdBy: "pg-test-operator",
      note: "pg 路径自检",
    });
    assert.equal(created.merchantTenantId, "tenant_pg_1");

    const found = await repository.findLink({
      merchantTenantId: "tenant_pg_1",
      merchantStaffId: "staff_pg_1",
    });
    assert.equal(found.contentUserId, "user_demo");
    assert.equal(found.createdBy, "pg-test-operator");

    // 重复写入只更新目标，不新增行
    await repository.link({
      merchantTenantId: "tenant_pg_1",
      merchantStaffId: "staff_pg_1",
      contentUserId: "user_demo",
      createdBy: "pg-test-operator-2",
      note: "改备注",
    });
    const count = await pool.query(
      `select count(*)::int as total from content_platform.merchant_links
        where merchant_tenant_id = 'tenant_pg_1' and merchant_staff_id = 'staff_pg_1'`,
    );
    assert.equal(count.rows[0].total, 1);
  });
});

test("缺少 createdBy 时拒绝写入（映射必须可审计）", { skip }, async () => {
  await withPool(async (pool) => {
    const repository = new PostgresMerchantLinksRepository(pool);
    await assert.rejects(
      repository.link({
        merchantTenantId: "tenant_pg_2",
        merchantStaffId: "staff_pg_2",
        contentUserId: "user_demo",
      }),
      /createdBy/,
    );
  });
});

test("数据库路径上：云购会话 + 映射 → 写操作放行且归属正确", { skip }, async () => {
  await withMerchant(async (merchantUrl) => {
    await withApp({
      DATABASE_URL: TEST_DATABASE_URL,
      MERCHANT_IDENTITY_URL: merchantUrl,
      DATA_HUB_URL: "",
      AI_ORCHESTRATOR_BASE_URL: "",
    }, async (base, app) => {
      assert.equal(app.locals.projectsRepository.mode, "postgres");
      assert.equal(app.locals.workflowRepository.mode, "postgres");
      assert.equal(app.locals.merchantLinksRepository.mode, "postgres");

      await app.locals.merchantLinksRepository.link({
        merchantTenantId: "7",
        merchantStaffId: "11",
        contentUserId: "user_demo",
        createdBy: "pg-test-operator",
      });

      const health = await fetch(`${base}/api/health`).then((r) => r.json());
      assert.equal(health.data.projectsRepository, "postgres");
      assert.equal(health.data.workflowRepository, "postgres");
      assert.equal(health.data.merchantLinksRepository, "postgres");

      const created = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok-good" },
        body: JSON.stringify({ name: `pg 自检项目 ${Date.now()}` }),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));

      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.ownerUserId, "user_demo");
    });
  });
});
