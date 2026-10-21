/**
 * 平台级权限守卫端到端自检。
 *
 * 背景：`import_batches` / `content_jobs` / `products` 这几张表没有 `project_id`
 * （见 infra/sql/005_import_batch_domain.sql），是平台级共享资源。强行套项目级校验
 * 只能靠"猜一个 project id"，那是假的隔离。因此用独立的平台级权限点。
 *
 * 角色来源：请求头 `X-Content-Role`。**未声明时按 viewer 处理**——宁可少放行，
 * 也不做"扫所有项目取最高角色"这类隐式放宽。
 *
 * 覆盖 12 项断言：
 * 1-2   AUTH_MODE=off 放行（向后兼容，本地演示）
 * 3-4   匿名 401
 * 5-6   未声明角色按 viewer 处理，写操作 403
 * 7-8   声明 viewer 仍然 403
 * 9-10  声明 editor 允许平台级生成/导入
 * 11    editor 不能发布（content:publish 仍只给 owner）
 * 12    未知角色被当作 viewer，不放行
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { buildApp } from "../server.js";

const BASE_ENV = {
  AUTH_SECRET: "test-secret-at-least-16-chars",
  DATA_HUB_URL: "",
  AI_ORCHESTRATOR_BASE_URL: "",
};

async function withApp(env, run) {
  const app = await buildApp({ env: { ...BASE_ENV, ...env } });
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

async function call(base, method, path, { body, token, role } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  if (role) headers["X-Content-Role"] = role;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
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

async function makeUser(base, username) {
  const registered = await call(base, "POST", "/api/auth/register", {
    body: { username, password: "password123" },
  });
  assert.equal(registered.status, 201, `register ${username} 失败：${JSON.stringify(registered.body)}`);
  const login = await call(base, "POST", "/api/auth/login", {
    body: { username, password: "password123" },
  });
  assert.equal(login.status, 200, `login ${username} 失败`);
  // 必须带 id：多项目角色测试要用它把用户加进成员表
  return { id: registered.body.data.user.id, token: login.body.data.token };
}

/* ------------------------------------------------ 主流程 */

test("AUTH_MODE=off 时平台级写操作放行（向后兼容）", async () => {
  await withApp({ AUTH_MODE: "off" }, async (base) => {
    // 未配置 orchestrator，预期 503（说明已通过权限检查，走到了业务分支）
    const result = await call(base, "POST", "/api/content-jobs", { body: { batchId: "b1" } });
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.equal(result.body.code, "ORCHESTRATOR_UNAVAILABLE");
  });
});

test("AUTH_MODE=off 时导入接口放行（走到业务分支）", async () => {
  await withApp({ AUTH_MODE: "off" }, async (base) => {
    const result = await call(base, "POST", "/api/import-batches", {
      body: { fileName: "demo.csv", fieldMapping: {}, rows: [] },
    });
    // 没有 rows 会走业务校验，只要不是 401/403 就说明权限层放行了
    assert.notEqual(result.status, 401);
    assert.notEqual(result.status, 403);
  });
});

test("匿名访问平台级写接口返回 401", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const result = await call(base, "POST", "/api/content-jobs", { body: { batchId: "b1" } });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, "UNAUTHORIZED");
  });
});

test("未声明角色时按 viewer 处理，写操作 403", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const user = await makeUser(base, "norole");
    const result = await call(base, "POST", "/api/content-jobs", {
      body: { batchId: "b1" },
      token: user.token,
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "FORBIDDEN");
  });
});

test("声明 viewer 时写操作仍被拒（403）", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const user = await makeUser(base, "viewer1");
    const result = await call(base, "POST", "/api/content-jobs", {
      body: { batchId: "b1" },
      token: user.token,
      role: "viewer",
    });
    assert.equal(result.status, 403);
  });
});

test("成为项目 editor 后平台级生成放行（走到业务分支）", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const owner = await makeUser(base, "editor1_owner");
    const editor = await makeUser(base, "editor1");
    const project = await call(base, "POST", "/api/projects", {
      body: { name: "editor 项目" },
      token: owner.token,
    });
    await call(base, "PUT", `/api/projects/${project.body.data.id}/members/${editor.id}`, {
      body: { roleCode: "editor" },
      token: owner.token,
    });

    const result = await call(base, "POST", "/api/content-jobs", {
      body: { batchId: "b1" },
      token: editor.token,
    });
    // editor 具备 platform:generate，放行后走到业务分支（未配 orchestrator → 503）
    assert.equal(result.status, 503, JSON.stringify(result.body));
  });
});

test("成为项目 editor 后 AI 对话放行（走到业务分支）", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const owner = await makeUser(base, "editor2_owner");
    const editor = await makeUser(base, "editor2");
    const project = await call(base, "POST", "/api/projects", {
      body: { name: "对话项目" },
      token: owner.token,
    });
    await call(base, "PUT", `/api/projects/${project.body.data.id}/members/${editor.id}`, {
      body: { roleCode: "editor" },
      token: owner.token,
    });

    const result = await call(base, "POST", "/api/chat", {
      body: { messages: [{ role: "user", content: "你好" }] },
      token: editor.token,
    });
    assert.notEqual(result.status, 401);
    assert.notEqual(result.status, 403);
  });
});

