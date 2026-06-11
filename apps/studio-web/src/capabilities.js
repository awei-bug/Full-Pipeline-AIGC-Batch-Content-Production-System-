const requestTypeCapabilities = {
  text_to_image: {
    label: "文生图",
    enabled: true,
    helpText: "输入文字后生成真实图片结果。",
  },
  text_to_video: {
    label: "文生视频（实验中）",
    enabled: false,
    helpText: "视频生成正在接入真实可用的服务商，当前先开放图片生成闭环。",
  },
};

export function canSubmitRequestType(requestType) {
  return Boolean(requestTypeCapabilities[requestType]?.enabled);
}

export function getRequestTypeLabel(requestType) {
  return requestTypeCapabilities[requestType]?.label || "创作结果";
}

export function getRequestTypeHelpText(requestType) {
  return requestTypeCapabilities[requestType]?.helpText || "";
}
