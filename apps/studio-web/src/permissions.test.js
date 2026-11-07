/**
 * 前端权限矩阵与 session 逻辑测试。
 *
 * 重点验证**与后端的一致性**：前端矩阵只用于隐藏按钮，但两份矩阵不一致会让
 * 用户看到不该看到的按钮（体验问题）或看不到能用的按钮（功能问题）。
 * 因此这里用与后端 permissions.test.js 相同的边界用例。
 *
 * 覆盖 18 项断言：
 * 1-6   矩阵与后端一致（owner 全权、editor 边界、viewer 只读、未知角色拒绝）
 * 7-9   buildPermissionView（off 模式 bypass、未登录、正常角色）
 * 10-12 forbiddenHint 文案
 * 13-15 session 存储（存取、清除、存储不可用时降级）
 * 16-18 detectAuthMode（local/strict/失败回落 off）
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ACTIONS,
  ROLES,
  actionsForRole,
  buildPermissionView,
  can,
  forbiddenHint,
  isKnownRole,
} from "./permissions.js";
import {
  clearSession,
  authHeaders,
  detectAuthMode,
  fetchMerchantSession,
  hydrateSession,
  readRoleCode,
  readToken,
  saveSession,
} from "./session.js";

/* --------------------------------------------- 与后端矩阵一致性 */

test("owner 拥有全部权限点（与后端一致）", () => {
  const actions = actionsForRole(ROLES.OWNER);
  for (const action of Object.values(ACTIONS)) {
    assert.ok(actions.includes(action), `owner 缺少 ${action}`);
  }
});

test("editor 能写内容与素材，不能管成员/删项目/发布", () => {
  assert.equal(can(ROLES.EDITOR, ACTIONS.CONTENT_WRITE), true);
  assert.equal(can(ROLES.EDITOR, ACTIONS.ASSET_WRITE), true);
  assert.equal(can(ROLES.EDITOR, ACTIONS.MEMBER_WRITE), false);
  assert.equal(can(ROLES.EDITOR, ACTIONS.PROJECT_DELETE), false);
  assert.equal(can(ROLES.EDITOR, ACTIONS.CONTENT_PUBLISH), false);
});

test("viewer 只能读", () => {
  assert.equal(can(ROLES.VIEWER, ACTIONS.PROJECT_READ), true);
  assert.equal(can(ROLES.VIEWER, ACTIONS.CONTENT_WRITE), false);
  assert.equal(can(ROLES.VIEWER, ACTIONS.MEMBER_WRITE), false);
});

test("未知角色一律返回 false（不放行）", () => {
  for (const role of ["admin", "", null, undefined, "owner2"]) {
    assert.equal(isKnownRole(role), false);
    assert.equal(can(role, ACTIONS.PROJECT_READ), false);
  }
});

test("角色名大小写与空格被容忍", () => {
  assert.equal(can(" OWNER ", ACTIONS.MEMBER_WRITE), true);
  assert.equal(can("Editor", ACTIONS.CONTENT_WRITE), true);
});

test("每个已知角色都至少有一个权限点", () => {
  for (const role of Object.values(ROLES)) {
    assert.ok(actionsForRole(role).length > 0, `${role} 权限集为空`);
  }
});

/* --------------------------------------------- 权限视图 */

test("AUTH_MODE=off 时一律放行（与后端 bypass 一致）", () => {
  const view = buildPermissionView({ authMode: "off", roleCode: null });
  assert.equal(view.bypass, true);
  assert.equal(view.can(ACTIONS.MEMBER_WRITE), true);
  assert.equal(view.can(ACTIONS.CONTENT_PUBLISH), true);
  assert.equal(view.isAuthenticated, true);
});

test("非 off 模式且无角色时全部拒绝", () => {
  const view = buildPermissionView({ authMode: "local", roleCode: null });
  assert.equal(view.bypass, false);
  assert.equal(view.can(ACTIONS.PROJECT_READ), false);
  assert.equal(view.isAuthenticated, false);
});

