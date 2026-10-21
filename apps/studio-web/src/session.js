/**
 * 前端会话与权限上下文。
 *
 * 设计取舍
 * --------
 * 1. **token 存 localStorage 而不是 sessionStorage**：这是明确的安全妥协。
 *    理想做法是 HttpOnly Cookie + CSRF 防护，但那需要后端同时改造会话与
 *    跨域配置（当前后端用 Authorization 头，CORS 全开）。在浏览器本地会话
 *    这件事上，localStorage 的代价是"XSS 能读到 token"，收益是"刷新不用重新登录"。
 *    README 里写明了这一点，并在 token 上加短有效期（后端默认 12 小时）来限缩窗口。
 *
 * 2. **默认不登录**：`AUTH_MODE=off` 时后端把所有人当演示用户，前端也就没有
 *    "登录"这一步。只有配置了 `AUTH_MODE=local|strict` 才显示登录界面。
 *    通过 `/api/health` 探测后端模式，而不是前端自己读环境变量——前端构建产物
 *    与后端配置可能不同步，问后端才准。
 *
 * 3. **401/403 的处理分开**：401 是"没登录/过期"，应清 token 并提示重新登录；
 *    403 是"登录了但角色不够"，绝不能清 token（那会让人莫名其妙被登出）。
 */

import {
  ACTIONS,
  buildPermissionView,
  forbiddenHint,
} from "./permissions.js";

const TOKEN_KEY = "dsh.content.token";
const ROLE_KEY = "dsh.content.roleCode";

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    // 隐私模式 / 禁用存储时 localStorage 访问会抛错，不能让整个应用崩掉。
    return null;
  }
}

export function readToken() {
  try {
    return storage()?.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function readRoleCode() {
  try {
    return storage()?.getItem(ROLE_KEY) || "";
  } catch {
    return "";
  }
}

export function saveSession({ token, roleCode }) {
  const store = storage();
  if (!store) return;
  try {
    if (token) store.setItem(TOKEN_KEY, token);
    if (roleCode) store.setItem(ROLE_KEY, roleCode);
  } catch {
    // 配额满或被禁用：静默失败，本次会话仍然可用（只是刷新后要重新登录）。
  }
}

export function clearSession() {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(TOKEN_KEY);
    store.removeItem(ROLE_KEY);
  } catch {
    // ignore
  }
}

/**
 * 从后端探测鉴权模式。
 * 失败时返回 off —— 保守地向"本地演示"降级，避免把网络抖动变成"要求登录"。
 */
export async function detectAuthMode(apiBaseUrl, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${apiBaseUrl}/api/health`);
    if (!response.ok) return "off";
    const payload = await response.json();
    const mode = payload?.data?.authMode;
    return mode === "local" || mode === "strict" ? mode : "off";
  } catch {
    return "off";
  }
}

export async function login(apiBaseUrl, { username, password }, fetchImpl = fetch) {
  const response = await fetchImpl(`${apiBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || "登录失败");
  }
  return payload.data;
}

export async function register(apiBaseUrl, { username, password }, fetchImpl = fetch) {
  const response = await fetchImpl(`${apiBaseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || "注册失败");
  }
  return payload.data;
}

/**
 * 查询当前用户在指定项目中的角色。
 *
 * 需要先知道"我是谁"才能从成员列表里挑出自己，因此先调 /api/auth/me。
 * 任一环节失败都返回 null（调用方按"无角色"处理，即只读/隐藏写操作），
 * 不抛错——权限探测失败不该让整个页面白屏。
 */
export async function fetchProjectRole(apiBaseUrl, projectId, token, fetchImpl = fetch) {
  if (!projectId || !token) return null;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const meResponse = await fetchImpl(`${apiBaseUrl}/api/auth/me`, { headers });
    if (!meResponse.ok) return null;
    const me = await meResponse.json();
    const userId = me?.data?.identity?.userId;
    if (!userId) return null;

    const memberResponse = await fetchImpl(
      `${apiBaseUrl}/api/projects/${projectId}/members`,
      { headers },
    );
    // 非成员时后端返回 404，此时就是没有角色。
    if (!memberResponse.ok) return null;
    const members = await memberResponse.json();
    const items = members?.data?.items || [];
    const mine = items.find((item) => item.userId === userId);
    return mine?.roleCode || null;
  } catch {
    return null;
  }
}

export {
  ACTIONS,
  buildPermissionView,
  forbiddenHint,
};
