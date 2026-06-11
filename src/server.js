import Fastify from "fastify";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { appRoutes } from "./routes.js";
import { createStore } from "./store.js";
import { TaskOrchestrator } from "./task-orchestrator.js";
import { buildProviders } from "./providers/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const storageDir = path.join(rootDir, "storage");
const assetsDir = path.join(storageDir, "assets");
const tempDir = path.join(storageDir, "temp");
const dataDir = path.join(rootDir, "data");
const dbFile = path.join(dataDir, "platform-db.json");

async function ensureDirs() {
  await Promise.all([
    fs.mkdir(publicDir, { recursive: true }),
    fs.mkdir(storageDir, { recursive: true }),
    fs.mkdir(assetsDir, { recursive: true }),
    fs.mkdir(tempDir, { recursive: true }),
    fs.mkdir(dataDir, { recursive: true }),
  ]);
}

async function buildServer() {
  await ensureDirs();

  const fastify = Fastify({
    logger: true,
  });

  await fastify.register(formbody);
  await fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
  });
  await fastify.register(fastifyStatic, {
    root: storageDir,
    prefix: "/storage/",
    decorateReply: false,
  });

  const store = await createStore({
    dbFile,
    env: process.env,
  });
  const providers = buildProviders({
    assetsDir,
    env: process.env,
  });

  const orchestrator = new TaskOrchestrator({
    store,
    baseUrl: process.env.APP_BASE_URL || "http://127.0.0.1:3000",
    providers,
  });

  await orchestrator.recover();

  fastify.decorate("store", store);
  fastify.decorate("orchestrator", orchestrator);

  await fastify.register(appRoutes);

  fastify.get("/api/v1/health", async () => ({
    code: "SUCCESS",
    message: "成功",
    requestId: crypto.randomUUID(),
    data: {
      status: "up",
      mode: "demo",
      storage: store.backend,
      providers: orchestrator.getProviderStatus(),
    },
  }));

  fastify.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/api/") || request.raw.url?.startsWith("/storage/")) {
      reply.code(404).send({
        code: "NOT_FOUND",
        message: "资源不存在",
        requestId: request.id,
        data: null,
      });
      return;
    }

    reply.sendFile("index.html");
  });

  return fastify;
}

const server = await buildServer();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

try {
  await server.listen({ port, host });
  server.log.info(`Server listening on http://${host}:${port}`);
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
