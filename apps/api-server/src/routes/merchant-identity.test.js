/**
 * 云购统一身份接入自检（端到端）。
 *
 * 覆盖验收标准 1-3：
 * 1. `authMode=off` 不再是默认：未配置统一身份时受保护接口拒绝访问。
 * 2. 合法云购会话放行（读 + 写各一例）；会话失效 / 无映射 / 权限不足 → 拒绝。
 * 3. 前端自称身份（`X-Content-User-Id` 等）不被采信。
 *
 * 做法：起一个假的云购 `/user/me/` 服务（临时端口），用 `MERCHANT_IDENTITY_URL`
 * 指向它，再用真实 `buildApp` 走 HTTP。这样校验链路（含超时、状态码判断、
 * 映射查询）都是真实执行的，而不是被 mock 掉。
 *
 * 不连数据库：走内存仓储（不配 DATABASE_URL）。数据库路径的隔离验证另见
 * `merchant-links-postgres.test.js`。
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { buildApp } from "../server.js";
import { MemoryMerchantLinksRepository } from "../repositories/merchant-links-repository.js";

const BASE_ENV = {
  AUTH_SECRET: "test-secret-at-least-16-chars",
  DATA_HUB_URL: "",
  AI_ORCHESTRATOR_BASE_URL: "",
};

/** 假云购：按 token 返回不同会话，用于覆盖放行/失效/停用/权限不足。 */
const MERCHANT_SESSIONS = {
  "tok-good": {
    status: 200,
    msg: "ok",
    data: {
      user: { id: 11, name: "staff_a", nick_name: "店员甲", tenant_id: 7 },
      tenant: { id: 7, name: "甲店铺", status: 1 },
      permissions: { is_super: false, actions: ["product:read", "product:write"] },
    },
  },
  "tok-readonly": {
    status: 200,
    msg: "ok",
    data: {
      user: { id: 12, name: "staff_viewer", tenant_id: 7 },
      tenant: { id: 7, name: "甲店铺", status: 1 },
      permissions: { is_super: false, actions: ["product:read"] },
    },
  },
  "tok-suspended": {
    status: 200,
    msg: "ok",
    data: {
      user: { id: 13, name: "staff_b", tenant_id: 8 },
      tenant: { id: 8, name: "乙店铺", status: 0 },
      permissions: { is_super: false, actions: ["product:read", "product:write"] },
    },
  },
  "tok-unmapped": {
    status: 200,
    msg: "ok",
    data: {
      user: { id: 21, name: "staff_c", tenant_id: 9 },
      tenant: { id: 9, name: "丙店铺", status: 1 },
      permissions: { is_super: false, actions: ["product:read", "product:write"] },
    },
  },
};

/**
 * 云购的 `login_required` 返回 `{'status': 401}` 的 **dict**，HTTP 码仍是 200。
 * 这里刻意照抄这个形状：只检查 `response.ok` 的实现会把失效会话当成成功。
 */
function merchantSessionFor(token) {
  return MERCHANT_SESSIONS[token] || { status: 401, msg: "token 无效或已过期", data: null };
}

