const pendingStatuses = new Set([
  "draft",
  "created",
  "submitted",
  "queued",
  "running",
  "post_processing",
  "reviewing",
]);

function getMediaLabel(requestType) {
  return requestType === "text_to_video" ? "视频" : "图片";
}

export function deriveResultView({ latestWork, latestAssetUrl, activeTask }) {
  const matchedTaskId = latestWork?.latestVersion?.generationTaskId || null;
  const taskOwnsLatestResult =
    Boolean(activeTask?.id) &&
    Boolean(latestAssetUrl) &&
    matchedTaskId === activeTask.id;

  if (taskOwnsLatestResult) {
    return {
      mode: "ready",
      assetUrl: latestAssetUrl,
      assetType: latestWork?.workType || activeTask?.requestType || "text_to_image",
    };
  }

  if (activeTask?.status === "failed") {
    const mediaLabel = getMediaLabel(activeTask.requestType);
    return {
      mode: "failed",
      title: `${mediaLabel}生成失败`,
      message: activeTask.errorMessage || "本次生成失败，请调整内容后重试。",
    };
  }

  if (activeTask?.status && pendingStatuses.has(activeTask.status)) {
    const mediaLabel = getMediaLabel(activeTask.requestType);
    return {
      mode: "pending",
      title: `${mediaLabel}正在生成中`,
      message: "内容已提交，系统正在生成，请稍候自动刷新结果。",
    };
  }

  if (latestAssetUrl) {
    return {
      mode: "ready",
      assetUrl: latestAssetUrl,
      assetType: latestWork?.workType || "text_to_image",
    };
  }

  return {
    mode: "empty",
    title: "还没有生成结果",
    message: "提交内容后，这里只显示最终生成的图片或视频。",
  };
}
