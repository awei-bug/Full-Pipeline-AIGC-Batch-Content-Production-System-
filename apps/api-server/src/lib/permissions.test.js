/**
 * 权限矩阵单元测试。
 *
 * 与 members.test.js 分开：这里是纯函数级的矩阵与判定逻辑，起 app、开端口的是
 * 端到端测试。混在一起会让单测跑一轮要等 HTTP 监听，也难定位是策略错还是路由错。
 *
 * 覆盖 9 项断言：
 * 1-2  owner 全权、editor 边界
 * 3-4  viewer 只读
 * 5-6  未知角色拒绝（防拼写错误变提权）
 * 7-8  evaluateAccess 在 off / 无成员时的行为
 * 9    权限点与角色映射的自洽性（每个已知角色至少有一个权限点）
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIONS,
  PLATFORM_ACTIONS,
  ROLES,
  actionsForRole,
  can,
  evaluateAccess,
  isKnownRole,
} from "../lib/permissions.js";

test("owner 拥有全部权限点", () => {
  const actions = actionsForRole(ROLES.owner);
  for (const action of Object.values(ACTIONS)) {
    assert.ok(actions.includes(action), `owner 缺少 ${action}`);
  }
});

test("editor 能写内容与素材，但不能管成员/删项目/发布", () => {
  assert.equal(can(ROLES.editor, ACTIONS.CONTENT_WRITE).allowed, true);
  assert.equal(can(ROLES.editor, ACTIONS.ASSET_WRITE).allowed, true);
  assert.equal(can(ROLES.editor, ACTIONS.MEMBER_WRITE).allowed, false);
  assert.equal(can(ROLES.editor, ACTIONS.PROJECT_DELETE).allowed, false);
  // 发布是对外动作，误操作代价比其他写操作高一个量级，刻意只给 owner
  assert.equal(can(ROLES.editor, ACTIONS.CONTENT_PUBLISH).allowed, false);
});

test("viewer 只能读，不能写任何东西", () => {
  assert.equal(can(ROLES.viewer, ACTIONS.PROJECT_READ).allowed, true);
  assert.equal(can(ROLES.viewer, ACTIONS.CONTENT_READ).allowed, true);
  assert.equal(can(ROLES.viewer, ACTIONS.ASSET_READ).allowed, true);
  for (const action of [ACTIONS.CONTENT_WRITE, ACTIONS.ASSET_WRITE, ACTIONS.MEMBER_WRITE]) {
    assert.equal(can(ROLES.viewer, action).allowed, false, `viewer 不应有 ${action}`);
  }
});

test("viewer 无法读取计费信息", () => {
  assert.equal(can(ROLES.viewer, ACTIONS.BILLING_READ).allowed, false);
});

test("未知角色一律拒绝（不是放行）", () => {
  for (const role of ["admin", "superuser", "", null, undefined, "owner2"]) {
    assert.equal(isKnownRole(role), false, `${role} 不该被当作已知角色`);
    assert.equal(can(role, ACTIONS.PROJECT_READ).allowed, false);
  }
});

test("角色名大小写不敏感，前后空格被容忍", () => {
  assert.equal(isKnownRole("OWNER"), true);
  assert.equal(can(" OWNER ", ACTIONS.MEMBER_WRITE).allowed, true);
});

test("evaluateAccess 在 off 模式放行并标记 bypass", () => {
  const verdict = evaluateAccess({ authMode: "off", roleCode: null, action: ACTIONS.MEMBER_WRITE });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.bypass, true);
});

test("evaluateAccess 在非 off 且无成员记录时拒绝", () => {
  const verdict = evaluateAccess({ authMode: "local", roleCode: null, action: ACTIONS.PROJECT_READ });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /不是该项目成员/);
});

test("每个已知角色至少有一个权限点（防止配置成空集）", () => {
  for (const role of Object.values(ROLES)) {
    assert.ok(actionsForRole(role).length > 0, `${role} 权限集为空`);
  }
});

/* ------------------------------------- 平台级权限点（无项目维度的资源） */

test("平台级权限点被注册在 PLATFORM_ACTIONS 里", () => {
  for (const action of [ACTIONS.PLATFORM_IMPORT, ACTIONS.PLATFORM_GENERATE, ACTIONS.PLATFORM_AI_CHAT]) {
    assert.ok(PLATFORM_ACTIONS.has(action), `${action} 未登记为平台级`);
  }
});

test("项目级权限点不在 PLATFORM_ACTIONS 里（避免误用）", () => {
  for (const action of [ACTIONS.MEMBER_WRITE, ACTIONS.CONTENT_PUBLISH]) {
    assert.equal(PLATFORM_ACTIONS.has(action), false, `${action} 不该是平台级`);
  }
});

test("editor 可做平台级生成与导入，但不能发布", () => {
  assert.equal(can(ROLES.editor, ACTIONS.PLATFORM_GENERATE).allowed, true);
  assert.equal(can(ROLES.editor, ACTIONS.PLATFORM_IMPORT).allowed, true);
  assert.equal(can(ROLES.editor, ACTIONS.PLATFORM_AI_CHAT).allowed, true);
  // 发布仍需 owner：这是对外动作，不因是"平台级"而放宽
  assert.equal(can(ROLES.editor, ACTIONS.CONTENT_PUBLISH).allowed, false);
});

test("viewer 不能做任何平台级写动作", () => {
  for (const action of [ACTIONS.PLATFORM_IMPORT, ACTIONS.PLATFORM_GENERATE, ACTIONS.PLATFORM_AI_CHAT]) {
    assert.equal(can(ROLES.viewer, action).allowed, false, `viewer 不应有 ${action}`);
  }
});
