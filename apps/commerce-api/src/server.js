import { fileURLToPath } from "node:url";

import cors from "cors";
import express from "express";

import { createAiOrchestratorClient } from "./lib/ai-orchestrator-client.js";
import { createPool, hasDatabaseConfig } from "./lib/database.js";
import { fail, ok } from "./lib/response.js";
import { MemoryCommerceRepository } from "./repositories/memory-commerce-repository.js";
import { PostgresCommerceRepository } from "./repositories/postgres-commerce-repository.js";
import { createPaypalClient, resolvePaypalConfig } from "./lib/paypal-client.js";
import {
  createPendingOrderSweeper,
  resolvePendingOrderTimeoutMs,
} from "./lib/pending-order-sweeper.js";
import { authRouter } from "./routes/auth.js";
import { cartsRouter } from "./routes/carts.js";
import { ordersRouter } from "./routes/orders.js";
import { paymentsRouter } from "./routes/payments.js";
import { productsRouter } from "./routes/products.js";
import { storefrontRouter } from "./routes/storefront.js";
import { storesRouter } from "./routes/stores.js";
import { webhooksRouter } from "./routes/webhooks.js";

async function resolveRepository({ env, pool, repository }) {
  if (repository) {
    return { commerceRepository: repository, repositoryError: null };
  }

  if (!pool) {
    return { commerceRepository: new MemoryCommerceRepository(), repositoryError: null };
  }

  try {
    await pool.query("select 1 from commerce.users limit 1");
    await pool.query("select 1 from commerce.sessions limit 1");
    // carts table is optional for older schemas; repository methods will fail clearly if missing
    return {
      commerceRepository: new PostgresCommerceRepository(pool),
      repositoryError: null,
    };
  } catch (error) {
    const message =
      error?.message ||
      "Commerce schema not ready. Run npm run db:init:commerce and restart.";
    console.warn(`[commerce-api] falling back to memory repository: ${message}`);
    return {
      commerceRepository: new MemoryCommerceRepository(),
      repositoryError: message,
    };
  }
}

export async function buildApp({
  env = process.env,
  repository,
  paypalClient,
  aiOrchestratorClient,
  enableSweeper = true,
} = {}) {
  const app = express();
  const dbConfigured = hasDatabaseConfig(env);
  const pool = createPool(env);
  const { commerceRepository, repositoryError } = await resolveRepository({
    env,
    pool,
    repository,
  });
  const resolvedPaypal = paypalClient || createPaypalClient(env);
  const paypalConfig = resolvedPaypal.config || resolvePaypalConfig(env);
  const resolvedAi = aiOrchestratorClient || createAiOrchestratorClient(env);
  const pendingOrderTimeoutMs = resolvePendingOrderTimeoutMs(env);
  const sweeper =
    enableSweeper && typeof commerceRepository.cancelExpiredPendingOrders === "function"
      ? createPendingOrderSweeper({
          repository: commerceRepository,
          olderThanMs: pendingOrderTimeoutMs,
          intervalMs: Number(env.PENDING_ORDER_SWEEP_INTERVAL_MS || 60_000),
        })
      : null;

  app.locals.env = env;
  app.locals.pool = pool;
  app.locals.repository = commerceRepository;
  app.locals.repositoryError = repositoryError;
  app.locals.paypalClient = resolvedPaypal;
  app.locals.aiOrchestratorClient = resolvedAi;
  app.locals.pendingOrderSweeper = sweeper;
  app.locals.pendingOrderTimeoutMs = pendingOrderTimeoutMs;

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_request, response) => {
    ok(response, {
      service: "commerce-api",
      status: "up",
      mode: "saas-store-skeleton",
      repository: commerceRepository.mode,
      databaseConfigured: dbConfigured,
      repositoryWarning: repositoryError,
      payments: {
        provider: "paypal",
        mode: paypalConfig.mode,
        configured: paypalConfig.configured,
        status: paypalConfig.mode === "mock" ? "mock_ready" : "ready",
      },
      ai: {
        mode: resolvedAi.mode,
        baseUrl: resolvedAi.baseUrl,
      },
      pendingOrderTimeoutMinutes: Math.round(pendingOrderTimeoutMs / 60000),
      pendingOrderSweeper: Boolean(sweeper),
    });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/stores", storesRouter);
  app.use("/api/stores/:storeId/products", productsRouter);
  app.use("/api/stores/:storeId/orders", ordersRouter);
  app.use("/api/carts", cartsRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/webhooks", webhooksRouter);
  app.use("/api/storefront", storefrontRouter);

  app.use((error, _request, response, _next) => {
    fail(response, 500, "INTERNAL_ERROR", error.message || "Internal error");
  });

  if (sweeper) {
    sweeper.start();
  }

  return app;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const port = Number(process.env.COMMERCE_API_PORT || process.env.API_PORT || 3200);
  const host = process.env.COMMERCE_API_HOST || "127.0.0.1";

  try {
    const app = await buildApp();
    app.listen(port, host, () => {
      console.log(`commerce-api listening on http://${host}:${port}`);
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
