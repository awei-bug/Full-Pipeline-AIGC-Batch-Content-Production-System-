import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { projectsRouter } from "./routes/projects.js";
import { creationRequestsRouter } from "./routes/creation-requests.js";
import { tasksRouter } from "./routes/tasks.js";
import { worksRouter } from "./routes/works.js";
import { importBatchesRouter } from "./routes/import-batches.js";
import { productsRouter } from "./routes/products.js";
import { contentJobsRouter } from "./routes/content-jobs.js";
import { contentOutputsRouter } from "./routes/content-outputs.js";
import { contentExportsRouter } from "./routes/content-exports.js";
import { batchItemEventsRouter } from "./routes/batch-item-events.js";
import { orchestratorEventsRouter } from "./routes/orchestrator-events.js";
import { createPool, hasDatabaseConfig } from "./lib/database.js";
import { createAiOrchestratorClient, hasAiOrchestratorConfig } from "./lib/ai-orchestrator-client.js";
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
  const aiOrchestratorClient = createAiOrchestratorClient(env);

  app.locals.pool = pool;
  app.locals.projectsRepository = projectsRepository;
  app.locals.importBatchesRepository = importBatchesRepository;
  app.locals.productsRepository = productsRepository;
  app.locals.contentJobsRepository = contentJobsRepository;
  app.locals.workflowRepository = workflowRepository;
  app.locals.aiOrchestratorClient = aiOrchestratorClient;

  app.use(cors());
  app.use(express.json());
  app.use("/storage/assets", express.static(assetsDir));

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
      },
    });
  });

  app.use("/api/projects", projectsRouter);
  app.use("/api/import-batches", importBatchesRouter);
  app.use("/api/products", productsRouter);
  app.use("/api/content-jobs", contentJobsRouter);
  app.use("/api/content-outputs", contentOutputsRouter);
  app.use("/api/content-exports", contentExportsRouter);
  app.use("/api/creation-requests", creationRequestsRouter);
  app.use("/api/tasks", tasksRouter);
  app.use("/api/works", worksRouter);
  app.use("/internal/orchestrator", orchestratorEventsRouter);
  app.use("/internal/batch-items/events", batchItemEventsRouter);

  app.use((error, _request, response, _next) => {
    response.status(500).json({
      code: "INTERNAL_ERROR",
      message: error.message || "服务异常",
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
