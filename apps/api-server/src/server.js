import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { projectsRouter } from "./routes/projects.js";
import { creationRequestsRouter } from "./routes/creation-requests.js";
import { chatRouter } from "./routes/chat.js";
import { contentWorkflowsRouter } from "./routes/content-workflows.js";
import { tasksRouter } from "./routes/tasks.js";
import { worksRouter } from "./routes/works.js";
import { importBatchesRouter } from "./routes/import-batches.js";
import { productsRouter } from "./routes/products.js";
import { contentJobsRouter } from "./routes/content-jobs.js";
import { contentOutputsRouter } from "./routes/content-outputs.js";
import { contentExportsRouter } from "./routes/content-exports.js";
import { batchItemEventsRouter } from "./routes/batch-item-events.js";
import { orchestratorEventsRouter } from "./routes/orchestrator-events.js";
import { listingPacksRouter } from "./routes/listing-packs.js";
import { dataHubRouter } from "./routes/data-hub.js";
import { createListingPackService } from "./services/listing-pack-service.js";
import { createDataHubSyncService } from "./services/data-hub-sync-service.js";
import { createCommerceIntegrationClient } from "./lib/commerce-integration-client.js";
import { createDataHubClient } from "./lib/data-hub-client.js";
import { createPool, hasDatabaseConfig } from "./lib/database.js";
import { createAiOrchestratorClient, hasAiOrchestratorConfig } from "./lib/ai-orchestrator-client.js";
import { ipContentRouter } from "./routes/ip-content.js";
import { authRouter } from "./routes/auth.js";
import { membersRouter } from "./routes/members.js";
import { createIdentityMiddleware, resolveAuthMode } from "./lib/identity.js";
import { verifyToken } from "./lib/local-auth.js";
import { createUsersRepository } from "./repositories/users-repository.js";
import { MemoryProjectsRepository, PostgresProjectsRepository } from "./repositories/projects-repository.js";
import {
  MemoryImportBatchesRepository,
  PostgresImportBatchesRepository,
} from "./repositories/import-batches-repository.js";
import {
  MemoryProductsRepository,
  PostgresProductsRepository,
} from "./repositories/products-repository.js";
import {
  MemoryContentJobsRepository,
  PostgresContentJobsRepository,
} from "./repositories/content-jobs-repository.js";
import { MemoryWorkflowRepository, PostgresWorkflowRepository } from "./repositories/workflow-repository.js";