async function withMerchantServer(run) {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/user/me/") {
      const token = String(request.headers.token || "").trim()
        || String(request.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
      const payload = merchantSessionFor(token);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: 404, msg: "not found", data: null }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(url);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withApp(env, run) {
  const app = await buildApp({ env: { ...BASE_ENV, ...env } });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base, app);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function call(base, method, path, { body, token, headers = {} } = {}) {
  const merged = { ...headers };
  if (body !== undefined) merged["Content-Type"] = "application/json";
  if (token) merged.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers: merged,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { status: response.status, body: payload };
}

/* ------------------------------------- 验收 1：off 不再是默认 */

test("未配置统一身份时，受保护读接口拒绝访问而不是回落到演示身份", async () => {
  await withApp({ MERCHANT_IDENTITY_URL: "" }, async (base) => {
    const list = await call(base, "GET", "/api/projects");
    assert.equal(list.status, 401, JSON.stringify(list.body));
    assert.equal(list.body.code, "UNAUTHORIZED");
  });
});

test("未配置统一身份时，受保护写接口同样拒绝（不回落到 user_demo）", async () => {
  await withApp({ MERCHANT_IDENTITY_URL: "" }, async (base) => {
    const created = await call(base, "POST", "/api/projects", { body: { name: "不该被创建" } });
    assert.equal(created.status, 401, JSON.stringify(created.body));
    // 关键：绝不能是 201 + ownerUserId=user_demo
    assert.equal(JSON.stringify(created.body).includes("user_demo"), false);
  });
});

test("/api/health 报告 authMode=strict（前端可识别）+ identitySource=merchant-session", async () => {
  await withApp({ MERCHANT_IDENTITY_URL: "" }, async (base) => {
    const health = await call(base, "GET", "/api/health");
    assert.equal(health.status, 200);
    // 前端只认 off/local/strict；报 merchant 会被前端回落成 off（演示模式）。
    assert.equal(health.body.data.authMode, "strict");
    assert.equal(health.body.data.authModeRaw, "merchant");
    assert.equal(health.body.data.identitySource, "merchant-session");
    assert.equal(health.body.data.identityConfigured, false);
  });
});

test("配置了统一身份但服务不可达时返回 503（区分配置/网络问题与凭证问题）", async () => {
  await withApp({ MERCHANT_IDENTITY_URL: "http://127.0.0.1:1/user/me/" }, async (base) => {
    const result = await call(base, "GET", "/api/projects", { token: "tok-good" });
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(result.body.code, "IDENTITY_UNAVAILABLE");
  });
});

/* ------------------------------------- 验收 2：会话放行 / 拒绝 */

test("合法云购会话 + 已映射 → 读接口放行", async () => {
  await withMerchantServer(async (merchantUrl) => {
    await withApp({ MERCHANT_IDENTITY_URL: merchantUrl }, async (base, app) => {
      // 显式建立映射：内容平台用户 user_shop_a 由运维登记
      await app.locals.merchantLinksRepository.link({
        merchantTenantId: "7",
        merchantStaffId: "11",
        contentUserId: "user_shop_a",
        createdBy: "test-operator",
        note: "甲店铺店员",
      });

      const list = await call(base, "GET", "/api/projects", { token: "tok-good" });
      assert.equal(list.status, 200, JSON.stringify(list.body));
      assert.deepEqual(list.body.data.items, []);
    });
  });
});

test("合法云购会话 + 已映射 → 写接口放行，且项目归属是该映射用户（不是 user_demo）", async () => {
  await withMerchantServer(async (merchantUrl) => {
    await withApp({ MERCHANT_IDENTITY_URL: merchantUrl }, async (base, app) => {
      await app.locals.merchantLinksRepository.link({
        merchantTenantId: "7",
        merchantStaffId: "11",
        contentUserId: "user_shop_a",
        createdBy: "test-operator",
      });

      const created = await call(base, "POST", "/api/projects", {
        body: { name: "甲店铺项目" },
        token: "tok-good",
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.ownerUserId, "user_shop_a");

      // 再读一次，确认归属可读且没跑到演示用户空间
      const list = await call(base, "GET", "/api/projects", { token: "tok-good" });
      assert.equal(list.status, 200);
      assert.equal(list.body.data.items.length, 1);
      assert.equal(list.body.data.items[0].ownerUserId, "user_shop_a");
    });
  });
});

test("云购会话失效（业务状态 401 但 HTTP 200）→ 401", async () => {
  await withMerchantServer(async (merchantUrl) => {
    await withApp({ MERCHANT_IDENTITY_URL: merchantUrl }, async (base) => {
      const result = await call(base, "GET", "/api/projects", { token: "tok-not-exist" });
      assert.equal(result.status, 401, JSON.stringify(result.body));
      assert.equal(result.body.code, "INVALID_TOKEN");
    });
  });
});

test("云购会话有效但无映射 → 403 IDENTITY_NOT_MAPPED，且不自动创建映射", async () => {
  await withMerchantServer(async (merchantUrl) => {
    await withApp({ MERCHANT_IDENTITY_URL: merchantUrl }, async (base, app) => {
      const result = await call(base, "GET", "/api/projects", { token: "tok-unmapped" });
      assert.equal(result.status, 403, JSON.stringify(result.body));
      assert.equal(result.body.code, "IDENTITY_NOT_MAPPED");

      // 关键断言：拒绝之后映射表里**不能**冒出任何记录（不猜关联）
      const links = await app.locals.merchantLinksRepository.listLinks();
      assert.equal(links.length, 0);

      // 写操作同样被拒
      const write = await call(base, "POST", "/api/projects", {
        body: { name: "无映射项目" },
        token: "tok-unmapped",
      });
      assert.equal(write.status, 403);
    });
  });
});

test("云购租户被停用 → 403 TENANT_INACTIVE", async () => {
  await withMerchantServer(async (merchantUrl) => {
    await withApp({ MERCHANT_IDENTITY_URL: merchantUrl }, async (base, app) => {
      await app.locals.merchantLinksRepository.link({
        merchantTenantId: "8",
        merchantStaffId: "13",
        contentUserId: "user_shop_b",
        createdBy: "test-operator",
      });
      const result = await call(base, "GET", "/api/projects", { token: "tok-suspended" });
      assert.equal(result.status, 403, JSON.stringify(result.body));
      assert.equal(result.body.code, "TENANT_INACTIVE");
    });
  });
});

test("云购动作码不足（只有 product:read）→ 写操作 403，读操作放行", async () => {
  await withMerchantServer(async (merchantUrl) => {
    await withApp({ MERCHANT_IDENTITY_URL: merchantUrl }, async (base, app) => {
      await app.locals.merchantLinksRepository.link({
        merchantTenantId: "7",
        merchantStaffId: "12",
        contentUserId: "user_viewer",
        createdBy: "test-operator",
      });

      const read = await call(base, "GET", "/api/projects", { token: "tok-readonly" });
      assert.equal(read.status, 200, JSON.stringify(read.body));

      const write = await call(base, "POST", "/api/projects", {
        body: { name: "只读账号不该能建" },
        token: "tok-readonly",
      });
      // 云购动作码是独立闸门：缺少 product:write 时连项目创建都不放行
      assert.equal(write.status, 403, JSON.stringify(write.body));
    });
  });
});

test("merchant 模式下不签发本地凭证，但只读身份接口可用（前端依赖）", async () => {
  await withMerchantServer(async (merchantUrl) => {
    await withApp({ MERCHANT_IDENTITY_URL: merchantUrl }, async (base, app) => {
      // 注册/登录必须不可用：正式身份只能来自云购，不能有第二条登录路径。
      // 无 token 时被身份中间件拦在路由之前（401）；带有效云购会话时走到处理器，
      // 处理器明确返回 404 AUTH_DISABLED —— 两种结果都不会签出本地 token。
      const registerNoToken = await call(base, "POST", "/api/auth/register", {
        body: { username: "sneaky", password: "password123" },
      });
      assert.equal(registerNoToken.status, 401, JSON.stringify(registerNoToken.body));

      await app.locals.merchantLinksRepository.link({
        merchantTenantId: "7",
        merchantStaffId: "11",
        contentUserId: "user_shop_a",
        createdBy: "test-operator",
      });

      const register = await call(base, "POST", "/api/auth/register", {
        body: { username: "sneaky", password: "password123" },
        token: "tok-good",
      });
      assert.equal(register.status, 404, JSON.stringify(register.body));
      assert.equal(register.body.code, "AUTH_DISABLED");
      // 关键：响应里绝不能出现 token
      assert.equal(JSON.stringify(register.body).includes("token"), false);

      const login = await call(base, "POST", "/api/auth/login", {
        body: { username: "sneaky", password: "password123" },
        token: "tok-good",
      });
      assert.equal(login.status, 404, JSON.stringify(login.body));
      assert.equal(login.body.code, "AUTH_DISABLED");

      await app.locals.merchantLinksRepository.link({
        merchantTenantId: "7",
        merchantStaffId: "11",
        contentUserId: "user_shop_a",
        createdBy: "test-operator",
      });

      // 只读身份接口可用：前端 session.js / PermissionGate.jsx 靠它取服务端权威角色
      const me = await call(base, "GET", "/api/auth/me", { token: "tok-good" });
      assert.equal(me.status, 200, JSON.stringify(me.body));
      assert.equal(me.body.data.identity.userId, "user_shop_a");
      assert.equal(me.body.data.identity.merchant.staffId, "11");

      const meProjects = await call(base, "GET", "/api/auth/me/projects", { token: "tok-good" });
      assert.equal(meProjects.status, 200, JSON.stringify(meProjects.body));
      assert.equal(meProjects.body.data.userId, "user_shop_a");

      // 无 token 时仍是 401（身份接口不放行匿名）
      const anonymous = await call(base, "GET", "/api/auth/me");
      assert.equal(anonymous.status, 401);
    });
  });
});

/* ------------------------------------- 验收 3：不采信前端自称身份 */

test("前端伪造 X-Content-User-Id / X-User-Id 无法指定身份", async () => {
  await withMerchantServer(async (merchantUrl) => {
    await withApp({ MERCHANT_IDENTITY_URL: merchantUrl }, async (base, app) => {
      await app.locals.merchantLinksRepository.link({
        merchantTenantId: "7",
        merchantStaffId: "11",
        contentUserId: "user_shop_a",
        createdBy: "test-operator",
      });

      const created = await call(base, "POST", "/api/projects", {
        body: { name: "伪造归属" },
        token: "tok-good",
        headers: {
          "X-Content-User-Id": "user_admin",
          "X-User-Id": "user_admin",
          "X-Content-Role": "owner",
        },
      });
      assert.equal(created.status, 201);
      // 归属必须来自云购映射，伪造头无效
      assert.equal(created.body.data.ownerUserId, "user_shop_a");
    });
  });
});

test("伪造 X-Content-User-Id 不能绕过映射缺失（仍然 403）", async () => {
  await withMerchantServer(async (merchantUrl) => {
    await withApp({ MERCHANT_IDENTITY_URL: merchantUrl }, async (base) => {
      const result = await call(base, "GET", "/api/projects", {
        token: "tok-unmapped",
        headers: { "X-Content-User-Id": "user_shop_a" },
      });
      assert.equal(result.status, 403, JSON.stringify(result.body));
      assert.equal(result.body.code, "IDENTITY_NOT_MAPPED");
    });
  });
});

/* ------------------------------------- 显式 off 后门仍然只对本地演示生效 */

test("显式 AUTH_MODE=off 仍是本地演示后门（向后兼容）", async () => {
  await withApp({ AUTH_MODE: "off", MERCHANT_IDENTITY_URL: "" }, async (base) => {
    const created = await call(base, "POST", "/api/projects", { body: { name: "演示项目" } });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.ownerUserId, "user_demo");
  });
});

test("映射仓储在无数据库时为内存实现，健康检查如实报告", async () => {
  const repository = new MemoryMerchantLinksRepository();
  assert.equal(repository.mode, "memory");
  await withApp({ MERCHANT_IDENTITY_URL: "" }, async (base) => {
    const health = await call(base, "GET", "/api/health");
    assert.equal(health.body.data.merchantLinksRepository, "memory");
    assert.equal(health.body.data.projectsRepository, "memory");
  });
});
