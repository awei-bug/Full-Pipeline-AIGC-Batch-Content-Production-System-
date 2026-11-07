/**
 * 前端会话与权限上下文。
 *
 * 设计取舍
 * --------
 * 1. **身份唯一来源是云购商家会话**：内容平台不签发自己的登录凭证
 *    （后端 `AUTH_MODE=merchant` 下 `/api/auth/login`、`/api/auth/register`
 *    已明确返回 404）。前端因此**不再提供本地登录表单**，只做一件事：
 *    带着 `credentials: 'include'` 去问云购 `/user/session/` "我是谁"，
 *    换回该会话的 token，再照旧用 `Authorization: Bearer` 访问内容平台。
 *
 *    为什么还要落到本地存储：内容平台后端的守卫只认 `Authorization: Bearer`
 *    （`lib/identity.js: extractBearerToken`），不读 Cookie。因此云购 Cookie
 *    只能用来**换取** token，真正访问时仍需带上它。`authHeaders()` / `readToken()`
 *    的契约保持不变，只把 token 的**来源**换成了统一会话。
 *
 * 2. **fail-closed**：`/api/health` 报的 `authMode` 只认 `off|local|strict`，
 *    其它任何取值（包括以后新增的模式名）以及探测失败，一律按 `strict` 处理。
 *    早期实现回落 `off`，那等于"后端要身份，前端却当成演示模式放行全部写操作"，
 *    是必须消灭的静默降级。唯一的 `off` 来源是后端**明确**回 `off`。
 *
 * 3. **401/403 的处理分开**：401 是"没登录/过期"，应清 token 并提示去商家后台登录；
 *    403 是"登录了但角色不够"，绝不能清 token（那会让人莫名其妙被登出）。
 */

import {
  ACTIONS,
  buildPermissionView,
  forbiddenHint,
} from "./permissions.js";

const TOKEN_KEY = "dsh.content.token";
const ROLE_KEY = "dsh.content.roleCode";

/**
 * 云购统一会话接口。
 *
 * 127.0.0.1 上 Cookie 跨端口共享，因此云购在 5000 写的商家会话 Cookie，
 * 5174 的内容前端能读到——前提是带 `credentials: 'include'`，且云购侧
 * CORS 允许凭据（`flask_shop/wsgi.py: supports_credentials=True`）。
 */
export const MERCHANT_SESSION_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_MERCHANT_SESSION_URL) ||
  "http://127.0.0.1:5000/user/session/";

/** 唯一的登录入口：云购商家后台。内容前端不再有第二个登录页。 */
export const MERCHANT_LOGIN_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_MERCHANT_LOGIN_URL) ||
  "http://127.0.0.1:8080/admin/login";

/** 未检测到统一会话时的统一文案，避免各处各写一句。 */
export const MERCHANT_LOGIN_HINT = "未检测到云购商家会话，请先登录商家后台";

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

/**
 * 构造带鉴权的请求头。
 *
 * **不再发送 `X-Content-Role`。** 后端平台级守卫已改为查 `project_members` 表
 * 取该用户的真实角色（服务端权威），前端自述角色的头已被后端忽略。
 * 保留发送它只会造成"以为前端说了算"的误解，所以彻底去掉。
 *
 * 本地缓存的 roleCode 仍用于**渲染**（控制按钮显隐），但它不再影响后端判定。
 */
