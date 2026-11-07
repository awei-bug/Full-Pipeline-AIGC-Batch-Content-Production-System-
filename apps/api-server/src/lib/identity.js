/**
 * 请求身份解析（内容平台 identity 层）。
 *
 * 唯一身份源：云购商家会话
 * ----------------------
 * 用户已拍板：内容平台的正式鉴权由**云购签发的会话**驱动身份。因此默认运行态是
 * `merchant`：每个请求的 token 都实时向云购 `/user/me/` 校验，再由
 * `content_platform.merchant_links` 把「云购租户/员工」映射成内容平台用户。
 * 前端**不能**自行声明用户或项目归属——请求里的 `X-Content-User-Id` /
 * `X-User-Id` / `X-Content-Role` 之类的头一律被剥离，服务端只认云购的校验结果。
 *
 * 为什么 `off` 不再是默认
 * ---------------------
 * 早期默认 `off`（所有请求都是 `user_demo`）是为了兼容双击启动的本地演示。但那意味着
 * 任何未登录访客都等同演示用户，且项目、额度、作品完全无法按人隔离。现在把它降级为
 * **显式开启的本地演示后门**：只有运维主动写 `AUTH_MODE=off` 才生效，未配置统一身份时
 * 一律拒绝访问，绝不静默回落到演示身份。
 *
 * 模式（`AUTH_MODE`）
 * ------------------
 * - `merchant`（默认）：云购会话校验 + 显式映射。未配置 `MERCHANT_IDENTITY_URL`
 *   时返回 503（配置缺失是运维问题，不是凭证问题，要能区分）。
 * - `off`：显式本地演示后门，所有请求解析为 `user_demo`。
 * - `local`：本地 users 表签发的 token（`lib/local-auth.js`），开发期遗留。
 * - `strict`：必须带有效本地 token，否则 401。
 *
 * `local` / `strict` 保留是为了不破坏既有测试与本地脚本；它们**不是**生产路径，
 * 云购会话与它们互不相认（各自 id 空间不同）。
 *
 * 映射缺失必须拒绝
 * --------------
 * 云购校验通过但查不到映射时返回 403 `IDENTITY_NOT_MAPPED`，**不会**自动建一条映射，
 * 也不会回落到 `user_demo`。猜测关联会让 A 商家看到 B 商家的项目，这是本项目
 * 最不能出的问题。
 */

import crypto from "node:crypto";

import {
  merchantCan,
  resolveMerchantIdentityUrl,
  resolveMerchantTimeoutMs,
  verifyMerchantSession,
} from "./merchant-identity.js";

export const DEMO_USER_ID = "user_demo";

/** 默认模式：云购会话。刻意不叫 off —— 默认必须是「要身份」。 */
export const DEFAULT_AUTH_MODE = "merchant";

const AUTH_MODES = new Set(["merchant", "off", "local", "strict"]);

/** 前端可能用来「自称身份」的头。服务端一个都不认，解析前统一剥离。 */
const IDENTITY_OVERRIDE_HEADERS = [
  "x-content-user-id",
  "x-user-id",
  "x-content-role",
  "x-merchant-staff-id",
  "x-merchant-tenant-id",
];

export function resolveAuthMode(env = process.env) {
  const raw = String(env.AUTH_MODE || "").trim().toLowerCase();
  if (!raw) return DEFAULT_AUTH_MODE;
  return AUTH_MODES.has(raw) ? raw : DEFAULT_AUTH_MODE;
}

/**
 * 给前端看的 `authMode`。
 *
 * 前端（`apps/studio-web/src/session.js: detectAuthMode`）只认 `off` / `local` / `strict`，
 * 其余值一律回落成 `off`——也就是"当成演示模式、不要求登录"。若 health 直接报
 * `merchant`，前端会静默退回演示 UI，这恰好是本次改造要消灭的行为。
 *
 * 因此 health 里的 `authMode` 保持既有取值域：云购会话模式对外呈现为 `strict`
 * （语义一致：必须带有效会话，否则 401），真实来源另用 `identitySource` 说明。
 * 前端契约不被破坏，同时绝不会被当成 `off`。
 */
export function healthAuthMode(env = process.env) {
  const mode = resolveAuthMode(env);
  return mode === "merchant" ? "strict" : mode;
}

/**
 * 从请求头取出 bearer token。
 * 只认 `Authorization: Bearer xxx`，不接受 query string 携带——
 * query 会进访问日志、浏览器历史、Referer，是长期凭证泄漏的常见来源。
 *
 * 云购客户端历史上用裸 `token` 头（`flask_shop/utils/token.py:_extract_token`），
 * 因此额外接受 `token` 头，其余来源一律不认。
 */
export function extractBearerToken(request) {
  const header = request?.headers?.authorization || request?.headers?.Authorization || "";
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
    if (match) return match[1].trim();
  }
  const legacy = request?.headers?.token || request?.headers?.Token || "";
  return String(legacy || "").trim();
}

