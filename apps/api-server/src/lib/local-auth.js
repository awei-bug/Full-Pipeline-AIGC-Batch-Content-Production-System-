/**
 * 本地签发/校验 token（内容平台，零第三方依赖）。
 *
 * 为什么不用 jsonwebtoken
 * ---------------------
 * apps/data-hub 是零依赖实现（标准库 http.server + sqlite3），api-server 的依赖也
 * 刻意保持精简。签发一个"带用户名和过期时间、服务端能验签"的 token，用 node:crypto
 * 的 HMAC 十几行就够，引入 JWT 库反而增加供应链面和版本维护成本。
 *
 * 格式（刻意接近 JWS 但不宣称兼容）
 * ------------------------------
 *   base64url(header).base64url(payload).base64url(signature)
 *   header  = {"alg":"HS256","typ":"DSH-TOKEN"}
 *   payload = {"sub": userId, "tenant": tenantId, "iat": 秒, "exp": 秒}
 *   signature = HMAC-SHA256(header + "." + payload, secret)
 *
 * 安全取舍
 * -------
 * - **签名覆盖 header**：只签 payload 会让攻击者改 header 里的 alg（alg:none 类攻击）。
 * - **constant-time 比较**：用 timingSafeEqual，避免按字节比较泄漏签名前缀。
 * - **必须显式配置 secret**：`AUTH_SECRET` 为空时拒绝签发（fail-closed），
 *   而不是用某个默认值——默认密钥等于没有密钥。
 * - **不做 refresh token / 黑名单**：本地用户体系先解决"请求是谁"，
 *   会话吊销需要持久化存储与并发访问，留给后续；因此 token 有效期刻意设短。
 */

import crypto from "node:crypto";

const TOKEN_TYPE = "DSH-TOKEN";
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

function b64urlEncode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(text) {
  const normalized = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, "base64");
}

function sign(headerSegment, payloadSegment, secret) {
  return b64urlEncode(
    crypto.createHmac("sha256", secret).update(`${headerSegment}.${payloadSegment}`).digest(),
  );
}

export class AuthConfigError extends Error {}

/**
 * 签发 token。
 * @param {{sub: string, tenant?: string|null, ttlSeconds?: number}} claims
 * @param {{secret: string, now?: () => number}} options
 */
export function signToken(claims, { secret, now = () => Date.now() } = {}) {
  if (!secret || String(secret).length < 16) {
    // fail-closed：弱密钥比没有密钥更危险，因为它给人"已经安全了"的错觉。
    throw new AuthConfigError("AUTH_SECRET 未配置或长度不足 16 位，拒绝签发 token");
  }
  if (!claims?.sub) throw new AuthConfigError("token 必须包含 sub（用户 id）");

  const issuedAt = Math.floor(now() / 1000);
  const ttl = Number(claims.ttlSeconds) > 0 ? Number(claims.ttlSeconds) : DEFAULT_TTL_SECONDS;
  const header = { alg: "HS256", typ: TOKEN_TYPE };
  const payload = {
    sub: String(claims.sub),
    tenant: claims.tenant ? String(claims.tenant) : null,
    iat: issuedAt,
    exp: issuedAt + ttl,
  };

  const headerSegment = b64urlEncode(JSON.stringify(header));
  const payloadSegment = b64urlEncode(JSON.stringify(payload));
  const signature = sign(headerSegment, payloadSegment, secret);
  return `${headerSegment}.${payloadSegment}.${signature}`;
}

/**
 * 校验 token。失败返回 null（由调用方决定 401 文案），不抛异常——
 * 鉴权失败是常态分支，不该用异常做控制流。
 */
export function verifyToken(token, { secret, now = () => Date.now() } = {}) {
  if (!secret) return null;
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [headerSegment, payloadSegment, signature] = parts;

  const expected = sign(headerSegment, payloadSegment, secret);
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  // 长度不等时 timingSafeEqual 会抛错，必须先比长度再比内容。
  if (given.length !== wanted.length) return null;
  if (!crypto.timingSafeEqual(given, wanted)) return null;

  let header;
  let payload;
  try {
    header = JSON.parse(b64urlDecode(headerSegment).toString("utf8"));
    payload = JSON.parse(b64urlDecode(payloadSegment).toString("utf8"));
  } catch {
    return null;
  }

  // 拒绝 alg 被改写：只接受我们自己签的算法标识。
  if (header?.alg !== "HS256" || header?.typ !== TOKEN_TYPE) return null;
  if (!payload?.sub) return null;

  const nowSeconds = Math.floor(now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;

  return {
    sub: String(payload.sub),
    tenant: payload.tenant || null,
    iat: payload.iat,
    exp: payload.exp,
  };
}
