/**
 * 云购商家会话校验（内容平台统一身份的唯一来源）。
 *
 * 为什么是「实时向云购校验」而不是本地自签
 * --------------------------------------
 * 用户已拍板：内容平台的正式鉴权由云购签发的会话驱动身份。本地 token（`local-auth.js`）
 * 只是开发期遗留，不能替代云购会话——否则同一个商家在两个系统里有两套互不相认的身份，
 * 吊销会话时内容平台仍能访问，这是最典型的「登出无效」漏洞。
 *
 * 因此这里**每个请求**都向云购 `/user/me/` 校验一次，不做本地缓存：
 * 缓存会引入「会话已吊销但窗口期内仍可访问」的窗口，而 `/user/me/` 是同库查询，
 * 成本远低于一次业务写操作。地址由 `MERCHANT_IDENTITY_URL` 配置（可只配到主机，
 * 缺省路径自动补 `/user/me/`）。
 *
 * 云购的响应形状（flask_shop/user/views.py: Me）
 * --------------------------------------------
 *   { status: 200, msg: "ok",
 *     data: { user: {...}, tenant: {...}, permissions: { is_super, actions[] } } }
 *
 * 注意 **HTTP 状态码可能是 200，而业务状态在 body.status 里**（Flask-RESTful 的
 * `login_required` 返回 dict，不会改 HTTP 码）。只看 `response.ok` 会把「token 无效」
 * 当成成功，所以两个都要看。
 *
 * 校验失败一律 fail-closed（拒绝），绝不「猜」一个身份：
 * - token 缺失 / 无效 → 401
 * - 租户被停用或状态无法确认 → 拒绝（无法证明店铺在营业就不放行）
 * - 云购不可达 → 503（配置/网络问题，不是凭证问题，让调用方能区分并重试）
 */

/** 云购当前商家会话接口路径。 */
export const MERCHANT_IDENTITY_PATH = "/user/me/";

/** 默认超时：云购是同库查询，5 秒足够；超时即视为不可达，避免请求挂住。 */
export const MERCHANT_TIMEOUT_MS = 5000;

/**
 * 解析 `MERCHANT_IDENTITY_URL`。
 * 只配主机（如 `http://127.0.0.1:5000`）时补上默认路径，减少配置项写错的机会。
 * @returns {string|null} 非法或未配置返回 null（调用方据此 fail-closed）
 */
export function resolveMerchantIdentityUrl(env = process.env) {
  const raw = String(env.MERCHANT_IDENTITY_URL || "").trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = MERCHANT_IDENTITY_PATH;
  }
  return url.toString();
}

export function hasMerchantIdentityConfig(env = process.env) {
  return Boolean(resolveMerchantIdentityUrl(env));
}

export function resolveMerchantTimeoutMs(env = process.env) {
  const value = Number(env.MERCHANT_IDENTITY_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : MERCHANT_TIMEOUT_MS;
}

/**
 * 内容平台权限点 → 云购动作码（`flask_shop/utils/rbac.py: ALL_ACTION_CODES`）。
 *
 * 为什么需要这一层：内容平台的项目角色回答「在这个项目里能做什么」，
 * 云购的动作码回答「这个商家员工在店里能做什么」。两者是**且**的关系：
 * 一个被店主限制了商品权限的员工，不该因为被加进项目就获得生成商品文案的能力。
 *
 * 未列出的权限点一律拒绝（fail-closed）：新增权限点时若忘了登记映射，
 * 结果是「没人能用」，而不是「所有人都能用」——前者是可发现的故障，后者是漏洞。
 */
const CONTENT_ACTION_MERCHANT_ACTIONS = {
  "project:read": ["product:read"],
  "content:read": ["product:read"],
  "asset:read": ["product:read"],
  "member:read": ["product:read"],
  "billing:read": ["product:read"],
  "project:write": ["product:write"],
  "content:write": ["product:write"],
  "asset:write": ["product:write"],
  "member:write": ["product:write"],
  "platform:generate": ["product:write"],
  "platform:import": ["product:write"],
  "platform:ai_chat": ["product:write"],
  "content:publish": ["product:write"],
  // 删除项目是对外影响最大的动作，要求店主级动作码（shop:settings）。
  "project:delete": ["shop:settings"],
};

/**
 * 判定云购会话是否允许某个内容平台权限点。
 * @param {{merchant?: {isSuper?: boolean, actions?: string[]}|null}} identity
 * @param {string} action
 * @returns {{allowed: boolean, reason: string}}
 */
export function merchantCan(identity, action) {
  const merchant = identity?.merchant;
  if (!merchant) return { allowed: false, reason: "身份不含云购会话" };
  if (merchant.isSuper) return { allowed: true, reason: "云购超级管理员，放行全部动作" };
  const required = CONTENT_ACTION_MERCHANT_ACTIONS[String(action || "")];
  if (!required) return { allowed: false, reason: `未定义权限点 ${action || "(空)"} 对应的云购动作码` };
  const granted = new Set((merchant.actions || []).map(String));
  const missing = required.filter((code) => !granted.has(code));
  if (missing.length) {
    return { allowed: false, reason: `云购会话缺少动作码：${missing.join(", ")}` };
  }
  return { allowed: true, reason: `云购会话具备动作码：${required.join(", ")}` };
}

function isTenantActive(status) {
  return status === 1 || status === true || status === "1";
}

/**
 * 向云购校验商家会话。
 *
 * @param {object} params
 * @param {string} params.token 云购商家 token
 * @param {string|null} params.url 校验地址
 * @param {number} [params.timeoutMs]
 * @param {typeof fetch} [params.fetchImpl] 测试注入
 * @returns {Promise<object>} 成功：`{ok: true, tenantId, staffId, staffName, isSuper, actions}`
 *   失败：`{ok: false, reason}`
 */
export async function verifyMerchantSession({
  token,
  url,
  timeoutMs = MERCHANT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const accessToken = String(token || "").trim();
  if (!accessToken) return { ok: false, reason: "missing-token" };
  if (!url) return { ok: false, reason: "not-configured" };

  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        // 云购同时认 `token` 头和 `Authorization: Bearer`（utils/token.py:_extract_token），
        // 两个都发，避免上游改一种写法就整条链路失效。
        token: accessToken,
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, reason: "unreachable", detail: String(error?.message || error) };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  const upstreamStatus = payload && typeof payload.status !== "undefined"
    ? Number(payload.status)
    : response.status;
  if (!response.ok || upstreamStatus !== 200 || !payload?.data) {
    return {
      ok: false,
      reason: "invalid-session",
      httpStatus: response.status,
      upstreamStatus,
      upstreamMessage: typeof payload?.msg === "string" ? payload.msg : null,
    };
  }

  const data = payload.data;
  const tenant = data.tenant || {};
  const staff = data.user || {};
  const tenantId = String(tenant.id ?? tenant.tenant_id ?? staff.tenant_id ?? "").trim();
  const staffId = String(staff.id ?? staff.staff_id ?? "").trim();
  if (!tenantId || !staffId) return { ok: false, reason: "incomplete-session" };

  // 无法确认租户状态时同样拒绝：宁可让运维补字段，也不放行一个可能已停用的店铺。
  if (!isTenantActive(tenant.status)) {
    return { ok: false, reason: "tenant-inactive", tenantStatus: tenant.status ?? null };
  }

  const permissions = data.permissions || {};
  return {
    ok: true,
    tenantId,
    staffId,
    staffName: String(staff.nick_name || staff.name || "").trim() || null,
    isSuper: Boolean(permissions.is_super),
    actions: Array.isArray(permissions.actions) ? permissions.actions.map(String) : [],
  };
}
