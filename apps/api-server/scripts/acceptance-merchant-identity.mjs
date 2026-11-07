/**
 * 进程级端到端验收：真实 api-server 进程 + 假云购 + 隔离 PostgreSQL。
 *
 * 与测试文件不同，这里跑的是 `node src/server.js` 本身（含 listen、中间件顺序、
 * 环境变量解析），而不是 `buildApp`。用来给出「实际运行」的证据。
 *
 * 用法：
 *   $env:DATABASE_URL = "postgres://.../隔离库"
 *   node scripts/acceptance-merchant-identity.mjs
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.ACCEPTANCE_PORT || 55991);
const BASE = `http://127.0.0.1:${PORT}`;

if (!DATABASE_URL) {
  console.error("需要 DATABASE_URL（指向隔离/临时库）");
  process.exit(2);
}

function fakeMerchant() {
  const sessions = {
    "tok-good": {
      status: 200,
      data: {
        user: { id: 11, name: "staff_a", tenant_id: 7 },
        tenant: { id: 7, name: "甲店铺", status: 1 },
        permissions: { is_super: false, actions: ["product:read", "product:write"] },
      },
    },
    "tok-readonly": {
      status: 200,
      data: {
        user: { id: 12, name: "staff_v", tenant_id: 7 },
        tenant: { id: 7, name: "甲店铺", status: 1 },
        permissions: { is_super: false, actions: ["product:read"] },
      },
    },
    "tok-unmapped": {
      status: 200,
      data: {
        user: { id: 31, name: "staff_u", tenant_id: 9 },
        tenant: { id: 9, name: "丙店铺", status: 1 },
        permissions: { is_super: false, actions: ["product:read", "product:write"] },
      },
    },
  };
  const server = createServer((request, response) => {
    const token = String(request.headers.token || "");
    const payload = sessions[token] || { status: 401, msg: "token 无效或已过期", data: null };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return response.json();
    } catch {
      // 还没起来，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("api-server 未在预期时间内就绪");
}

async function call(method, urlPath, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { status: response.status, body: payload };
}

async function main() {
  const { server: merchant, url: merchantUrl } = await fakeMerchant();

  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      DATABASE_URL,
      MERCHANT_IDENTITY_URL: merchantUrl,
      API_PORT: String(PORT),
      API_HOST: "127.0.0.1",
      AUTH_MODE: "",
      DATA_HUB_URL: "",
      AI_ORCHESTRATOR_BASE_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  try {
    const health = await waitForHealth();
    console.log("health.projectsRepository:", health.data.projectsRepository);
    console.log("health.workflowRepository:", health.data.workflowRepository);
    console.log("health.databaseMode:", health.data.databaseMode);
    console.log("health.merchantLinksRepository:", health.data.merchantLinksRepository);
    console.log("health.authMode:", health.data.authMode, "| authModeRaw:", health.data.authModeRaw);
    console.log("health.identitySource:", health.data.identitySource);
    console.log("health.identityConfigured:", health.data.identityConfigured);

    // 1) 无 token → 401（不回落到演示身份）
    const noToken = await call("GET", "/api/projects");
    console.log("no-token read:", noToken.status, noToken.body?.code);

    // 2) 有效会话但无映射 → 403（用一个从未写入映射的员工身份）
    const unmapped = await call("GET", "/api/projects", { token: "tok-unmapped" });
    console.log("unmapped read:", unmapped.status, unmapped.body?.code);

    // 3) 运维写入映射后 → 读 200 / 写 201，且归属是映射目标用户（不是 user_demo）
    const MAPPED_USER = "user_acceptance_a";
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `insert into content_platform.users(id, user_no, username, status)
       values ($1, $2, $3, 'active') on conflict (id) do nothing`,
      [MAPPED_USER, `U_ACC_${Date.now()}`, "验收映射用户"],
    );
    await pool.query(
      `insert into content_platform.merchant_links(
         id, merchant_tenant_id, merchant_staff_id, content_user_id, created_by, note
       ) values ($1,$2,$3,$4,$5,$6)
       on conflict (merchant_tenant_id, merchant_staff_id)
       do update set content_user_id = excluded.content_user_id, status = 'active'`,
      ["mlink_acceptance_a", "7", "11", MAPPED_USER, "acceptance-script", "进程级验收"],
    );
    await pool.query(
      `insert into content_platform.merchant_links(
         id, merchant_tenant_id, merchant_staff_id, content_user_id, created_by, note
       ) values ($1,$2,$3,$4,$5,$6)
       on conflict (merchant_tenant_id, merchant_staff_id)
       do update set content_user_id = excluded.content_user_id, status = 'active'`,
      ["mlink_acceptance_v", "7", "12", MAPPED_USER, "acceptance-script", "只读账号"],
    );
    await pool.end();

    const mappedRead = await call("GET", "/api/projects", { token: "tok-good" });
    console.log("mapped read:", mappedRead.status);

    const name = `进程级验收项目 ${Date.now()}`;
    const mappedWrite = await call("POST", "/api/projects", { body: { name }, token: "tok-good" });
    console.log("mapped write:", mappedWrite.status, "ownerUserId:", mappedWrite.body?.data?.ownerUserId);
    if (mappedWrite.body?.data?.ownerUserId !== MAPPED_USER) {
      throw new Error(`归属错误：期望 ${MAPPED_USER}，实际 ${mappedWrite.body?.data?.ownerUserId}`);
    }

    // 4) 动作码不足 → 写 403
    const readonlyWrite = await call("POST", "/api/projects", {
      body: { name: "只读账号项目" },
      token: "tok-readonly",
    });
    console.log("readonly write:", readonlyWrite.status, readonlyWrite.body?.code);

    // 5) 伪造身份头无效（服务端剥离 X-Content-User-Id / X-User-Id / X-Content-Role）
    const forgedResponse = await fetch(`${BASE}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok-good",
        "X-Content-User-Id": "user_admin",
        "X-User-Id": "user_admin",
        "X-Content-Role": "owner",
      },
      body: JSON.stringify({ name: "伪造归属" }),
    });
    const forged = { status: forgedResponse.status, body: await forgedResponse.json() };
    console.log("forged header write:", forged.status, "ownerUserId:", forged.body?.data?.ownerUserId);
    if (forged.body?.data?.ownerUserId !== MAPPED_USER) {
      throw new Error(`伪造头被采信了：归属 ${forged.body?.data?.ownerUserId}`);
    }

    // 6) 会话失效 → 401
    const badToken = await call("GET", "/api/projects", { token: "tok-bogus" });
    console.log("invalid session read:", badToken.status, badToken.body?.code);
  } finally {
    child.kill();
    await new Promise((resolve) => merchant.close(resolve));
    const noise = logs.join("").split("\n").filter((line) => line.trim() && !line.includes("listening"));
    if (noise.length) console.log("server logs:", noise.slice(-5).join(" | "));
  }
}

main().catch((error) => {
  console.error("acceptance failed:", error.message);
  process.exit(1);
});
