import express from "express";

export const contentWorkflowsRouter = express.Router();

contentWorkflowsRouter.post("/", async (request, response, next) => {
  try {
    const orchestratorClient = request.app.locals.aiOrchestratorClient;
    if (!orchestratorClient?.submitContentWorkflow) {
      response.status(503).json({
        code: "ORCHESTRATOR_UNAVAILABLE",
        message: "AI 编排服务未配置，无法启动内容工作流",
        data: null,
      });
      return;
    }

    const result = await orchestratorClient.submitContentWorkflow(request.body || {});
    response.status(202).json({
      code: "SUCCESS",
      message: "内容工作流已启动",
      data: result,
    });
  } catch (error) {
    if (error?.statusCode === 400) {
      response.status(400).json({
        code: "INVALID_PARAM",
        message: error.message,
        data: null,
      });
      return;
    }
    next(error);
  }
});

contentWorkflowsRouter.get("/:workflowId", async (request, response, next) => {
  try {
    const orchestratorClient = request.app.locals.aiOrchestratorClient;
    if (!orchestratorClient?.getContentWorkflow) {
      response.status(503).json({
        code: "ORCHESTRATOR_UNAVAILABLE",
        message: "AI 编排服务未配置",
        data: null,
      });
      return;
    }

    const result = await orchestratorClient.getContentWorkflow(request.params.workflowId);
    response.json({
      code: "SUCCESS",
      message: "成功",
      data: result,
    });
  } catch (error) {
    next(error);
  }
});
