/**
 * 请求身份解析（内容平台 identity 层）。
 *
 * 现状与目标
 * ----------
 * 数据库 schema 里早就有 `content_platform.users` / `projects` / `project_members` /
 * `credit_accounts`，甚至种了 `user_demo`，但 API 层把所有请求都当成同一个演示用户
 * （`projects-repository.js` / `workflow-repository.js` 里写死的 `DEMO_OWNER_USER_ID`）。
 * 结果是：项目、额度、作品全部无法按用户隔离，也无法对外交付——任何一个访客都等同于
 * 演示用户。
 *
 * 本模块只解决"这个请求是谁"，不解决"他能做什么"（权限矩阵留给后续）。
 *
 * 三种模式（`AUTH_MODE`）
 * ----------------------
 * - `off`（默认）：完全沿用旧行为，所有请求都解析为 `user_demo`。
 *   这是**刻意的向后兼容**：本地开发、桌面快捷方式启动、既有测试和脚本都不需要改。
 * - `local`：接受 `Authorization: Bearer <token>`，token 由本地 users 表签发
 *   （见 `lib/local-auth.js`）。无 token 时降级为匿名，**不**回落到演示用户。
 * - `strict`：必须带有效 token，否则 401。用于对外暴露的部署。
 *
 * 为什么默认是 off 而不是 local
 * ----------------------------
 * 这个项目的启动方式包括双击桌面图标 / `一键启动.bat`，用户不会先去登录。默认强制鉴权
 * 会让现有使用方式直接坏掉。因此把升级做成显式开关，而不是悄悄改变默认行为。
 *
 * 匿名身份的设计
 * ------------
 * `local`/`strict` 模式下的匿名请求使用 `anon_<随机>` 作为 userId，但**不会**写入
 * users 表——匿名用户不能创建项目（业务层校验），避免匿名数据污染正式用户空间。
 */

import crypto from "node:crypto";

export const DEMO_USER_ID = "user_demo";

const AUTH_MODES = new Set(["off", "local", "strict"]);

export function resolveAuthMode(env = process.env) {
  const raw = String(env.AUTH_MODE || "off").trim().toLowerCase();
  return AUTH_MODES.has(raw) ? raw : "off";
}

/**
 * 从请求头取出 bearer token。
 * 只认 `Authorization: Bearer xxx`，不接受 query string 携带——
 * query 会进访问日志、浏览器历史、Referer，是长期凭证泄漏的常见来源。
 */
export function extractBearerToken(request) {
  const header = request?.headers?.authorization || request?.headers?.Authorization || "";
  if (!header) return "";
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : "";
}

/**
 * 构造请求身份对象。
 * @param {object} params
 * @param {string} params.userId 用户 id
 * @param {string} params.tenantId 租户 id（内容平台侧当前只有 slug 概念，可空）
 * @param {"demo"|"user"|"anonymous"} params.kind 身份来源
 */
export function makeIdentity({ userId, tenantId = null, kind = "user" }) {
  if (!userId) throw new Error("identity requires userId");
  return { userId, tenantId, kind };
}

/**
 * Express 中间件：把身份挂到 `request.identity`。
 *
 * 解析顺序：token（local/strict）→ 演示用户（off）→ 匿名（local 无 token）。
 * 解析失败一律 401，绝不"猜"一个身份——猜测会让越权变成静默行为。
 */
export function createIdentityMiddleware({ env = process.env, verifyToken } = {}) {
  const mode = resolveAuthMode(env);

  return function identityMiddleware(request, response, next) {
    request.identityMode = mode;

    if (mode === "off") {
      request.identity = makeIdentity({ userId: DEMO_USER_ID, kind: "demo" });
      return next();
    }

    const token = extractBearerToken(request);
    if (!token) {
      if (mode === "strict") {
        return response.status(401).json({
          code: "UNAUTHORIZED",
          message: "需要登录后才可访问",
          data: null,
        });
      }
      request.identity = makeIdentity({
        userId: `anon_${crypto.randomUUID().slice(0, 12)}`,
        kind: "anonymous",
      });
      return next();
    }

    let claims = null;
    try {
      claims = verifyToken ? verifyToken(token) : null;
    } catch {
      claims = null;
    }
    if (!claims || !claims.sub) {
      return response.status(401).json({
        code: "INVALID_TOKEN",
        message: "登录已失效，请重新登录",
        data: null,
      });
    }

    request.identity = makeIdentity({
      userId: claims.sub,
      tenantId: claims.tenant || null,
      kind: "user",
    });
    return next();
  };
}

/**
 * 业务层取身份。测试或脚本在无 Express 上下文时可直接传入一个 identity。
 */
export function requireIdentity(request, fallback = null) {
  if (request?.identity?.userId) return request.identity;
  if (fallback?.userId) return fallback;
  throw Object.assign(new Error("缺少请求身份"), { statusCode: 401, code: "UNAUTHORIZED" });
}

/**
 * 取"可写入的"用户 id：匿名身份不允许创建项目/额度账户。
 * 返回 null 表示调用方应拒绝该操作。
 */
export function writableUserId(identity) {
  if (!identity?.userId) return null;
  if (identity.kind === "anonymous") return null;
  return identity.userId;
}