test("有角色时按矩阵判定", () => {
  const view = buildPermissionView({ authMode: "local", roleCode: "editor" });
  assert.equal(view.can(ACTIONS.CONTENT_WRITE), true);
  assert.equal(view.can(ACTIONS.MEMBER_WRITE), false);
});

/* --------------------------------------------- 提示文案 */

test("成员管理无权限时提示 owner 专属", () => {
  assert.match(forbiddenHint(ACTIONS.MEMBER_WRITE, "editor"), /owner/);
});

test("发布无权限时提示 owner 专属", () => {
  assert.match(forbiddenHint(ACTIONS.CONTENT_PUBLISH, "editor"), /owner/);
});

test("只读角色的写操作提示提到角色名", () => {
  const hint = forbiddenHint(ACTIONS.CONTENT_WRITE, "viewer");
  assert.match(hint, /viewer/);
  assert.match(hint, /只读/);
});

/* --------------------------------------------- 会话存储 */

/** 在 Node 里装一个最小的 localStorage 桩；返回还原函数。 */
function installFakeStorage() {
  const original = globalThis.window;
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
  };
  return () => {
    globalThis.window = original;
  };
}

test("saveSession / readToken / readRoleCode 往返正确", () => {
  const restore = installFakeStorage();
  try {
    saveSession({ token: "tok_abc", roleCode: "owner" });
    assert.equal(readToken(), "tok_abc");
    assert.equal(readRoleCode(), "owner");
  } finally {
    restore();
  }
});

test("clearSession 清空 token 与角色", () => {
  const restore = installFakeStorage();
  try {
    saveSession({ token: "tok_abc", roleCode: "owner" });
    clearSession();
    assert.equal(readToken(), "");
    assert.equal(readRoleCode(), "");
  } finally {
    restore();
  }
});

test("localStorage 不可用时读取返回空串而不抛错", () => {
  // 模拟隐私模式：临时把 localStorage 换成会抛错的实现
  const original = globalThis.window;
  globalThis.window = {
    get localStorage() {
      throw new Error("storage disabled");
    },
  };
  try {
    assert.equal(readToken(), "");
    assert.equal(readRoleCode(), "");
    // 写入也必须安全
    saveSession({ token: "x", roleCode: "y" });
    clearSession();
  } finally {
    globalThis.window = original;
  }
});

/* --------------------------------------------- 后端模式探测 */

test("detectAuthMode 识别 local / strict", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ data: { authMode: "local" } }),
  });
  assert.equal(await detectAuthMode("http://x", fakeFetch), "local");

  const strictFetch = async () => ({
    ok: true,
    json: async () => ({ data: { authMode: "strict" } }),
  });
  assert.equal(await detectAuthMode("http://x", strictFetch), "strict");
});

test("detectAuthMode 遇到未知值按 strict 处理（fail-closed，绝不回落 off）", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ data: { authMode: "weird" } }),
  });
  assert.equal(await detectAuthMode("http://x", fakeFetch), "strict");

  // 后端新增模式名（如 merchant）时同样必须按 strict 处理：
  // 若这里回落到 off，前端会把写操作按钮全部放开，点下去全是 401。
  const merchantFetch = async () => ({
    ok: true,
    json: async () => ({ data: { authMode: "merchant" } }),
  });
  assert.equal(await detectAuthMode("http://x", merchantFetch), "strict");
});

test("detectAuthMode 只在后端明确报 off 时返回 off", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ data: { authMode: "off" } }),
  });
  assert.equal(await detectAuthMode("http://x", fakeFetch), "off");
});

test("detectAuthMode 网络失败按 strict 处理（不让抖动静默降级成演示模式）", async () => {
  const failingFetch = async () => {
    throw new Error("network down");
  };
  assert.equal(await detectAuthMode("http://x", failingFetch), "strict");
});

