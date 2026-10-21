/**
 * 身份层自检（内容平台）。
 *
 * 覆盖 16 项断言：
 * 1-3   AUTH_MODE 解析与非法值回落
 * 4-6   token 签发与校验（正常、篡改、过期）
 * 7-9   token 安全性质（改 alg、缺 secret 拒签、弱 secret 拒签）
 * 10-12 身份中间件三种模式（off / local 无 token / strict 无 token）
 * 13-14 项目归属隔离（不同用户看不到彼此项目；匿名不能创建）
 * 15-16 与既有路径的兼容（off 模式下仍是演示用户、列表行为不变）
 *
 * 用 node:test，与项目既有测试风格一致；不依赖数据库（走 memory 仓储）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEMO_USER_ID,
  createIdentityMiddleware,
  extractBearerToken,
  makeIdentity,
  resolveAuthMode,
  writableUserId,
} from "../lib/identity.js";
import { signToken, verifyToken, AuthConfigError } from "../lib/local-auth.js";
import { MemoryProjectsRepository } from "../repositories/projects-repository.js";

const SECRET = "test-secret-at-least-16-chars";

/* ---------------------------------------------------------------- 模式解析 */

test("AUTH_MODE 默认 off（保持旧行为）", () => {
  assert.equal(resolveAuthMode({}), "off");
});

test("AUTH_MODE 识别 local / strict", () => {
  assert.equal(resolveAuthMode({ AUTH_MODE: "local" }), "local");
  assert.equal(resolveAuthMode({ AUTH_MODE: "STRICT" }), "strict");
});

test("非法 AUTH_MODE 回落 off，不抛错", () => {
  assert.equal(resolveAuthMode({ AUTH_MODE: "prod" }), "off");
  assert.equal(resolveAuthMode({ AUTH_MODE: "  " }), "off");
});

/* ---------------------------------------------------------------- token */

test("签发的 token 能被校验，claims 一致", () => {
  const token = signToken({ sub: "user_abc", tenant: "demo" }, { secret: SECRET });
  const claims = verifyToken(token, { secret: SECRET });
  assert.ok(claims);
  assert.equal(claims.sub, "user_abc");
  assert.equal(claims.tenant, "demo");
});

test("篡改 payload 后校验失败", () => {
  const token = signToken({ sub: "user_abc" }, { secret: SECRET });
  const [header, , signature] = token.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ sub: "user_admin", exp: 9999999999 }))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  assert.equal(verifyToken(`${header}.${forgedPayload}.${signature}`, { secret: SECRET }), null);
});

test("过期 token 校验失败", () => {
  const token = signToken({ sub: "user_abc", ttlSeconds: 60 }, { secret: SECRET });
  const later = () => Date.now() + 3600 * 1000;
  assert.equal(verifyToken(token, { secret: SECRET, now: later }), null);
});

test("换 secret 校验失败", () => {
  const token = signToken({ sub: "user_abc" }, { secret: SECRET });
  assert.equal(verifyToken(token, { secret: "another-secret-16chars" }), null);
});

test("alg 被改写为 none 时校验失败", () => {
  const token = signToken({ sub: "user_abc" }, { secret: SECRET });
  const [, payload, signature] = token.split(".");
  const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "DSH-TOKEN" }))
    .toString("base64")
    .replace(/=+$/g, "");
  assert.equal(verifyToken(`${noneHeader}.${payload}.${signature}`, { secret: SECRET }), null);
});

test("缺 secret 时拒绝签发（fail-closed）", () => {
  assert.throws(() => signToken({ sub: "u" }, { secret: "" }), AuthConfigError);
});

test("secret 过短时拒绝签发", () => {
  assert.throws(() => signToken({ sub: "u" }, { secret: "short" }), AuthConfigError);
});

/* ---------------------------------------------------------------- 中间件 */

function fakeRequest(headers = {}) {
  return { headers };
}

