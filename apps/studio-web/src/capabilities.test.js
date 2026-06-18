import test from "node:test";
import assert from "node:assert/strict";

import {
  canSubmitRequestType,
  getRequestTypeHelpText,
  getRequestTypeLabel,
} from "./capabilities.js";

test("图片和视频能力默认都可提交", () => {
  assert.equal(canSubmitRequestType("text_to_image"), true);
  assert.equal(canSubmitRequestType("text_to_video"), true);
});

test("部署配置可以显式关闭视频能力", () => {
  assert.equal(canSubmitRequestType("text_to_video", { videoEnabled: false }), false);
});

test("视频能力文案反映真实接入状态", () => {
  assert.equal(getRequestTypeLabel("text_to_video"), "文生视频");
  assert.equal(
    getRequestTypeHelpText("text_to_video"),
    "视频能力已接入 Agnes 提供的模型服务，但稳定性仍受上游服务波动影响。",
  );
});
