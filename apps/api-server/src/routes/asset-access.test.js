import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../server.js";
import { signToken } from "../lib/local-auth.js";

test("认证模式下素材必须属于被授权的任务，本地演示保持原有静态访问", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "content-assets-"));
  const secret = "a sufficiently long test secret";
  await writeFile(path.join(dir, "sample.png"), "test-image");
  const env = { AUTH_MODE: "strict", AUTH_SECRET: secret, LOCAL_ASSETS_DIR: dir };
  const app = await buildApp({ env });
  app.locals.contentJobsRepository = {
    getJobById: async id => id === "job" ? { batchId: "batch" } : null,
    listOutputsByJobId: async () => [{ outputType: "image_asset", outputData: { metadata: { publicUrl: "/storage/assets/sample.png" } } }],
  };
  app.locals.importBatchesRepository = { getImportBatch: async () => ({ projectId: "project" }) };
  app.locals.projectsRepository = { findMemberRole: async (_project, user) => user === "alice" ? "viewer" : null };
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const alice = signToken({ sub: "alice" }, { secret });
  const bob = signToken({ sub: "bob" }, { secret });
  const auth = token => ({ headers: { Authorization: `Bearer ${token}` } });
  try {
    assert.equal((await fetch(`${base}/storage/assets/sample.png`)).status, 404);
    assert.equal((await fetch(`${base}/api/content-jobs/job/assets/sample.png`)).status, 401);
    assert.equal((await fetch(`${base}/api/content-jobs/job/assets/sample.png`, auth(bob))).status, 404);
    assert.equal((await fetch(`${base}/api/content-jobs/job/assets/other.png`, auth(alice))).status, 404);
    const response = await fetch(`${base}/api/content-jobs/job/assets/sample.png`, auth(alice));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "test-image");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    app.locals.projectsRepository.findMemberRole = async () => null;
    assert.equal((await fetch(`${base}/api/content-jobs/job/assets/sample.png`, auth(alice))).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  const demo = createServer(await buildApp({ env: { AUTH_MODE: "off", LOCAL_ASSETS_DIR: dir } }));
  await new Promise(resolve => demo.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${demo.address().port}/storage/assets/sample.png`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "test-image");
  } finally {
    await new Promise(resolve => demo.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
