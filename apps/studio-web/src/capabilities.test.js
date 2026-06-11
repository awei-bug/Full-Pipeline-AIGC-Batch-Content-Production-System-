import test from "node:test";
import assert from "node:assert/strict";

import {
  canSubmitRequestType,
  getRequestTypeHelpText,
  getRequestTypeLabel,
} from "./capabilities.js";

test("image generation is the only production submission path", () => {
  assert.equal(canSubmitRequestType("text_to_image"), true);
  assert.equal(canSubmitRequestType("text_to_video"), false);
});

test("video generation is shown as experimental", () => {
  assert.equal(getRequestTypeLabel("text_to_video"), "文生视频（实验中）");
  assert.equal(
    getRequestTypeHelpText("text_to_video"),
    "视频生成正在接入真实可用的服务商，当前先开放图片生成闭环。",
  );
});
