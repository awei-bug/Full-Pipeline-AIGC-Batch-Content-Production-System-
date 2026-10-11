import crypto from "node:crypto";

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, passwordHash) {
  const [salt, stored] = String(passwordHash || "").split(":");
  if (!salt || !stored) {
    return false;
  }
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  if (hash.length !== stored.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(stored, "hex"));
}

export function createSessionToken() {
  return `sess_${crypto.randomBytes(24).toString("hex")}`;
}

export function sessionExpiry(now = Date.now()) {
  return new Date(now + TOKEN_TTL_MS).toISOString();
}

export function getBearerToken(request) {
  const header = String(request.headers.authorization || "");
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return String(request.headers["x-session-token"] || "").trim();
}
