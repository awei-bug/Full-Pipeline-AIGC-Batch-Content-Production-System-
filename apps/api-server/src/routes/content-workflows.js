import express from "express";

import { BILLING_ACTIONS } from "../lib/billing.js";
import { refundCredits, requireCredits } from "../lib/credit-guard.js";
import { ACTIONS, requirePlatformPermission } from "../lib/permissions.js";

export const contentWorkflowsRouter = express.Router();

// 内容工作流不绑定项目，按平台级生成权限保护。
const requireGenerate = requirePlatformPermission({ action: ACTIONS.PLATFORM_GENERATE });

function orchestratorReady(request) {
  return Boolean(request.app.locals.aiOrchestratorClient?.submitContentWorkflow);
}

// 顺序：权限 → 扣额度 → 服务可用性 → 提交。
//
// 这是最贵的动作（图片/视频生成），额度单价也最高。
// 计费排在服务可用性之前，理由与 chat 一致：余额不足是用户必须先知道的事，
// 否则他修好编排服务配置后仍会因余额失败，白折腾一轮。
// 因此 503 分支必须显式回补额度。
contentWorkflowsRouter.post(
  "/",
  requireGenerate,
  requireCredits({
    action: BILLING_ACTIONS.CONTENT_WORKFLOW,
    bizPrefix: "workflow",
  }),
  async (request, response, next) => {
    try {
      if (!orchestratorReady(request)) {
        await refundCredits(request, "orchestrator not configured");
        response.status(503).json({
          code: "ORCHESTRATOR_UNAVAILABLE",
          message: "AI 编排服务未配置，无法启动内容工作流",
          data: null,
        });
        return;
      }

      const result = await request.app.locals.aiOrchestratorClient.submitContentWorkflow(
        request.body || {},
      );
      response.status(202).json({
        code: "SUCCESS",
        message: "内容工作流已启动",
        data: {
          ...result,
          credits: request.billing?.balance || null,
        },
      });
    } catch (error) {
      if (error?.statusCode === 400) {
        // 参数错误没有真正产生模型调用，预扣要退。
        await refundCredits(request, `workflow invalid param: ${error.message}`);
        response.status(400).json({
          code: "INVALID_PARAM",
          message: error.message,
          data: null,
        });
        return;
      }
      await refundCredits(request, `workflow failed: ${error?.message || "unknown"}`);
      next(error);
    }
  },
);

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