test("detectAuthMode 非 2xx 按 strict 处理", async () => {
  const failingFetch = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(await detectAuthMode("http://x", failingFetch), "strict");
});

/* --------------------------------------------- 请求头（平台级守卫依赖它） */

test("authHeaders 只带 token，不再自述角色", () => {
  const restore = installFakeStorage();
  try {
    saveSession({ token: "tok_xyz", roleCode: "editor" });
    const headers = authHeaders();
    assert.equal(headers.Authorization, "Bearer tok_xyz");
    // 角色已改为服务端查 project_members 决定，前端不再自述。
    // 若这里又出现 X-Content-Role，说明有人退回了"前端说了算"的旧实现。
    assert.equal("X-Content-Role" in headers, false);
  } finally {
    restore();
  }
});

test("authHeaders 在无会话时不产生空头", () => {
  const restore = installFakeStorage();
  try {
    clearSession();
    const headers = authHeaders();
    assert.equal("Authorization" in headers, false);
    assert.equal("X-Content-Role" in headers, false);
  } finally {
    restore();
  }
});

test("authHeaders 保留调用方传入的额外头", () => {
  const restore = installFakeStorage();
  try {
    saveSession({ token: "t", roleCode: "owner" });
    const headers = authHeaders({ "Content-Type": "application/json" });
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers.Authorization, "Bearer t");
  } finally {
    restore();
  }
});

/* --------------------------------------------- 统一会话（云购 /user/session/） */

test("fetchMerchantSession 带 credentials:include 并取回 token", async () => {
  let observed = null;
  const fakeFetch = async (url, options) => {
    observed = { url, options };
    return {
      ok: true,
      json: async () => ({
        status: 200,
        data: { token: "merchant_tok", user: { name: "admin" }, tenant: { slug: "demo" } },
      }),
    };
  };
  const session = await fetchMerchantSession(fakeFetch, "http://shop/user/session/");
  // 跨端口 Cookie 要能被带上，credentials 必须是 include，否则读不到商家会话。
  assert.equal(observed.options.credentials, "include");
  assert.equal(observed.url, "http://shop/user/session/");
  assert.equal(session.token, "merchant_tok");
  assert.equal(session.user, "admin");
  assert.equal(session.tenant, "demo");
});

test("fetchMerchantSession 在业务失败（body.status != 200）时返回 null", async () => {
  // 云购的 login_required 返回 200 + body.status，只看 response.ok 会把未登录当成功。
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ status: 401, msg: "请先登录" }),
  });
  assert.equal(await fetchMerchantSession(fakeFetch, "http://shop/user/session/"), null);
});

test("fetchMerchantSession 无 token / 网络失败 / 非 2xx 一律返回 null", async () => {
  const noToken = async () => ({
    ok: true,
    json: async () => ({ status: 200, data: { user: { name: "a" }, tenant: { slug: "b" } } }),
  });
  assert.equal(await fetchMerchantSession(noToken, "http://shop/user/session/"), null);

  const notOk = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(await fetchMerchantSession(notOk, "http://shop/user/session/"), null);

  const boom = async () => {
    throw new Error("network down");
  };
  assert.equal(await fetchMerchantSession(boom, "http://shop/user/session/"), null);
});

test("hydrateSession 用统一会话换到的 token 写进本地存储", async () => {
  const restore = installFakeStorage();
  try {
    clearSession();
    const fakeFetch = async () => ({
      ok: true,
      json: async () => ({ status: 200, data: { token: "tok_from_cookie" } }),
    });
    const token = await hydrateSession(fakeFetch, "http://shop/user/session/");
    assert.equal(token, "tok_from_cookie");
    // 关键契约：换到的 token 必须落进 readToken()/authHeaders() 认的那一处，
    // 否则访问内容平台接口时仍然没有 Authorization 头。
    assert.equal(readToken(), "tok_from_cookie");
    assert.equal(authHeaders().Authorization, "Bearer tok_from_cookie");
  } finally {
    restore();
  }
});

