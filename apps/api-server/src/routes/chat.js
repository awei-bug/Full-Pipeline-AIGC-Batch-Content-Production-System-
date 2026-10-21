import express from "express";

import { ACTIONS, requirePlatformPermission } from "../lib/permissions.js";

export const chatRouter = express.Router();

// AI 对话不绑定项目，按平台级权限点保护（editor 及以上可用）。
const requireAiChat = requirePlatformPermission({ action: ACTIONS.PLATFORM_AI_CHAT });

chatRouter.post("/", requireAiChat, async (request, response, next) => {
  try {
    const rawMessages = request.body?.messages;
    const messages = (Array.isArray(rawMessages) ? rawMessages : [])
      .map((message) => ({
        role: String(message?.role || "user").trim(),
        content: String(message?.content || "").trim(),
      }))
      .filter((message) => message.content);

    if (messages.length === 0) {
      response.status(400).json({
        code: "INVALID_PARAM",
        message: "对话内容不能为空",
        data: null,
      });
      return;
    }

    if (!request.app.locals.aiOrchestratorClient) {
      response.status(503).json({
        code: "ORCHESTRATOR_NOT_CONFIGURED",
        message: "对话服务尚未连接",
        data: null,
      });
      return;
    }

    const result = await request.app.locals.aiOrchestratorClient.chat({ messages });
    response.json({
      code: "SUCCESS",
      message: "对话完成",
      data: result,
    });
  } catch (error) {
    next(error);
  }
});
