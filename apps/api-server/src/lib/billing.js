/**
 * 额度计费的常量、错误与配置。
 *
 * 现状与动机
 * ---------
 * `credit_accounts` / `credit_transactions` 两张表在 004 里就建好了，甚至种了
 * `user_demo` 1000 点，但**全项目没有一处读它或扣它**。也就是说这套系统现在
 * 谁登录都能无限次调模型——生成文案、生成图片、生成视频全是真金白银，等于把
 * 自家 API 账单的钥匙给了每个访客。
 *
 * 本次实现：调付费 API 时预扣额度，不足直接阻断。
 *
 * 三条设计决定
 * -----------
 * 1. **按用户账户扣，不按项目。** 额度是"谁在花钱"，调用者是用户。表也支持
 *    `owner_type='project'`，将来要做项目预算制可以加，现在不引入。
 *
 * 2. **预扣 + 失败回补**（而不是成功后扣）。成功后扣的话，"检查余额"和"扣减"
 *    之间有一个窗口，并发请求可以双花。预扣把窗口收在一条原子 UPDATE 里。
 *    代价是下游失败要回补——用一条独立的补偿流水记录，账目可对。
 *
 * 3. **不启用在 AUTH_MODE=off 下。** 本地演示没有真实身份，扣谁的额度都没有意义，
 *    强加会让双击启动直接不可用。与权限层的 bypass 保持一致。
 *
 * 成本数值是**占位默认值，必须按实际 API 单价调整**。通过环境变量配置，
 * 见 CREDIT_COST_*。
 */

/**
 * 计费动作。与路由一一对应，便于流水里追溯"这笔钱花在哪个动作上"。
 */
export const BILLING_ACTIONS = {
  /** 对话生成 / 修改宣传文案（文本模型） */
  CHAT: "chat",
  /** 内容工作流：图片 / 视频生成（最贵的动作） */
  CONTENT_WORKFLOW: "content_workflow",
  /** 创作请求（转编排服务） */
  CREATION_REQUEST: "creation_request",
};

/**
 * 从环境变量读取单价。
 *
 * 默认值只是占位：文本便宜、图/视频贵一个量级。**上线前必须按你的模型实际
 * 单价换算**，否则要么亏损要么把用户挡在门外。
 */
export function resolveCosts(env = process.env) {
  const read = (key, fallback) => {
    const raw = env[key];
    if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
    const value = Number(raw);
    // 非法配置一律回落默认值而不是抛错：计费参数写错不该让整个服务起不来。
    if (!Number.isFinite(value) || value < 0) return fallback;
    return Math.floor(value);
  };

  return {
    [BILLING_ACTIONS.CHAT]: read("CREDIT_COST_CHAT", 1),
    [BILLING_ACTIONS.CONTENT_WORKFLOW]: read("CREDIT_COST_CONTENT_WORKFLOW", 10),
    [BILLING_ACTIONS.CREATION_REQUEST]: read("CREDIT_COST_CREATION_REQUEST", 10),
  };
}

/** 新用户首次产生额度账户时的初始赠额。设为 0 表示不给赠额（需管理员充值）。 */
export function resolveInitialGrant(env = process.env) {
  const raw = env.CREDIT_INITIAL_GRANT;
  if (raw === undefined || raw === null || String(raw).trim() === "") return 100;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 100;
  return Math.floor(value);
}

/** 额度不足。路由层应转成 402 Payment Required。 */
export class InsufficientCreditsError extends Error {
  constructor({ required, available, action }) {
    super(`额度不足：本次需要 ${required}，当前可用 ${available}`);
    this.name = "InsufficientCreditsError";
    this.statusCode = 402;
    this.code = "INSUFFICIENT_CREDITS";
    this.required = required;
    this.available = available;
    this.action = action;
  }
}

/** 未知计费动作。属于编程错误，不是用户错误——应当 500。 */
export class UnknownBillingActionError extends Error {
  constructor(action) {
    super(`未登记的计费动作：${action}`);
    this.name = "UnknownBillingActionError";
    this.statusCode = 500;
    this.code = "UNKNOWN_BILLING_ACTION";
  }
}