test("editor 不能发布到商城（403，发布仍只给 owner）", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const user = await makeUser(base, "editor3");
    const result = await call(base, "POST", "/api/listing-packs/job1/push", {
      body: { prices: {} },
      token: user.token,
      role: "editor",
    });
    assert.equal(result.status, 403, JSON.stringify(result.body));
  });
});

test("项目 owner 可通过发布权限检查（走到业务分支）", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const owner = await makeUser(base, "owner1");
    await call(base, "POST", "/api/projects", { body: { name: "发布项目" }, token: owner.token });
    const result = await call(base, "POST", "/api/listing-packs/job1/push", {
      body: { prices: {} },
      token: owner.token,
    });
    // 未配置商城直推，预期 503；关键是没被 403 拦住
    assert.notEqual(result.status, 403, JSON.stringify(result.body));
  });
});

test("未知角色被当作 viewer，不放行写操作", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const user = await makeUser(base, "weirdrole");
    const result = await call(base, "POST", "/api/content-jobs", {
      body: { batchId: "b1" },
      token: user.token,
      role: "superadmin",
    });
    assert.equal(result.status, 403, JSON.stringify(result.body));
  });
});

test("匿名访问发布接口返回 401，而不是 403", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const result = await call(base, "POST", "/api/listing-packs/job1/push", {
      body: { prices: {} },
    });
    assert.equal(result.status, 401);
  });
});

test("项目级路由仍按项目角色校验（creation-requests 未登录 401）", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const result = await call(base, "POST", "/api/creation-requests", {
      body: { projectId: "project_x", prompt: "画一个杯子" },
    });
    assert.equal(result.status, 401);
  });
});

/* --------------------------------------- 角色来自服务端（不认请求头） */

test("伪造 X-Content-Role 无法提权（后端查库而非信头）", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const user = await makeUser(base, "faker");
    // 该用户不属于任何项目，但谎称自己是 owner
    const result = await call(base, "POST", "/api/content-jobs", {
      body: { batchId: "b1" },
      token: user.token,
      role: "owner",
    });
    // 必须仍然被拒：后端只看 project_members
    assert.equal(result.status, 403, JSON.stringify(result.body));
    assert.match(result.body.message, /不是任何项目的成员/);
  });
});

test("成为项目 owner 后平台级写操作才放行", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const user = await makeUser(base, "realowner");
    // 没有项目时被拒
    const before = await call(base, "POST", "/api/content-jobs", {
      body: { batchId: "b1" },
      token: user.token,
    });
    assert.equal(before.status, 403);

    // 创建项目（创建者自动成为 owner），之后应放行
    const project = await call(base, "POST", "/api/projects", {
      body: { name: "真实项目" },
      token: user.token,
    });
    assert.equal(project.status, 201);

    const after = await call(base, "POST", "/api/content-jobs", {
      body: { batchId: "b1" },
      token: user.token,
    });
    // 放行后走到业务分支（未配 orchestrator → 503）
    assert.equal(after.status, 503, JSON.stringify(after.body));
  });
});

test("me/projects 返回服务端折算的角色与权限点", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const user = await makeUser(base, "rolequery");
    const empty = await call(base, "GET", "/api/auth/me/projects", { token: user.token });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.data.platformRole, null);
    assert.deepEqual(empty.body.data.actions, []);

    await call(base, "POST", "/api/projects", { body: { name: "查询项目" }, token: user.token });
    const filled = await call(base, "GET", "/api/auth/me/projects", { token: user.token });
    assert.equal(filled.body.data.platformRole, "owner");
    assert.ok(filled.body.data.actions.includes("platform:generate"));
    assert.equal(filled.body.data.memberships.length, 1);
  });
});

test("me/projects 未登录返回 401", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const result = await call(base, "GET", "/api/auth/me/projects");
    assert.equal(result.status, 401);
  });
});

test("viewer 在其他项目里即使有 owner 也取最高角色（owner）", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const owner = await makeUser(base, "multi_owner");
    const guest = await makeUser(base, "multi_guest");
    const p1 = await call(base, "POST", "/api/projects", { body: { name: "甲项目" }, token: owner.token });
    const p2 = await call(base, "POST", "/api/projects", { body: { name: "乙项目" }, token: owner.token });

    // guest 在甲项目是 viewer，在乙项目是 owner
    await call(base, "PUT", `/api/projects/${p1.body.data.id}/members/${guest.id}`, {
      body: { roleCode: "viewer" },
      token: owner.token,
    });
    await call(base, "PUT", `/api/projects/${p2.body.data.id}/members/${guest.id}`, {
      body: { roleCode: "owner" },
      token: owner.token,
    });

    const me = await call(base, "GET", "/api/auth/me/projects", { token: guest.token });
    assert.equal(me.body.data.platformRole, "owner");
    assert.equal(me.body.data.memberships.length, 2);
  });
});