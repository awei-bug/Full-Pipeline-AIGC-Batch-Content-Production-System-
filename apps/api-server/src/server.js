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
import { createHubSyncStatusRepository } from "./repositories/hub-sync-status-repository.js";
import { createCommerceIntegrationClient } from "./lib/commerce-integration-client.js";
import { createDataHubClient } from "./lib/data-hub-client.js";
import { createPool, hasDatabaseConfig } from "./lib/database.js";
import { createAiOrchestratorClient, hasAiOrchestratorConfig } from "./lib/ai-orchestrator-client.js";
import { ipContentRouter } from "./routes/ip-content.js";
import { authRouter } from "./routes/auth.js";
import { membersRouter } from "./routes/members.js";
import { createIdentityMiddleware, healthAuthMode, resolveAuthMode } from "./lib/identity.js";
import { hasMerchantIdentityConfig, resolveMerchantIdentityUrl } from "./lib/merchant-identity.js";
import { verifyToken } from "./lib/local-auth.js";
import { createUsersRepository } from "./repositories/users-repository.js";
import { createMerchantLinksRepository } from "./repositories/merchant-links-repository.js";
import { createCreditRepository } from "./repositories/credits-repository.js";
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
  // 云购商家 → 内容平台用户 的显式映射。没有数据库时用内存实现，
  // 但那种情况下也不会有真实商家会话可用（见 /api/health 的 identityConfigured）。
  const merchantLinksRepository = createMerchantLinksRepository(pool);
  // 额度仓储：无数据库时用内存实现（重启丢额度，仅供本地演示）。
  const creditRepository = createCreditRepository(pool, { env });
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
  app.locals.hubSyncStatusRepository = createHubSyncStatusRepository(pool);
  app.locals.commerceIntegrationClient = createCommerceIntegrationClient(env);
  app.locals.pool = pool;
  app.locals.projectsRepository = projectsRepository;
  app.locals.importBatchesRepository = importBatchesRepository;
  app.locals.productsRepository = productsRepository;
  app.locals.contentJobsRepository = contentJobsRepository;
  app.locals.workflowRepository = workflowRepository;
  app.locals.aiOrchestratorClient = aiOrchestratorClient;
  app.locals.usersRepository = usersRepository;
  app.locals.merchantLinksRepository = merchantLinksRepository;
  app.locals.creditRepository = creditRepository;
  // 路由层需要读 AUTH_MODE / AUTH_SECRET；显式挂到 locals，避免各处直接摸 process.env。
  app.locals.env = env;
  app.locals.assetsDir = assetsDir;

  app.use(cors());
  app.use("/api/ip-content", express.json({ limit: "2mb" }));
  app.use(express.json());

  // 健康检查必须**先于**身份中间件：前端靠它探测 authMode，探测本身不可能带凭证。
  // 这里只暴露能力开关，不暴露任何用户数据。
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
        // 身份来源：merchant = 云购会话（正式），off = 显式本地演示后门。
        // authMode 保持前端可识别的取值域（off/local/strict）：云购会话呈现为
        // strict，否则前端会把未知值回落成 off（= 演示模式），等于没改。
        authMode: healthAuthMode(env),
        authModeRaw: resolveAuthMode(env),
        identitySource: resolveAuthMode(env) === "merchant" ? "merchant-session" : "local",
        // 云购校验地址是否已配置。未配置时 merchant 模式一律拒绝访问（503），
        // 把这个事实暴露出来，运维不必翻日志就能判断"是不是少配了变量"。
        identityConfigured: hasMerchantIdentityConfig(env),
        identityEndpoint: resolveMerchantIdentityUrl(env),
        // 映射仓储的实际后端：postgres 才是可审计、可跨进程一致的正式路径。
        merchantLinksRepository: merchantLinksRepository.mode,
        // 项目与工作流仓储后端（验收要求：必须显示 PostgreSQL 而不是内存）。
        databaseMode: pool ? "postgres" : "memory",
      },
    });
  });

  // Direct static URLs have no project identity; retain only in demo mode.
  app.use("/storage/assets", (request, response, next) => {
    if (resolveAuthMode(env) !== "off") return response.status(404).end();
    return next();
  }, express.static(assetsDir));

  // 身份解析必须早于所有业务路由：下游用 request.identity 决定数据归属。
  // 默认模式是 merchant（云购会话）；AUTH_MODE=off 是显式开启的本地演示后门。
  app.use(
    createIdentityMiddleware({
      env,
      verifyToken: (token) => verifyToken(token, { secret: env.AUTH_SECRET }),
    }),
  );

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
