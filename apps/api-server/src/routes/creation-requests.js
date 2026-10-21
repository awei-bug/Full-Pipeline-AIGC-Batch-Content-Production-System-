import express from "express";

import { ACTIONS, requireProjectPermission } from "../lib/permissions.js";
import { submitCreationRequest } from "../services/creation-request-service.js";

export const creationRequestsRouter = express.Router();

// 这个路由的 body 里就有 projectId，可以做真正的项目级校验。
const requireContentWrite = requireProjectPermission({
  action: ACTIONS.CONTENT_WRITE,
  resolveProjectId: (request) => String(request.body?.projectId || "").trim() || null,
});

creationRequestsRouter.post("/", requireContentWrite, async (request, response, next) => {
  try {
    const prompt = String(request.body?.prompt || "").trim();
    const projectId = String(request.body?.projectId || "").trim();
    const requestType = String(request.body?.requestType || "text_to_image").trim();
    const styleCode = String(request.body?.styleCode || "").trim() || null;
    const aspectRatio = String(request.body?.aspectRatio || "").trim() || null;

    if (!projectId || !prompt) {
      response.status(400).json({
        code: "INVALID_PARAM",
        message: "项目编号和创作提示不能为空",
        data: null,
      });
      return;
    }

    const result = await submitCreationRequest({
      workflowRepository: request.app.locals.workflowRepository,
      orchestratorClient: request.app.locals.aiOrchestratorClient,
      input: {
        projectId,
        prompt,
        requestType,
        styleCode,
        aspectRatio,
      },
    });

    response.status(202).json({
      code: "SUCCESS",
      message: "创作请求已受理",
      data: {
        ...result,
        projectId,
        workflowEndpoint: "/internal/workflows/generate",
      },
    });
  } catch (error) {
    if (error.code === "PROJECT_NOT_FOUND") {
      response.status(404).json({
        code: "PROJECT_NOT_FOUND",
        message: error.message || "项目不存在",
        data: null,
      });
      return;
    }

    next(error);
  }
});
