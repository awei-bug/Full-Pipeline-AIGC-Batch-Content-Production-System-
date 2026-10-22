import express from "express";

import { BILLING_ACTIONS } from "../lib/billing.js";
import { refundCredits, requireCredits } from "../lib/credit-guard.js";
import { ACTIONS, requireProjectPermission } from "../lib/permissions.js";
import { submitCreationRequest } from "../services/creation-request-service.js";

export const creationRequestsRouter = express.Router();

// 这个路由的 body 里就有 projectId，可以做真正的项目级校验。
const requireContentWrite = requireProjectPermission({
  action: ACTIONS.CONTENT_WRITE,
  resolveProjectId: (request) => String(request.body?.projectId || "").trim() || null,
});

/**
 * 参数校验放在计费之前。
 *
 * 顺序反了的话，缺 prompt 的请求会先被扣额度再返回 400。校验先行只是一次
 * 内存判断，但能保证不为无效请求计费。
 */
function validateBody(request, response, next) {
  const projectId = String(request.body?.projectId || "").trim();
  const prompt = String(request.body?.prompt || "").trim();
  if (!projectId || !prompt) {
    return response.status(400).json({
      code: "INVALID_PARAM",
      message: "项目编号和创作提示不能为空",
      data: null,
    });
  }
  request.creationInput = {
    projectId,
    prompt,
    requestType: String(request.body?.requestType || "text_to_image").trim(),
    styleCode: String(request.body?.styleCode || "").trim() || null,
    aspectRatio: String(request.body?.aspectRatio || "").trim() || null,
  };
  return next();
}

// 顺序：项目权限 → 参数 → 扣额度 → 提交。
creationRequestsRouter.post(
  "/",
  requireContentWrite,
  validateBody,
  requireCredits({
    action: BILLING_ACTIONS.CREATION_REQUEST,
    bizPrefix: "creation",
  }),
  async (request, response, next) => {
    try {
      const input = request.creationInput;
      const result = await submitCreationRequest({
        workflowRepository: request.app.locals.workflowRepository,
        orchestratorClient: request.app.locals.aiOrchestratorClient,
        input,
      });

      response.status(202).json({
        code: "SUCCESS",
        message: "创作请求已受理",
        data: {
          ...result,
          projectId: input.projectId,
          workflowEndpoint: "/internal/workflows/generate",
          credits: request.billing?.balance || null,
        },
      });
    } catch (error) {
      if (error.code === "PROJECT_NOT_FOUND") {
        // 项目不存在时没有产生真实模型调用，预扣要退。
        await refundCredits(request, "creation request project not found");
        response.status(404).json({
          code: "PROJECT_NOT_FOUND",
          message: error.message || "项目不存在",
          data: null,
        });
        return;
      }

      await refundCredits(request, `creation request failed: ${error?.message || "unknown"}`);
      next(error);
    }
  },
);
