import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { dataHubRouter } from "./data-hub.js";
import { createHubSyncStatusRepository } from "../repositories/hub-sync-status-repository.js";

async function context(run) {
  const app = express();
  app.use(express.json());
  let mode = "fail";
  const role = { value: "editor" };
  app.use((req, _res, next) => { req.identityMode = "local"; req.identity = { kind: "user", userId: "u" }; next(); });
  app.locals.contentJobsRepository = { getJobById: async (id) => id === "job" ? { id, batchId: "batch", status: "success" } : null };
  app.locals.importBatchesRepository = { getImportBatch: async () => ({ projectId: "project" }) };
  app.locals.projectsRepository = { findMemberRole: async () => role.value, listRolesForUser: async () => [{ projectId: "project", roleCode: role.value }] };
  app.locals.hubSyncStatusRepository = createHubSyncStatusRepository(null);
  app.locals.dataHubSyncService = { async ingestJobContent() {
    if (mode === "fail") throw new Error("private upstream error");
    return { hub: { received: 2, okCount: mode === "partial" ? 1 : 2, errorCount: mode === "partial" ? 1 : 0 }, skipped: [] };
  } };
  app.use("/hub", dataHubRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, role, (value) => { mode = value; }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("sync failure is visible, partial is not success, retry recovers", async () => context(async (url, _role, setMode) => {
  const post = () => fetch(`${url}/hub/jobs/job/ingest`, { method: "POST" });
  let state = (await (await post()).json()).data;
  assert.equal(state.status, "failed");
  assert.doesNotMatch(state.message, /private/);
  state = (await (await fetch(`${url}/hub/jobs/job/status`)).json()).data;
  assert.equal(state.status, "failed");
  setMode("partial");
  state = (await (await post()).json()).data;
  assert.equal(state.status, "partial");
  assert.equal(state.failed, 1);
  setMode("ok");
  state = (await (await post()).json()).data;
  assert.equal(state.status, "success");
  assert.equal(state.succeeded, 2);
}));

test("project membership and write permission are enforced", async () => context(async (url, role) => {
  role.value = null;
  assert.equal((await fetch(`${url}/hub/jobs/job/status`)).status, 404);
  assert.equal((await fetch(`${url}/hub/jobs/job/ingest`, { method: "POST" })).status, 404);
  role.value = "viewer";
  assert.equal((await fetch(`${url}/hub/jobs/job/status`)).status, 200);
  assert.equal((await fetch(`${url}/hub/jobs/job/ingest`, { method: "POST" })).status, 403);
}));

test("overlapping attempts do not run twice", async () => {
  const store = createHubSyncStatusRepository(null);
  const first = await store.begin("job");
  assert.ok(first);
  assert.equal(await store.begin("job"), null);
  await store.finish("job", first, { status: "failed", message: "failed", received: 0, succeeded: 0, failed: 0 });
  assert.ok(await store.begin("job"));
});

test("expired attempt becomes recoverable", async () => {
  const store = createHubSyncStatusRepository(null);
  await store.begin("job");
  const original = Date.now;
  try {
    Date.now = () => original() + 301_000;
    assert.equal((await store.get("job")).status, "unknown");
    assert.ok(await store.begin("job"));
  } finally { Date.now = original; }
});