export async function buildApp({ env = process.env } = {}) {
  const app = express();
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFilePath);
  const assetsDir =
    env.AI_ORCHESTRATOR_ASSETS_DIR ||
    env.LOCAL_ASSETS_DIR ||
    path.resolve(currentDir, "../../../storage/generated");
  const dbConfigured = hasDatabaseConfig(env);
  const aiOrchestratorConfigured = hasAiOrchestratorConfig(env);
  const pool = createPool(env);
  const projectsRepository = pool ? new PostgresProjectsRepository(pool) : new MemoryProjectsRepository();
  const importBatchesRepository = pool
    ? new PostgresImportBatchesRepository(pool)
    : new MemoryImportBatchesRepository();
  const productsRepository = pool
    ? new PostgresProductsRepository(pool)
    : new MemoryProductsRepository(importBatchesRepository);
  const contentJobsRepository = pool
    ? new PostgresContentJobsRepository(pool, productsRepository)
    : new MemoryContentJobsRepository(productsRepository);
  const workflowRepository = pool ? new PostgresWorkflowRepository(pool) : new MemoryWorkflowRepository();
  const usersRepository = createUsersRepository(pool);
  const aiOrchestratorClient = createAiOrchestratorClient(env);
  const listingPackService = createListingPackService({
    repository: contentJobsRepository,
    assetsDir,
  });

  const dataHubClient = createDataHubClient(env);
  const dataHubSyncService = dataHubClient
    ? createDataHubSyncService({ listingPackService, dataHubClient, repository: contentJobsRepository })
    : null;

  app.locals.listingPackService = listingPackService;
  app.locals.dataHubClient = dataHubClient;
  app.locals.dataHubSyncService = dataHubSyncService;
  app.locals.commerceIntegrationClient = createCommerceIntegrationClient(env);
  app.locals.pool = pool;
  app.locals.projectsRepository = projectsRepository;
  app.locals.importBatchesRepository = importBatchesRepository;
  app.locals.productsRepository = productsRepository;
  app.locals.contentJobsRepository = contentJobsRepository;
  app.locals.workflowRepository = workflowRepository;
  app.locals.aiOrchestratorClient = aiOrchestratorClient;
  app.locals.usersRepository = usersRepository;
  // 路由层需要读 AUTH_MODE / AUTH_SECRET；显式挂到 locals，避免各处直接摸 process.env。
  app.locals.env = env;

  app.use(cors());
  app.use("/api/ip-content", express.json({ limit: "2mb" }));
  app.use(express.json());
  app.use("/storage/assets", express.static(assetsDir));

  // 身份解析必须早于所有业务路由：下游用 request.identity 决定数据归属。
  // AUTH_MODE 默认 off —— 沿用旧的"所有请求都是演示用户"行为，不破坏双击启动。
  app.use(
    createIdentityMiddleware({
      env,
      verifyToken: (token) => verifyToken(token, { secret: env.AUTH_SECRET }),
    }),
  );

  app.get("/api/health", (_request, response) => {
    response.json({
      code: "SUCCESS",
      message: "成功",
      data: {
        service: "api-server",
        status: "up",
        mode: "stage-two-bootstrap",
        projectsRepository: projectsRepository.mode,
        workflowRepository: workflowRepository.mode,
        databaseConfigured: dbConfigured,
        aiOrchestratorConfigured,
        aiOrchestratorMode: aiOrchestratorClient?.mode || "disabled",
        commercePushConfigured: Boolean(app.locals.commerceIntegrationClient),
        commercePushTenant: app.locals.commerceIntegrationClient?.target?.tenantSlug || null,
        dataHubConfigured: Boolean(dataHubClient),
        dataHubTarget: dataHubClient?.target?.baseUrl || null,
        // 前端靠这个字段决定要不要显示登录界面。不让前端自己读环境变量：
        // 构建产物与后端配置可能不同步，问后端才准。
        authMode: resolveAuthMode(env),
      },
    });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/projects", projectsRouter);
  // 成员与角色管理挂在 /api/projects 之下，路径与资源层级一致
  // （/api/projects/:projectId/members）。角色清单是 /api/projects/roles，
  // 必须在 /api/projects/:id 之类的前缀路由之前注册，因此单独挂在这里。
  app.use("/api/projects", membersRouter);
  app.use("/api/import-batches", importBatchesRouter);
  app.use("/api/products", productsRouter);
  app.use("/api/content-jobs", contentJobsRouter);
  app.use("/api/content-outputs", contentOutputsRouter);
  app.use("/api/content-exports", contentExportsRouter);
  app.use("/api/listing-packs", listingPacksRouter);
  app.use("/api/data-hub", dataHubRouter);
  app.use("/api/creation-requests", creationRequestsRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/content-workflows", contentWorkflowsRouter);
  app.use("/api/ip-content", ipContentRouter);
  app.use("/api/tasks", tasksRouter);
  app.use("/api/works", worksRouter);
  app.use("/internal/orchestrator", orchestratorEventsRouter);
  app.use("/internal/batch-items/events", batchItemEventsRouter);

  app.use((error, _request, response, _next) => {
    const statusCode = Number(error?.statusCode || error?.status);
    const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
      ? statusCode
      : 500;
    response.status(status).json({
      code: error?.code || (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR"),
      message: error?.message || "服务异常",
      data: null,
    });
  });

  if (pool) {
    await pool.query("select 1");
  }

  return app;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const port = Number(process.env.API_PORT || 3100);
  const host = process.env.API_HOST || "127.0.0.1";

  try {
    const app = await buildApp();
    app.listen(port, host, () => {
      console.log(`api-server listening on http://${host}:${port}`);
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
