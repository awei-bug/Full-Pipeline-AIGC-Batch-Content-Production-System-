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
  detectAuthMode,
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

test("detectAuthMode 遇到未知值回落 off", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ data: { authMode: "weird" } }),
  });
  assert.equal(await detectAuthMode("http://x", fakeFetch), "off");
});

test("detectAuthMode 网络失败回落 off（不让抖动变成要求登录）", async () => {
  const failingFetch = async () => {
    throw new Error("network down");
  };
  assert.equal(await detectAuthMode("http://x", failingFetch), "off");
});
