import test from "node:test";
import assert from "node:assert/strict";
import { jobAssetUrl, fetchJobAsset } from "./protected-asset.js";

test("素材地址限定本机服务和任务，凭证通过请求头发送", async () => {
  const base = "http://127.0.0.1:3100";
  assert.equal(jobAssetUrl(base, "job-1", `${base}/storage/assets/a.png`), `${base}/api/content-jobs/job-1/assets/a.png`);
  for (const url of ["https://elsewhere.example/storage/assets/a.png", "/storage/assets/a.png?token=abc", "/storage/assets/../secret", "/storage/assets/a..png"]) {
    assert.equal(jobAssetUrl(base, "job-1", url), "");
  }
  let sent;
  const blob = await fetchJobAsset(base, "job-1", "/storage/assets/a.png", "secret", {fetchImpl: async (url, options) => { sent = {url, options}; return {ok: true, blob: async () => new Blob(["image"])}; }});
  assert.equal(await blob.text(), "image");
  assert.equal(sent.options.headers.Authorization, "Bearer secret");
  assert.ok(!sent.url.includes("secret"));
  await assert.rejects(fetchJobAsset(base, "job-1", "/storage/assets/a.png", "secret", {fetchImpl: async () => ({ok: false})}), /权限/);
});
