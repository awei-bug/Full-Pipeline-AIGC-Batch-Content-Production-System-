import express from "express";

import { BILLING_ACTIONS } from "../lib/billing.js";
import { refundCredits, requireCredits } from "../lib/credit-guard.js";
import { ACTIONS, requirePlatformPermission } from "../lib/permissions.js";

export const chatRouter = express.Router();

// AI 对话不绑定项目，按平台级权限点保护（editor 及以上可用）。
const requireAiChat = requirePlatformPermission({ action: ACTIONS.PLATFORM_AI_CHAT });

/**
 * 参数校验放在**计费之前**。
 *
 * 顺序反了的话，一个空 messages 的请求会先被扣额度、再返回 400，用户白花钱。
 * 校验先行的代价只是一次内存判断，收益是不会为无效请求计费。
 */
function validateChatBody(request, response, next) {
  const rawMessages = request.body?.messages;
  const messages = (Array.isArray(rawMessages) ? rawMessages : [])
    .map((message) => ({
      role: String(message?.role || "user").trim(),
      content: String(message?.content || "").trim(),
    }))
    .filter((message) => message.content);

  if (messages.length === 0) {
    return response.status(400).json({
      code: "INVALID_PARAM",
      message: "对话内容不能为空",
      data: null,
    });
  }
  request.chatMessages = messages;
  return next();
}

function requireOrchestratorConfigured(request) {
  return Boolean(request.app.locals.aiOrchestratorClient);
}

// 顺序：权限 → 参数 → 扣额度 → 服务可用性 → 调模型。
//
// 计费排在"服务可用性"之前是有意的：余额不足是用户必须知道的事，如果先返回
// "服务未配置(503)"，用户修好配置后仍会因余额不足失败，白折腾一轮。
// 代价是为一个必然失败的请求先占用额度，因此 503 分支必须显式回补。
chatRouter.post(
  "/",
  requireAiChat,
  validateChatBody,
  requireCredits({ action: BILLING_ACTIONS.CHAT, bizPrefix: "chat" }),
  async (request, response, next) => {
    try {
      if (!requireOrchestratorConfigured(request)) {
        // 服务没配，这个请求注定不产生模型调用，预扣要退。
        await refundCredits(request, "orchestrator not configured");
        response.status(503).json({
          code: "ORCHESTRATOR_NOT_CONFIGURED",
          message: "对话服务尚未连接",
          data: null,
        });
        return;
      }

      const result = await request.app.locals.aiOrchestratorClient.chat({
        messages: request.chatMessages,
      });
      response.json({
        code: "SUCCESS",
        message: "对话完成",
        data: {
          ...result,
          // 把余额带回响应，前端可即时更新显示，不必再查一次。
          credits: request.billing?.balance || null,
        },
      });
    } catch (error) {
      // 模型调用失败：预扣的额度要退回，否则用户为一次失败付费。
      await refundCredits(request, `chat failed: ${error?.message || "unknown"}`);
      next(error);
    }
  },
);
