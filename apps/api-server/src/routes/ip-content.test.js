import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { ipContentRouter } from "./ip-content.js";

const app = express();
app.use("/api/ip-content", express.json({ limit: "2mb" }));
app.use(express.json());
const calls = [];
app.locals.aiOrchestratorClient = {
  async ipRequest(path, options) {
    calls.push({ path, options });
    return { id: "batch-1", items: [] };
  },
};
app.use("/api/ip-content", ipContentRouter);
let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test("IP batch routes forward the request and encoded task identifiers", async () => {
  const response = await fetch(`${baseUrl}/api/ip-content/batches`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ipName: "星港", chapters: [] }),
  });
  assert.equal(response.status, 202);
  assert.equal(calls[0].options.body.ipName, "星港");
  await fetch(`${baseUrl}/api/ip-content/batches/batch-1`);
  assert.equal(calls[1].path, "/batches/batch-1");
  const retry = await fetch(`${baseUrl}/api/ip-content/batches/batch-1/items/item-1/retry`, { method: "POST" });
  assert.equal(retry.status, 202);
  assert.equal(calls[2].path, "/batches/batch-1/items/item-1/retry");
  await fetch(`${baseUrl}/api/ip-content/projects`);
  assert.equal(calls[3].path, "/projects");
  const project = await fetch(`${baseUrl}/api/ip-content/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "星港", lore: "canon" }),
  });
  assert.equal(project.status, 200);
  assert.equal(calls[4].options.body.lore, "canon");
  await fetch(`${baseUrl}/api/ip-content/batches/batch-1/items/item-1/review`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approved" }),
  });
  assert.equal(calls[5].path, "/batches/batch-1/items/item-1/review");
  await fetch(`${baseUrl}/api/ip-content/batches/batch-1/items/item-1/revise`, { method: "POST" });
  assert.equal(calls[6].path, "/batches/batch-1/items/item-1/revise");
  const visuals = await fetch(`${baseUrl}/api/ip-content/batches/batch-1/items/item-1/visuals`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outputs: ["image"], style: "cinematic" }),
  });
  assert.equal(visuals.status, 202);
  assert.deepEqual(calls[7].options.body, { outputs: ["image"], style: "cinematic" });
  await fetch(`${baseUrl}/api/ip-content/batches/batch-1/items/item-1/visuals`);
  assert.equal(calls[8].path, "/batches/batch-1/items/item-1/visuals");
});

test("unconfigured orchestrator returns a useful 503", async () => {
  const configured = app.locals.aiOrchestratorClient;
  app.locals.aiOrchestratorClient = null;
  try {
    const response = await fetch(`${baseUrl}/api/ip-content/batches/no-service`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).message, /IP 编排服务未配置/);
  } finally {
    app.locals.aiOrchestratorClient = configured;
  }
});

test("large Chinese canon is accepted by the scoped JSON parser", async () => {
  const lore = "设定".repeat(15000);
  const chapters = Array.from({ length: 50 }, (_, index) => ({ title: String(index), brief: "剧情".repeat(500) }));
  const response = await fetch(`${baseUrl}/api/ip-content/batches`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ipName: "星港", lore, chapters }),
  });
  assert.equal(response.status, 202);
  assert.equal(calls.at(-1).options.body.lore, lore);
  assert.equal(calls.at(-1).options.body.chapters.length, 50);
});
