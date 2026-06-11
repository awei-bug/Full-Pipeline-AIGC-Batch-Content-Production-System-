export async function applyTaskEvent({
  workflowRepository,
  event,
}) {
  if (!workflowRepository) {
    throw new Error("缺少任务仓储");
  }

  const normalizedStatus = String(event?.status || "").trim().toLowerCase();
  const taskId = String(event?.taskId || "").trim();

  if (!taskId || !normalizedStatus) {
    const error = new Error("任务编号和事件状态不能为空");
    error.code = "INVALID_PARAM";
    throw error;
  }

  if (normalizedStatus === "succeeded") {
    return workflowRepository.markTaskSucceeded({
      taskId,
      providerCode: String(event.providerCode || "").trim() || null,
      revisedPrompt: String(event.revisedPrompt || "").trim() || null,
      outputs: Array.isArray(event.outputs) ? event.outputs : [],
    });
  }

  if (normalizedStatus === "failed") {
    return workflowRepository.markTaskFailed({
      taskId,
      providerCode: String(event.providerCode || "").trim() || null,
      errorCode: String(event.errorCode || "").trim() || null,
      externalTaskId: String(event.externalTaskId || "").trim() || null,
      errorMessage: String(event.errorMessage || "任务失败").trim(),
    });
  }

  const error = new Error("暂不支持该事件状态");
  error.code = "INVALID_STATUS";
  throw error;
}
