/**
 * 注册 / 登录接口端到端自检。
 *
 * 用真实 Express app（不经网络，走 supertest 风格的内部 http 调用太绕），
 * 这里直接构造 app 并用 node 内置 http 起在临时端口验证。
 *
 * 覆盖 9 项断言：
 * 1-2  AUTH_MODE=off 时注册/登录返回 404（不假装有用户体系）
 * 3    local 模式下可注册
 * 4    重复注册返回 409
 * 5    密码过短被拒
 * 6    登录成功返回 token
 * 7    密码错误返回 401 且文案不区分用户是否存在
 * 8    /me 带 token 能拿到身份
 * 9    /me 无 token 返回 401
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { buildApp } from "../server.js";

async function withApp(env, run) {
  const app = await buildApp({ env });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(base, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function get(base, path, headers = {}) {
  const response = await fetch(`${base}${path}`, { headers });
  return { status: response.status, body: await response.json() };
}

const BASE_ENV = {
  AUTH_SECRET: "test-secret-at-least-16-chars",
  // 不配 DATABASE_URL → 走内存仓储，测试无需数据库
  DATA_HUB_URL: "",
  AI_ORCHESTRATOR_BASE_URL: "",
};

test("AUTH_MODE=off 时注册接口返回 404（不假装有用户体系）", async () => {
  await withApp({ ...BASE_ENV, AUTH_MODE: "off" }, async (base) => {
    const result = await post(base, "/api/auth/register", {
      username: "tester",
      password: "password123",
    });
    assert.equal(result.status, 404);
    assert.equal(result.body.code, "AUTH_DISABLED");
  });
});

test("AUTH_MODE=off 时登录接口返回 404", async () => {
  await withApp({ ...BASE_ENV, AUTH_MODE: "off" }, async (base) => {
    const result = await post(base, "/api/auth/login", {
      username: "tester",
      password: "password123",
    });
    assert.equal(result.status, 404);
  });
});

test("local 模式可注册并登录，token 可用于 /me", async () => {
  await withApp({ ...BASE_ENV, AUTH_MODE: "local" }, async (base) => {
    const registered = await post(base, "/api/auth/register", {
      username: "alice",
      password: "password123",
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.data.user.username, "alice");

    const login = await post(base, "/api/auth/login", {
      username: "alice",
      password: "password123",
    });
    assert.equal(login.status, 200);
    const token = login.body.data.token;
    assert.ok(token);
    // 响应里绝不能回传密码或哈希
    assert.equal(JSON.stringify(login.body).includes("password"), false);
    assert.equal(JSON.stringify(login.body).includes("scrypt"), false);

    const me = await get(base, "/api/auth/me", { Authorization: `Bearer ${token}` });
    assert.equal(me.status, 200);
    assert.equal(me.body.data.identity.userId, registered.body.data.user.id);
    assert.equal(me.body.data.user.username, "alice");
  });
});

test("重复注册返回 409", async () => {
  await withApp({ ...BASE_ENV, AUTH_MODE: "local" }, async (base) => {
    await post(base, "/api/auth/register", { username: "bob", password: "password123" });
    const again = await post(base, "/api/auth/register", { username: "bob", password: "password123" });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "USER_EXISTS");
  });
});

test("密码过短被拒绝", async () => {
  await withApp({ ...BASE_ENV, AUTH_MODE: "local" }, async (base) => {
    const result = await post(base, "/api/auth/register", { username: "shorty", password: "123" });
    assert.equal(result.status, 400);
  });
});

test("密码错误返回 401，且文案不泄漏用户是否存在", async () => {
  await withApp({ ...BASE_ENV, AUTH_MODE: "local" }, async (base) => {
    await post(base, "/api/auth/register", { username: "carol", password: "password123" });

    const wrongPassword = await post(base, "/api/auth/login", {
      username: "carol",
      password: "wrong-password",
    });
    const noSuchUser = await post(base, "/api/auth/login", {
      username: "nobody",
      password: "password123",
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(noSuchUser.status, 401);
    // 用户不存在与密码错误必须返回完全相同的文案，否则可枚举用户名
    assert.equal(wrongPassword.body.message, noSuchUser.body.message);
  });
});

test("/me 无 token 返回 401", async () => {
  await withApp({ ...BASE_ENV, AUTH_MODE: "local" }, async (base) => {
    const result = await get(base, "/api/auth/me");
    assert.equal(result.status, 401);
  });
});

test("local 模式下未登录创建项目返回 401", async () => {
  await withApp({ ...BASE_ENV, AUTH_MODE: "local" }, async (base) => {
    const result = await post(base, "/api/projects", { name: "匿名项目" });
    assert.equal(result.status, 401);
  });
});

test("local 模式下登录用户创建项目，他人看不到", async () => {
  await withApp({ ...BASE_ENV, AUTH_MODE: "local" }, async (base) => {
    const reg = await post(base, "/api/auth/register", { username: "dave", password: "password123" });
    assert.equal(reg.status, 201);
    const login = await post(base, "/api/auth/login", { username: "dave", password: "password123" });
    const token = login.body.data.token;

    const created = await post(base, "/api/projects", { name: "戴夫的项目" }, { Authorization: `Bearer ${token}` });
    assert.equal(created.status, 201);

    const mine = await get(base, "/api/projects", { Authorization: `Bearer ${token}` });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.data.items.length, 1);

    // 另一个用户看不到 dave 的项目
    await post(base, "/api/auth/register", { username: "erin", password: "password123" });
    const erinLogin = await post(base, "/api/auth/login", { username: "erin", password: "password123" });
    const others = await get(base, "/api/projects", {
      Authorization: `Bearer ${erinLogin.body.data.token}`,
    });
    assert.equal(others.status, 200);
    assert.equal(others.body.data.items.length, 0);
  });
});

test("AUTH_MODE=off 时创建项目仍沿用演示用户（向后兼容）", async () => {
  await withApp({ ...BASE_ENV, AUTH_MODE: "off" }, async (base) => {
    const created = await post(base, "/api/projects", { name: "旧行为项目" });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.ownerUserId, "user_demo");

    const list = await get(base, "/api/projects");
    assert.equal(list.status, 200);
    assert.equal(list.body.data.items.length, 1);
  });
});
