const DISPATCH_DEFERRED_MESSAGE = "编排服务暂不可用，任务已入库，等待后续补发。";
const DISPATCH_NOT_CONFIGURED_MESSAGE = "编排服务未配置，任务已入库，等待后续补发。";

function normalizeWorkflowRun(payload, requestType) {
  return {
    workflowTaskId: String(payload?.workflowTaskId || payload?.taskId || "").trim() || null,
    workflowType: String(payload?.workflowType || requestType || "").trim() || requestType,
    providerCode: String(payload?.providerCode || "").trim() || null,
    status: String(payload?.status || "created").trim() || "created",
    acceptedAt: String(payload?.acceptedAt || "").trim() || null,
  };
}

export async function submitCreationRequest({
  workflowRepository,
  orchestratorClient,
  input,
}) {
  if (!workflowRepository) {
    throw new Error("缺少任务仓储");
  }

  const createdResult = await workflowRepository.createCreationRequest(input);

  if (!orchestratorClient) {
    await workflowRepository.markTaskDispatchDeferred({
      taskId: createdResult.taskId,
      reasonCode: "ORCHESTRATOR_NOT_CONFIGURED",
      reasonMessage: "未配置编排服务地址",
    });

    return {
      ...createdResult,
      dispatchStatus: "deferred",
      dispatchMessage: DISPATCH_NOT_CONFIGURED_MESSAGE,
      workflowRun: null,
    };
  }

  try {
    const workflowRun = normalizeWorkflowRun(
      await orchestratorClient.startGeneration({
        projectId: input.projectId,
        creationRequestId: createdResult.creationRequestId,
        taskId: createdResult.taskId,
        prompt: input.prompt,
        requestType: input.requestType,
        styleCode: input.styleCode,
        aspectRatio: input.aspectRatio,
      }),
      input.requestType,
    );

    await workflowRepository.markTaskQueued({
      taskId: createdResult.taskId,
      providerCode: workflowRun.providerCode,
      workflowRun,
    });

    return {
      ...createdResult,
      dispatchStatus: "queued",
      dispatchMessage: "任务已发送到编排服务。",
      workflowRun,
    };
  } catch (error) {
    await workflowRepository.markTaskDispatchDeferred({
      taskId: createdResult.taskId,
      reasonCode: "ORCHESTRATOR_UNAVAILABLE",
      reasonMessage: error?.message || "编排服务不可用",
    });

    return {
      ...createdResult,
      dispatchStatus: "deferred",
      dispatchMessage: DISPATCH_DEFERRED_MESSAGE,
      workflowRun: null,
    };
  }
}
