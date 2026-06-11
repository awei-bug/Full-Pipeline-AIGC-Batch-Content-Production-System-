import test from "node:test";
import assert from "node:assert/strict";

import { deriveResultView } from "./result-view.js";

test("生成中时优先显示等待状态而不是旧结果", () => {
  const result = deriveResultView({
    latestWork: {
      id: "work_old",
      latestVersion: {
        generationTaskId: "task_old",
      },
    },
    latestAssetUrl: "http://127.0.0.1:3100/storage/assets/old.png",
    activeTask: {
      id: "task_new",
      requestType: "text_to_image",
      status: "queued",
    },
  });

  assert.equal(result.mode, "pending");
  assert.match(result.title, /图片正在生成中/);
});

test("任务失败时显示失败状态", () => {
  const result = deriveResultView({
    latestWork: null,
    latestAssetUrl: "",
    activeTask: {
      id: "task_new",
      requestType: "text_to_image",
      status: "failed",
      errorMessage: "模型调用失败",
    },
  });

  assert.equal(result.mode, "failed");
  assert.equal(result.message, "模型调用失败");
});

test("当前任务结果返回后显示最终内容", () => {
  const result = deriveResultView({
    latestWork: {
      id: "work_new",
      latestVersion: {
        generationTaskId: "task_new",
      },
    },
    latestAssetUrl: "http://127.0.0.1:3100/storage/assets/new.png",
    activeTask: {
      id: "task_new",
      requestType: "text_to_image",
      status: "success",
    },
  });

  assert.equal(result.mode, "ready");
  assert.equal(result.assetUrl, "http://127.0.0.1:3100/storage/assets/new.png");
});
