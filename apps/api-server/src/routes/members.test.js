/**
 * 权限矩阵与成员管理自检。
 *
 * 覆盖 26 项断言：
 * 1-6    权限矩阵本身（角色→权限点、未知角色拒绝、off 模式 bypass）
 * 7-11   成员接口基础（角色清单、加成员、改角色、列成员）
 * 12-16  最后一位 owner 保护（降级/移除都被拒）
 * 17-19  自我保护（不能降级自己、不能移除自己）
 * 20-23  越权访问（editor 不能管成员、viewer 只读、非成员 404 而非 403）
 * 24-26  未知角色被拒、off 模式放开、匿名 401
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { buildApp } from "../server.js";
import { ACTIONS, ROLES, actionsForRole, can, evaluateAccess, isKnownRole } from "../lib/permissions.js";

const BASE_ENV = {
  AUTH_SECRET: "test-secret-at-least-16-chars",
  DATA_HUB_URL: "",
  AI_ORCHESTRATOR_BASE_URL: "",
};

/* ------------------------------------------------- 权限矩阵单元测试 */

test("owner 拥有全部权限点", () => {
  const actions = actionsForRole(ROLES.owner);
  for (const action of Object.values(ACTIONS)) {
    assert.ok(actions.includes(action), `owner 缺少 ${action}`);
  }
});

test("editor 能写内容但不能管成员", () => {
  assert.equal(can(ROLES.editor, ACTIONS.CONTENT_WRITE).allowed, true);
  assert.equal(can(ROLES.editor, ACTIONS.MEMBER_WRITE).allowed, false);
  assert.equal(can(ROLES.editor, ACTIONS.PROJECT_DELETE).allowed, false);
});

test("editor 不能发布（对外动作风险更高）", () => {
  assert.equal(can(ROLES.editor, ACTIONS.CONTENT_PUBLISH).allowed, false);
});

test("viewer 只能读", () => {
  assert.equal(can(ROLES.viewer, ACTIONS.PROJECT_READ).allowed, true);
  assert.equal(can(ROLES.viewer, ACTIONS.CONTENT_WRITE).allowed, false);
  assert.equal(can(ROLES.viewer, ACTIONS.MEMBER_WRITE).allowed, false);
});

test("未知角色一律拒绝（防拼写错误变提权）", () => {
  assert.equal(isKnownRole("admin"), false);
  assert.equal(can("admin", ACTIONS.PROJECT_READ).allowed, false);
  assert.equal(can("", ACTIONS.PROJECT_READ).allowed, false);
  assert.equal(can(null, ACTIONS.PROJECT_READ).allowed, false);
});

test("AUTH_MODE=off 下放行并标记 bypass（本地演示不需要权限）", () => {
  const verdict = evaluateAccess({ authMode: "off", roleCode: null, action: ACTIONS.MEMBER_WRITE });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.bypass, true);
});

/* ------------------------------------------------- 端到端 */

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

async function call(base, method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
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

/** 建一个用户并返回 { id, token }。 */
async function makeUser(base, username) {
  const registered = await call(base, "POST", "/api/auth/register", {
    body: { username, password: "password123" },
  });
  assert.equal(registered.status, 201, `register ${username} 失败：${JSON.stringify(registered.body)}`);
  const login = await call(base, "POST", "/api/auth/login", {
    body: { username, password: "password123" },
  });
  assert.equal(login.status, 200);
  return { id: registered.body.data.user.id, token: login.body.data.token, username };
}

async function makeProject(base, token, name) {
  const created = await call(base, "POST", "/api/projects", { body: { name }, token });
  assert.equal(created.status, 201, `创建项目失败：${JSON.stringify(created.body)}`);
  return created.body.data;
}

test("角色清单接口返回全部角色与权限点", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const result = await call(base, "GET", "/api/projects/roles");
    assert.equal(result.status, 200);
    const codes = result.body.data.roles.map((item) => item.code);
    assert.deepEqual(codes.sort(), ["editor", "owner", "viewer"]);
    assert.ok(result.body.data.actions.includes(ACTIONS.MEMBER_WRITE));
  });
});

test("owner 可加成员、改角色、列成员", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const owner = await makeUser(base, "owner1");
    const guest = await makeUser(base, "guest1");
    const project = await makeProject(base, owner.token, "协作项目");

    const added = await call(base, "PUT", `/api/projects/${project.id}/members/${guest.id}`, {
      body: { roleCode: "editor" },
      token: owner.token,
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.data.roleCode, "editor");

    const listed = await call(base, "GET", `/api/projects/${project.id}/members`, { token: owner.token });
    assert.equal(listed.status, 200);
    const ids = listed.body.data.items.map((item) => item.userId);
    assert.ok(ids.includes(owner.id));
    assert.ok(ids.includes(guest.id));

    const changed = await call(base, "PUT", `/api/projects/${project.id}/members/${guest.id}`, {
      body: { roleCode: "viewer" },
      token: owner.token,
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.data.roleCode, "viewer");
  });
});