test("hydrateSession 已有 token 时不重复请求统一会话", async () => {
  const restore = installFakeStorage();
  try {
    saveSession({ token: "existing", roleCode: "" });
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return { ok: true, json: async () => ({ status: 200, data: { token: "other" } }) };
    };
    const token = await hydrateSession(fakeFetch, "http://shop/user/session/");
    assert.equal(token, "existing");
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test("hydrateSession 发现缓存的 token 已失效时改用统一会话换新", async () => {
  const restore = installFakeStorage();
  try {
    saveSession({ token: "stale", roleCode: "" });
    const urls = [];
    const fakeFetch = async (url) => {
      urls.push(url);
      if (String(url).includes("/api/auth/me")) return { ok: false };
      return { ok: true, json: async () => ({ status: 200, data: { token: "fresh" } }) };
    };
    const token = await hydrateSession(
      fakeFetch,
      "http://shop/user/session/",
      "http://127.0.0.1:3100",
    );
    assert.equal(token, "fresh");
    assert.equal(readToken(), "fresh");
    assert.ok(urls.some((u) => String(u).includes("/api/auth/me")));
    assert.ok(urls.some((u) => String(u).includes("/user/session/")));
  } finally {
    restore();
  }
});

test("hydrateSession 缓存的 token 仍有效时直接复用，不打统一会话", async () => {
  const restore = installFakeStorage();
  try {
    saveSession({ token: "good", roleCode: "" });
    const urls = [];
    const fakeFetch = async (url) => {
      urls.push(url);
      return { ok: true, json: async () => ({ status: 200, data: { token: "other" } }) };
    };
    const token = await hydrateSession(
      fakeFetch,
      "http://shop/user/session/",
      "http://127.0.0.1:3100",
    );
    assert.equal(token, "good");
    assert.equal(urls.length, 1);
    assert.ok(String(urls[0]).includes("/api/auth/me"));
  } finally {
    restore();
  }
});

test("hydrateSession 换不到会话时返回空串，不伪造 token", async () => {
  const restore = installFakeStorage();
  try {
    clearSession();
    const fakeFetch = async () => ({ ok: false, json: async () => ({}) });
    const token = await hydrateSession(fakeFetch, "http://shop/user/session/");
    assert.equal(token, "");
    assert.equal(readToken(), "");
  } finally {
    restore();
  }
});

test("源码里不再有指向已 404 接口的登录/注册调用", () => {
  // 这条断言是"只能有一个登录页"的守卫：后端在 merchant 模式下把
  // /api/auth/login 与 /api/auth/register 明确 404，前端若还留着调用路径，
  // 用户会看到"点登录必然失败"。所以直接扫源码。
  // 只扫代码本体：注释里解释"这两个接口已 404"是必要的说明，不算调用。
  const stripComments = (source) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join("\n");

  const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");

  for (const file of ["./session.js", "./PermissionGate.jsx", "./App.jsx", "./batch-api.js"]) {
    const code = stripComments(read(file));
    assert.equal(code.includes("/api/auth/login"), false, `${file} 仍调用 /api/auth/login`);
    assert.equal(code.includes("/api/auth/register"), false, `${file} 仍调用 /api/auth/register`);
  }

  // AuthPanel（本地登录/注册表单）必须已被移除，连同它的样式。
  const gate = stripComments(read("./PermissionGate.jsx"));
  assert.equal(gate.includes("AuthPanel"), false, "PermissionGate.jsx 仍导出本地登录面板");
  assert.equal(gate.includes("auth-form"), false, "PermissionGate.jsx 仍渲染登录表单");

  const styles = read("./styles.css");
  for (const selector of [".auth-panel", ".auth-tabs", ".auth-form", ".auth-error", ".auth-note"]) {
    assert.equal(styles.includes(selector), false, `styles.css 仍保留登录面板样式 ${selector}`);
  }
});