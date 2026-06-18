const requestTypeCapabilities = {
  text_to_image: {
    label: "文生图片",
    enabled: true,
    helpText: "输入文本后可直接生成真实图片结果。",
  },
  text_to_video: {
    label: "文生视频",
    enabled: true,
    helpText: "视频能力已接入 Agnes 提供的模型服务，但稳定性仍受上游服务波动影响。",
  },
};

export function canSubmitRequestType(requestType, options = {}) {
  if (requestType === "text_to_video" && options.videoEnabled === false) {
    return false;
  }
  return Boolean(requestTypeCapabilities[requestType]?.enabled);
}

export function getRequestTypeLabel(requestType) {
  return requestTypeCapabilities[requestType]?.label || "创作结果";
}

export function getRequestTypeHelpText(requestType) {
  return requestTypeCapabilities[requestType]?.helpText || "";
}
