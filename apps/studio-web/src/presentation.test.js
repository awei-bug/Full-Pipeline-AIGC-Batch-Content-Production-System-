import test from "node:test";
import assert from "node:assert/strict";

import { getStageAspectRatio, getStyleSummary } from "./presentation.js";

test("生成结果有宽高时优先使用结果宽高作为画框比例", () => {
  const ratio = getStageAspectRatio({
    latestAsset: {
      width: 1024,
      height: 1536,
    },
    formState: {
      aspectRatio: "16:9",
    },
  });

  assert.equal(ratio, "1024 / 1536");
});

test("没有结果宽高时回退到当前表单比例", () => {
  const ratio = getStageAspectRatio({
    latestAsset: null,
    formState: {
      aspectRatio: "16:9",
    },
  });

  assert.equal(ratio, "16 / 9");
});

test("风格摘要返回对应中文描述", () => {
  assert.equal(getStyleSummary("cinematic"), "强调光影层次、海报感和成片氛围。");
  assert.equal(getStyleSummary("minimal"), "减少噪音，让主体和构图更干净。");
});
