/**
 * 额度守卫：调付费 API 前预扣额度，不足直接阻断。
 *
 * 为什么在"调 API 之前"扣，而不是成功后扣
 * ------------------------------------
 * 用户明确要求"调 api 的时候就消耗额度，不足时直接阻断"。
 * 技术上这也是更安全的选择：成功后扣意味着"检查余额"与"扣减"之间有时间窗口，
 * 并发请求可以双花——余额 10 点、单价 10 点，两个并发请求都能通过检查。
 *
 * 代价是下游可能失败，需要回补。回补走独立的补偿流水，账目可对。
 *
 * 阻断的响应码
 * ----------
 * 用 **402 Payment Required**，不是 403。语义不同：
 * - 403 = 你这个角色不许做这件事（换个人来做就行）
 * - 402 = 你没钱了（充值就能做）
 * 前端可以据此显示"余额不足，去充值"而不是"无权限"，处置路径完全不同。
 *
 * AUTH_MODE=off 时跳过
 * -------------------
 * 本地演示没有真实身份，扣谁的额度都没意义。与权限层的 bypass 保持一致——
 * 否则双击启动立刻不可用。
 */

import crypto from "node:crypto";

import { InsufficientCreditsError } from "../lib/billing.js";

/**
 * 生成业务单号。同一单号重复提交会被流水表的唯一键挡住（防双扣）。
 *
 * 优先用调用方传入的幂等键（例如前端重试时带同一个 requestId），
 * 没有就生成一个——这意味着同一请求重试会被视为新的一笔，符合"每次调用都计费"。
 */
function resolveBizNo(request, prefix) {
  const provided = String(
    request.headers["idempotency-key"] || request.body?.idempotencyKey || "",
  ).trim();
  if (provided) return `${prefix}:${provided}`;
  return `${prefix}:${crypto.randomUUID()}`;
}

/**
 * @param {object} options
 * @param {string} options.action 计费动作（见 lib/billing.js 的 BILLING_ACTIONS）
 * @param {string} [options.bizPrefix] 业务单号前缀，默认取 action
 */
export function requireCredits({ action, bizPrefix = null }) {
  return async function creditsGuard(request, response, next) {
    const authMode = request.identityMode || "off";
    const identity = request.identity;

    // 本地演示不扣费；匿名请求已被上游身份守卫挡住，这里防御性跳过。
    if (authMode === "off" || !identity || identity.kind === "anonymous") {
      request.billing = { skipped: true, reason: "AUTH_MODE=off 或匿名" };
      return next();
    }

    const repository = request.app.locals.creditRepository;
    if (!repository) {
      // 没配置计费就不阻断——宁可少收钱，也不要让整个服务因为缺一个仓储而不可用。
      request.billing = { skipped: true, reason: "未配置额度仓储" };
      return next();
    }

    const bizNo = resolveBizNo(request, bizPrefix || action);

    try {
      const result = await repository.deduct({
        ownerId: identity.userId,
        action,
        bizNo,
      });
      request.billing = { action, bizNo, ...result };
      return next();
    } catch (error) {
      if (error instanceof InsufficientCreditsError || error?.code === "INSUFFICIENT_CREDITS") {
        return response.status(402).json({
          code: "INSUFFICIENT_CREDITS",
          message: `额度不足：本次需要 ${error.required} 点，当前可用 ${error.available} 点`,
          data: {
            required: error.required,
            available: error.available,
            action: error.action,
          },
        });
      }
      return next(error);
    }
  };
}

/**
 * 在路由处理器内部调用：当下游失败时回补预扣的额度。
 *
 * 为什么不放进中间件自动处理：下游失败可能发生在响应已开始写入之后，
 * 中间件拿不到可靠的失败信号。由路由显式调用更可控。
 *
 * @param {object} request
 * @param {string} [reason]
 */
export async function refundCredits(request, reason = "") {
  const billing = request.billing;
  if (!billing || billing.skipped || billing.replayed) return null;

  const repository = request.app.locals.creditRepository;
  if (!repository) return null;

  try {
    return await repository.refund({
      ownerId: request.identity.userId,
      action: billing.action,
      bizNo: billing.bizNo,
      reason,
    });
  } catch (error) {
    // 回补失败不抛出：它发生在错误处理路径里，再抛会盖掉原始错误。
    // 流水里没有 refund 记录意味着这笔钱实际被收了——需要监控这类日志。
    console.error("[credits] refund failed", {
      bizNo: billing.bizNo,
      action: billing.action,
      message: error?.message,
    });
    return null;
  }
}
