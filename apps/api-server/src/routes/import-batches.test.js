/**
 * 导入批次的项目隔离自检。
 *
 * 背景：`import_batches` 原先没有 `project_id`，`listImportBatches()` 直接返回全表。
 * 结果是任何登录用户都能看到别人导入的商品批次（含成本价、FOB 等敏感字段）。
 * 权限点管的是"能不能写"，这里管的是"能看谁的"——两件事。
 *
 * 覆盖 11 项断言：
 * 1-2   AUTH_MODE=off 仍能看到全部（本地演示向后兼容）
 * 3-4   匿名看不到任何批次
 * 5-6   甲导入的批次，乙看不到
 * 7-8   同项目的成员能看到彼此批次
 * 9     指定不属于自己的 projectId 导入被拒（404）
 * 10    指定自己的 projectId 导入成功并记录归属
 * 11    未指定 projectId 时归入"未分配"且返回 projectId=null
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

async function makeUser(base, username) {
  const registered = await call(base, "POST", "/api/auth/register", {
    body: { username, password: "password123" },
  });
  assert.equal(registered.status, 201, `register ${username}: ${JSON.stringify(registered.body)}`);
  const login = await call(base, "POST", "/api/auth/login", {
    body: { username, password: "password123" },
  });
  return { id: registered.body.data.user.id, token: login.body.data.token };
}

const ROWS = [{ title: "测试商品", salePrice: "99" }];
const MAPPING = { name: "title", price: "salePrice" };

async function importBatch(base, token, extra = {}) {
  return call(base, "POST", "/api/import-batches", {
    body: { fileName: "demo.csv", fieldMapping: MAPPING, rows: ROWS, ...extra },
    token,
  });
}

/* ------------------------------------------------ off 模式（向后兼容） */

test("AUTH_MODE=off 时能看到全部批次（本地演示不隔离）", async () => {
  await withApp({ AUTH_MODE: "off" }, async (base) => {
    await importBatch(base, null);
    await importBatch(base, null);
    const list = await call(base, "GET", "/api/import-batches");
    assert.equal(list.status, 200);
    assert.equal(list.body.data.items.length, 2);
  });
});

test("AUTH_MODE=off 时导入返回 projectId=null（未分配）", async () => {
  await withApp({ AUTH_MODE: "off" }, async (base) => {
    const created = await importBatch(base, null);
    assert.equal(created.status, 201);
    assert.equal(created.body.data.projectId, null);
  });
});

/* ------------------------------------------------ 隔离生效 */

test("匿名看不到任何批次", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const owner = await makeUser(base, "iso_owner");
    const project = await call(base, "POST", "/api/projects", {
      body: { name: "甲项目" },
      token: owner.token,
    });
    await importBatch(base, owner.token, { projectId: project.body.data.id });

    const anonymous = await call(base, "GET", "/api/import-batches");
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.body.data.items.length, 0);
  });
});

test("别人项目的批次互相看不到（核心隔离断言）", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const alice = await makeUser(base, "alice_iso");
    const bob = await makeUser(base, "bob_iso");
    const aliceProject = await call(base, "POST", "/api/projects", {
      body: { name: "爱丽丝项目" },
      token: alice.token,
    });

    const created = await importBatch(base, alice.token, {
      projectId: aliceProject.body.data.id,
    });
    assert.equal(created.status, 201);

    // 爱丽丝能看到自己的
    const aliceList = await call(base, "GET", "/api/import-batches", { token: alice.token });
    assert.equal(aliceList.body.data.items.length, 1);
    assert.equal(aliceList.body.data.items[0].fileName, "demo.csv");

    // 鲍勃（无任何项目）看不到爱丽丝的批次
    const bobList = await call(base, "GET", "/api/import-batches", { token: bob.token });
    assert.equal(bobList.body.data.items.length, 0);
  });
});

test("同项目的成员能看到彼此的批次", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const owner = await makeUser(base, "team_owner");
    const member = await makeUser(base, "team_member");
    const project = await call(base, "POST", "/api/projects", {
      body: { name: "共享项目" },
      token: owner.token,
    });
    await call(base, "PUT", `/api/projects/${project.body.data.id}/members/${member.id}`, {
      body: { roleCode: "editor" },
      token: owner.token,
    });

    await importBatch(base, owner.token, { projectId: project.body.data.id });

    const memberList = await call(base, "GET", "/api/import-batches", { token: member.token });
    assert.equal(memberList.body.data.items.length, 1);
  });
});

test("给别人项目指定 projectId 导入被拒（404，不暴露项目是否存在）", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const alice = await makeUser(base, "alice_reject");
    const bob = await makeUser(base, "bob_reject");
    const aliceProject = await call(base, "POST", "/api/projects", {
      body: { name: "爱丽丝私有" },
      token: alice.token,
    });

    const attempt = await importBatch(base, bob.token, {
      projectId: aliceProject.body.data.id,
    });
    assert.equal(attempt.status, 404);
    assert.equal(attempt.body.code, "PROJECT_NOT_FOUND");
  });
});

test("导入到自己的项目成功并记录归属", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const owner = await makeUser(base, "own_batch");
    const project = await call(base, "POST", "/api/projects", {
      body: { name: "自己的项目" },
      token: owner.token,
    });
    const created = await importBatch(base, owner.token, {
      projectId: project.body.data.id,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.projectId, project.body.data.id);

    const list = await call(base, "GET", "/api/import-batches", { token: owner.token });
    assert.equal(list.body.data.items[0].projectId, project.body.data.id);
  });
});

test("未指定 projectId 时归入未分配，且该用户可见", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const user = await makeUser(base, "unassigned");
    const created = await importBatch(base, user.token);
    assert.equal(created.status, 201);
    assert.equal(created.body.data.projectId, null);

    // 未分配批次对该用户可见（否则会"导入完就消失"，前端还没选项目器）
    const list = await call(base, "GET", "/api/import-batches", { token: user.token });
    assert.equal(list.body.data.items.length, 1);
    assert.equal(list.body.data.includedUnscoped, true);
  });
});

test("非成员只看到未分配批次，看不到他人项目批次", async () => {
  await withApp({ AUTH_MODE: "local" }, async (base) => {
    const alice = await makeUser(base, "mix_alice");
    const bob = await makeUser(base, "mix_bob");
    const aliceProject = await call(base, "POST", "/api/projects", {
      body: { name: "混合项目" },
      token: alice.token,
    });
    await importBatch(base, alice.token, { projectId: aliceProject.body.data.id });
    await importBatch(base, bob.token); // bob 的未分配批次

    const bobList = await call(base, "GET", "/api/import-batches", { token: bob.token });
    assert.equal(bobList.body.data.items.length, 1, "应只看到自己的未分配批次");
    assert.equal(bobList.body.data.items[0].projectId, null);
  });
});