export function authHeaders(extra = {}) {
  const token = readToken();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/**
 * 从服务端取当前用户的真实角色。
 *
 * 这是 `GET /api/auth/me/projects` 的前端封装。返回：
 * - `memberships`：各项目角色
 * - `platformRole`：服务端折算的最高角色（前端拿它控制按钮显隐）
 * - `actions`：该角色可执行的权限点
 *
 * 失败时返回 null，调用方按"无角色"处理（只读），不抛错——角色查询失败
 * 不该让页面白屏或误以为自己是 owner。
 */
export async function fetchMyRoles(apiBaseUrl, fetchImpl = fetch) {
  const token = readToken();
  if (!token) return null;
  try {
    const response = await fetchImpl(`${apiBaseUrl}/api/auth/me/projects`, {
      headers: authHeaders(),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.data || null;
  } catch {
    return null;
  }
}

export function saveSession({ token, roleCode }) {
  const store = storage();
  if (!store) return;
  try {
    if (token) store.setItem(TOKEN_KEY, token);
    if (roleCode) store.setItem(ROLE_KEY, roleCode);
  } catch {
    // 配额满或被禁用：静默失败，本次会话仍然可用（只是刷新后要重新换取会话）。
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
 * 宿主统一会话桥接。被 iframe 承载时，登录令牌由宿主下发，登出由宿主广播；
 * 只接受宿主 origin 且来自父窗口的消息，避免任意页面注入令牌。
 */
const UNIFIED_HOST_ORIGIN = "http://127.0.0.1:8080";

if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    if (event.origin !== UNIFIED_HOST_ORIGIN || event.source !== window.parent) return;
    const payload = event.data;
    if (!payload || typeof payload !== "object") return;
    if (payload.type === "unified:session" && typeof payload.token === "string") {
      saveSession({ token: payload.token });
    } else if (payload.type === "unified:logout") {
      clearSession();
    }
  });
}

/**
 * 从统一会话响应里取 token。
 *
 * 云购的 Flask-RESTful 响应把业务体放在 `data` 里，且**业务状态在 body.status**
 * （`login_required` 返回 dict，不改 HTTP 码），所以既要看 `response.ok`，
 * 也要看 `body.status`。token 字段名兼容 `token` / `accessToken` 两种写法。
 */
function pickSessionToken(payload) {
  const data = payload?.data ?? payload;
  const raw = data?.token ?? data?.accessToken ?? data?.access_token ?? "";
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * 向云购换取当前统一会话。
 *
 * @returns {Promise<{token: string, user: string, tenant: string}|null>}
 *   未登录、会话失效、接口不可用、响应里没有 token 一律返回 null——
 *   调用方按"未登录"处理，绝不猜测身份。
 */
export async function fetchMerchantSession(fetchImpl = fetch, url = MERCHANT_SESSION_URL) {
  try {
    const response = await fetchImpl(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== "object") return null;
    // 云购把业务失败也放在 200 + body.status 里，必须两个都看。
    if (payload.status !== undefined && payload.status !== 200) return null;
    const data = payload.data ?? payload;
    if (!data || typeof data !== "object") return null;
    const token = pickSessionToken(payload);
    if (!token) return null;
    return {
      token,
      user: String(data.user?.name || data.name || ""),
      tenant: String(data.tenant?.slug || data.tenant_slug || ""),
    };
  } catch {
    return null;
  }
}

/**
 * 把本地 token 与统一会话对齐。
 *
 * 已有 token 直接复用（避免每次渲染都打一次云购）；否则用共享 Cookie 换一个。
 * 返回当前可用的 token，空串表示确实没有会话。
 */
export async function hydrateSession(
  fetchImpl = fetch,
  url = MERCHANT_SESSION_URL,
  apiBaseUrl = "",
) {
  // A token cached by an earlier run can be expired or revoked (the shop service
  // records revoked jti values now), so trusting it blindly leaves the whole page
  // stuck on 401 until browser storage is cleared. Verify first, then fall back to
  // exchanging the shared cookie for a fresh one.
  const existing = readToken();
  if (existing) {
    if (!apiBaseUrl || (await tokenStillWorks(existing, apiBaseUrl, fetchImpl))) {
      return existing;
    }
    clearSession();
  }

  const session = await fetchMerchantSession(fetchImpl, url);
  if (!session?.token) return "";
  saveSession({ token: session.token, roleCode: "" });
  return session.token;
}

/**
 * Cheap validity probe for a cached token.
 *
 * `/api/auth/me` is an endpoint the page needs anyway, so a success here proves
 * both "token still valid" and "merchant link present".
 */
async function tokenStillWorks(token, apiBaseUrl, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${apiBaseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 从后端探测鉴权模式。
 *
 * 只把后端**明确**报的 `off` 当成演示模式；`local`/`strict` 原样返回；
 * 其它未知取值与探测失败一律按 `strict` 处理（fail-closed）。
 * 理由：回落 `off` 会让前端静默放行全部写操作，而后端仍要求身份——
 * 用户看到的是一堆按钮，点下去全是 401。多要求一次登录的代价远小于此。
 */
export async function detectAuthMode(apiBaseUrl, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${apiBaseUrl}/api/health`);
    if (!response.ok) return "strict";
    const payload = await response.json();
    const mode = payload?.data?.authMode;
    if (mode === "off") return "off";
    if (mode === "local" || mode === "strict") return mode;
    return "strict";
  } catch {
    return "strict";
  }
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