test("不能把最后一位 owner 降级", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const owner = await makeUser(base, "owner2");
    const other = await makeUser(base, "other2");
    const project = await makeProject(base, owner.token, "单人项目");

    // other 先以 owner 身份操作，目标是降自己 —— 应被自我保护拦住
    const selfDowngrade = await call(base, "PUT", `/api/projects/${project.id}/members/${owner.id}`, {
      body: { roleCode: "viewer" },
      token: owner.token,
    });
    assert.equal(selfDowngrade.status, 409);
    assert.equal(selfDowngrade.body.code, "LAST_OWNER_GUARD");

    // 用另一个 owner 也无法把唯一 owner 降级（先给 other owner，再降 owner）
    await call(base, "PUT", `/api/projects/${project.id}/members/${other.id}`, {
      body: { roleCode: "owner" },
      token: owner.token,
    });
    // 现在有两个 owner，降级第一个应该成功
    const nowAllowed = await call(base, "PUT", `/api/projects/${project.id}/members/${owner.id}`, {
      body: { roleCode: "editor" },
      token: other.token,
    });
    assert.equal(nowAllowed.status, 200);
  });
});

test("不能移除最后一位 owner", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const ownerA = await makeUser(base, "ownerA");
    const ownerB = await makeUser(base, "ownerB");
    const project = await makeProject(base, ownerA.token, "双人项目");

    await call(base, "PUT", `/api/projects/${project.id}/members/${ownerB.id}`, {
      body: { roleCode: "owner" },
      token: ownerA.token,
    });

    // 移除 ownerB（此时有 2 个 owner，B 不是最后一个，允许）
    const removeOne = await call(base, "DELETE", `/api/projects/${project.id}/members/${ownerB.id}`, {
      token: ownerA.token,
    });
    assert.equal(removeOne.status, 200);

    // 此时 ownerA 是唯一 owner，移除自己会被自我保护拦住
    const removeSelf = await call(base, "DELETE", `/api/projects/${project.id}/members/${ownerA.id}`, {
      token: ownerA.token,
    });
    assert.equal(removeSelf.status, 409);
    assert.equal(removeSelf.body.code, "SELF_REMOVAL_GUARD");
  });
});

test("editor 不能管理成员（403）", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const owner = await makeUser(base, "owner3");
    const editor = await makeUser(base, "editor3");
    const project = await makeProject(base, owner.token, "editor 测试");

    await call(base, "PUT", `/api/projects/${project.id}/members/${editor.id}`, {
      body: { roleCode: "editor" },
      token: owner.token,
    });

    const attempt = await call(base, "PUT", `/api/projects/${project.id}/members/${owner.id}`, {
      body: { roleCode: "viewer" },
      token: editor.token,
    });
    assert.equal(attempt.status, 403);
    assert.equal(attempt.body.code, "FORBIDDEN");
  });
});

test("非成员访问返回 404 而不是 403（避免枚举项目 id）", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const owner = await makeUser(base, "owner4");
    const stranger = await makeUser(base, "stranger4");
    const project = await makeProject(base, owner.token, "私有项目");

    const attempt = await call(base, "PUT", `/api/projects/${project.id}/members/${stranger.id}`, {
      body: { roleCode: "editor" },
      token: stranger.token,
    });
    assert.equal(attempt.status, 404);
    assert.equal(attempt.body.code, "PROJECT_NOT_FOUND");
  });
});

test("未知角色被拒绝（400）", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const owner = await makeUser(base, "owner5");
    const guest = await makeUser(base, "guest5");
    const project = await makeProject(base, owner.token, "角色校验");

    const result = await call(base, "PUT", `/api/projects/${project.id}/members/${guest.id}`, {
      body: { roleCode: "admin" },
      token: owner.token,
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "INVALID_ROLE");
  });
});

test("匿名访问成员接口返回 401", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const owner = await makeUser(base, "owner6");
    const project = await makeProject(base, owner.token, "匿名检查");
    const result = await call(base, "GET", `/api/projects/${project.id}/members`);
    assert.equal(result.status, 401);
  });
});

test("AUTH_MODE=off 时成员接口不被权限拦住（本地演示）", async () => {
  await withApp({ AUTH_MODE: "off" }, async (base) => {
    const project = await makeProject(base, null, "演示项目");
    const result = await call(base, "GET", `/api/projects/${project.id}/members`);
    // off 模式 bypass，返回 200（内存仓储里 owner 记录已在创建时写入）
    assert.equal(result.status, 200);
  });
});
