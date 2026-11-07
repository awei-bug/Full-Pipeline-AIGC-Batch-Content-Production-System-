import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { productsRouter } from "./products.js";
import { contentOutputsRouter } from "./content-outputs.js";
import { contentExportsRouter } from "./content-exports.js";
import { listingPacksRouter } from "./listing-packs.js";
import { canReadJob } from "../lib/data-scope.js";
import { contentJobsRouter } from "./content-jobs.js";
import { importBatchesRouter } from "./import-batches.js";

test("直接读取商品、产出、导出与成品包时检查项目归属", async () => {
  const app = express();
  let identity = { kind: "user", userId: "alice" };
  let mode = "local";
  let role = "viewer";
  let accessed = 0;
  app.use((req, _res, next) => { req.identity = identity; req.identityMode = mode; next(); });
  app.locals.importBatchesRepository = { getImportBatch: async (id) => id === "batch" ? { projectId: "p" } : id === "shared" ? { projectId: null } : null };
  app.locals.contentJobsRepository = {
    getJobById: async (id) => id === "job" ? { batchId: "batch" } : id === "shared-job" ? { batchId: "shared" } : null,
    listOutputsByJobId: async () => { accessed++; return []; },
  };
  app.locals.projectsRepository = { findMemberRole: async (_project, user) => user === "alice" ? role : null };
  const request = { identity, identityMode: mode, app };
  assert.equal(await canReadJob(request, "job", { publish: true }), false);
  role = "owner";
  assert.equal(await canReadJob(request, "job", { publish: true }), true);
  role = "viewer";
  app.locals.productsRepository = { listProductsByBatchId: async () => { accessed++; return []; } };
  app.locals.listingPackService = { buildPack: async () => { accessed++; return { fileName: "test.zip", buffer: Buffer.from("ok"), summary: {} }; } };
  app.use("/products", productsRouter);
  app.use("/outputs", contentOutputsRouter);
  app.use("/exports", contentExportsRouter);
  app.use("/packs", listingPacksRouter);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ["/products?batchId=batch", "/outputs?jobId=job", "/packs/job/preview"]) {
      assert.equal((await fetch(base + path)).status, 200);
    }
    const before = accessed;
    identity = { kind: "user", userId: "bob" };
    for (const path of ["/products?batchId=batch", "/outputs?jobId=job", "/exports/job", "/packs/job", "/packs/job/preview"]) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
    assert.equal((await fetch(base + "/packs/job", { method: "POST" })).status, 404);
    assert.equal(accessed, before);
    assert.equal((await fetch(base + "/products?batchId=shared")).status, 200);
    assert.equal((await fetch(base + "/outputs?jobId=shared-job")).status, 200);
    identity = { kind: "anonymous", userId: "anonymous" };
    assert.equal((await fetch(base + "/products?batchId=shared")).status, 404);
    assert.equal((await fetch(base + "/outputs?jobId=missing")).status, 404);
    identity = { kind: "user", userId: "alice" };
    role = "invalid";
    assert.equal((await fetch(base + "/outputs?jobId=job")).status, 404);
    mode = "off";
    assert.equal((await fetch(base + "/products?batchId=batch")).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("其他项目的 owner 不能覆盖目标项目 viewer 的写入限制", async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.identity = {kind: "user", userId: "u"}; req.identityMode = "local"; next(); });
  app.locals.projectsRepository = {
    findMemberRole: async () => "viewer",
    listRolesForUser: async () => [{projectId: "other", roleCode: "owner"}, {projectId: "target", roleCode: "viewer"}],
  };
  app.locals.importBatchesRepository = { getImportBatch: async () => ({projectId: "target"}) };
  app.locals.aiOrchestratorClient = {};
  app.use("/jobs", contentJobsRouter);
  app.use("/batches", importBatchesRouter);
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [path, body] of [["/jobs", {batchId: "b", contentTypes: ["marketing_copy"]}], ["/batches", {projectId: "target"}]]) {
      const res = await fetch(base + path, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
      assert.equal(res.status, 403, path);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