function fakeResponse() {
  const state = { statusCode: 200, body: null };
  const response = {
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(payload) {
      state.body = payload;
      return this;
    },
    get state() {
      return state;
    },
  };
  return response;
}

test("off 模式下所有请求都解析为演示用户", () => {
  const middleware = createIdentityMiddleware({ env: {} });
  const request = fakeRequest();
  let called = false;
  middleware(request, fakeResponse(), () => {
    called = true;
  });
  assert.ok(called);
  assert.equal(request.identity.userId, DEMO_USER_ID);
  assert.equal(request.identity.kind, "demo");
});

test("local 模式无 token 时降级为匿名，不回落演示用户", () => {
  const middleware = createIdentityMiddleware({ env: { AUTH_MODE: "local" } });
  const request = fakeRequest();
  middleware(request, fakeResponse(), () => {});
  assert.equal(request.identity.kind, "anonymous");
  assert.notEqual(request.identity.userId, DEMO_USER_ID);
  assert.match(request.identity.userId, /^anon_/);
});

test("strict 模式无 token 时返回 401", () => {
  const middleware = createIdentityMiddleware({ env: { AUTH_MODE: "strict" } });
  const response = fakeResponse();
  let called = false;
  middleware(fakeRequest(), response, () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(response.state.statusCode, 401);
});

test("local 模式带有效 token 解析出真实用户", () => {
  const middleware = createIdentityMiddleware({
    env: { AUTH_MODE: "local" },
    verifyToken: (token) => verifyToken(token, { secret: SECRET }),
  });
  const token = signToken({ sub: "user_real", tenant: "t1" }, { secret: SECRET });
  const request = fakeRequest({ authorization: `Bearer ${token}` });
  middleware(request, fakeResponse(), () => {});
  assert.equal(request.identity.userId, "user_real");
  assert.equal(request.identity.tenantId, "t1");
  assert.equal(request.identity.kind, "user");
});

/* ---------------------------------------------------------------- 项目隔离 */

test("项目按 owner 隔离：不同用户看不到彼此项目", async () => {
  const repository = new MemoryProjectsRepository();
  await repository.create({ name: "甲的项目", ownerUserId: "user_a" });
  await repository.create({ name: "乙的项目", ownerUserId: "user_b" });

  const forA = await repository.list({ ownerUserId: "user_a" });
  const forB = await repository.list({ ownerUserId: "user_b" });

  assert.equal(forA.length, 1);
  assert.equal(forA[0].name, "甲的项目");
  assert.equal(forB.length, 1);
  assert.equal(forB[0].name, "乙的项目");
});

test("不传 owner 时返回全部（兼容旧调用）", async () => {
  const repository = new MemoryProjectsRepository();
  await repository.create({ name: "项目一", ownerUserId: "user_a" });
  await repository.create({ name: "项目二", ownerUserId: "user_b" });
  const all = await repository.list();
  assert.equal(all.length, 2);
});

test("匿名身份不可写入（writableUserId 返回 null）", () => {
  assert.equal(writableUserId(makeIdentity({ userId: "anon_x", kind: "anonymous" })), null);
  assert.equal(writableUserId(makeIdentity({ userId: "user_a", kind: "user" })), "user_a");
  assert.equal(writableUserId(makeIdentity({ userId: DEMO_USER_ID, kind: "demo" })), DEMO_USER_ID);
});

test("extractBearerToken 只认 Authorization 头，不读 query", () => {
  assert.equal(extractBearerToken(fakeRequest({ authorization: "Bearer abc.def.ghi" })), "abc.def.ghi");
  assert.equal(extractBearerToken(fakeRequest({ authorization: "bearer xyz" })), "xyz");
  // query string 里的 token 必须被忽略：它会进日志与浏览器历史
  assert.equal(extractBearerToken({ headers: {}, query: { token: "leak" } }), "");
  assert.equal(extractBearerToken(fakeRequest({})), "");
});