/**
 * 构造请求身份对象。
 * @param {object} params
 * @param {string} params.userId 内容平台用户 id
 * @param {string} params.tenantId 租户 id（merchant 模式下是云购租户 id）
 * @param {"demo"|"user"|"anonymous"} params.kind 身份来源
 * @param {object|null} [params.merchant] 云购会话摘要（仅 merchant 模式）
 */
export function makeIdentity({ userId, tenantId = null, kind = "user", merchant = null }) {
  if (!userId) throw new Error("identity requires userId");
  return { userId, tenantId, kind, merchant };
}

function unauthorized(response, code, message) {
  return response.status(401).json({ code, message, data: null });
}

/**
 * Express 中间件：把身份挂到 `request.identity`。
 *
 * 解析失败一律拒绝，绝不「猜」一个身份——猜测会让越权变成静默行为。
 */
export function createIdentityMiddleware({
  env = process.env,
  verifyToken,
  verifyMerchant = verifyMerchantSession,
} = {}) {
  const mode = resolveAuthMode(env);

  return async function identityMiddleware(request, response, next) {
    request.identityMode = mode;

    // 先剥离「自称身份」的请求头，避免下游任何代码误用它们。
    for (const name of IDENTITY_OVERRIDE_HEADERS) {
      if (request.headers && Object.prototype.hasOwnProperty.call(request.headers, name)) {
        delete request.headers[name];
      }
    }

    if (mode === "off") {
      request.identity = makeIdentity({ userId: DEMO_USER_ID, kind: "demo" });
      return next();
    }

    const token = extractBearerToken(request);

    if (mode === "merchant") {
      try {
        if (!token) {
          return unauthorized(response, "UNAUTHORIZED", "需要云购商家登录后才可访问");
        }

        const url = resolveMerchantIdentityUrl(env);
        if (!url) {
          // 配置缺失：503 而不是 401。凭证没问题、服务没配好，两者要能区分。
          return response.status(503).json({
            code: "IDENTITY_NOT_CONFIGURED",
            message: "统一身份未配置（MERCHANT_IDENTITY_URL 缺失），已拒绝访问",
            data: null,
          });
        }

        const session = await verifyMerchant({
          token,
          url,
          timeoutMs: resolveMerchantTimeoutMs(env),
        });

        if (!session.ok) {
          if (session.reason === "not-configured") {
            return response.status(503).json({
              code: "IDENTITY_NOT_CONFIGURED",
              message: "统一身份未配置（MERCHANT_IDENTITY_URL 缺失），已拒绝访问",
              data: null,
            });
          }
          if (session.reason === "unreachable") {
            return response.status(503).json({
              code: "IDENTITY_UNAVAILABLE",
              message: "云购身份服务暂不可用，请稍后重试",
              data: null,
            });
          }
          if (session.reason === "tenant-inactive") {
            return response.status(403).json({
              code: "TENANT_INACTIVE",
              message: "云购店铺当前不可用，已拒绝访问",
              data: null,
            });
          }
          return unauthorized(response, "INVALID_TOKEN", "云购登录已失效，请重新登录");
        }

        const links = request.app?.locals?.merchantLinksRepository;
        if (!links?.findLink) {
          return response.status(503).json({
            code: "IDENTITY_NOT_CONFIGURED",
            message: "商家映射仓储未初始化，已拒绝访问",
            data: null,
          });
        }

        const link = await links.findLink({
          merchantTenantId: session.tenantId,
          merchantStaffId: session.staffId,
        });
        if (!link) {
          // 映射缺失：明确拒绝，并给出可操作的提示，但不暴露任何其他商家的信息。
          return response.status(403).json({
            code: "IDENTITY_NOT_MAPPED",
            message: "该云购账号尚未映射到内容平台账号，请联系管理员开通",
            data: null,
          });
        }

        request.identity = makeIdentity({
          userId: link.contentUserId,
          tenantId: session.tenantId,
          kind: "user",
          merchant: {
            tenantId: session.tenantId,
            staffId: session.staffId,
            staffName: session.staffName || null,
            isSuper: session.isSuper,
            actions: session.actions,
          },
        });
        return next();
      } catch (error) {
        return next(error);
      }
    }

    // ---- 以下为开发期遗留的本地 token 模式 ----
    if (!token) {
      if (mode === "strict") {
        return unauthorized(response, "UNAUTHORIZED", "需要登录后才可访问");
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
      return unauthorized(response, "INVALID_TOKEN", "登录已失效，请重新登录");
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
 * 取「可写入的」用户 id：匿名身份不允许创建项目/额度账户。
 * 返回 null 表示调用方应拒绝该操作。
 */
export function writableUserId(identity) {
  if (!identity?.userId) return null;
  if (identity.kind === "anonymous") return null;
  return identity.userId;
}

/**
 * 云购动作码校验（与项目角色是「且」的关系）。
 * 只在 merchant 模式下生效：本地 token 模式没有云购会话，无动作码可比。
 * @returns {{allowed: boolean, reason?: string}}
 */
export function evaluateMerchantActions(request, action) {
  if ((request?.identityMode || DEFAULT_AUTH_MODE) !== "merchant") return { allowed: true };
  return merchantCan(request.identity, action);
}
