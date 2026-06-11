import assert from "node:assert/strict";
import test from "node:test";

import {
  extractTaskId,
  extractVideoUrl,
  parseCsvList,
  summarizeProbeResults,
} from "./modelscope-video-probe.js";

test("parseCsvList trims values and removes empty entries", () => {
  assert.deepEqual(parseCsvList(" a, ,b,c "), ["a", "b", "c"]);
});

test("extractTaskId supports known ModelScope response shapes", () => {
  assert.equal(extractTaskId({ task_id: "task_a" }), "task_a");
  assert.equal(extractTaskId({ output: { task_id: "task_b" } }), "task_b");
  assert.equal(extractTaskId({ output: { taskId: "task_c" } }), "task_c");
});

test("extractVideoUrl supports known ModelScope result shapes", () => {
  assert.equal(extractVideoUrl({ output_video: "https://example.com/a.mp4" }), "https://example.com/a.mp4");
  assert.equal(extractVideoUrl({ output: { video_url: "https://example.com/b.mp4" } }), "https://example.com/b.mp4");
  assert.equal(extractVideoUrl({ videos: [{ url: "https://example.com/c.mp4" }] }), "https://example.com/c.mp4");
});

test("summarizeProbeResults chooses completed models before accepted models", () => {
  const summary = summarizeProbeResults([
    { model: "slow", status: "running_timeout", taskId: "task_1" },
    { model: "done", status: "succeeded", taskId: "task_2", videoUrl: "https://example.com/video.mp4" },
  ]);

  assert.equal(summary.recommendedModel, "done");
  assert.equal(summary.hasSucceededModel, true);
});
