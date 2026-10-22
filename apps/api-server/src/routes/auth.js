/**
 * 注册与登录（内容平台 identity 层）。
 *
 * 只在 AUTH_MODE 为 local/strict 时生效。AUTH_MODE=off 时这两个接口明确返回 404，
 * 而不是悄悄可用——否则本地演示环境也能凭空注册账号，误导使用者以为已经有用户体系。
 */

import express from "express";

import { signToken } from "../lib/local-auth.js";
import { resolveAuthMode } from "../lib/identity.js";
import { actionsForRole, highestRole } from "../lib/permissions.js";

export const authRouter = express.Router();

const MIN_PASSWORD_LENGTH = 8;

function fail(response, status, code, message) {
  return response.status(status).json({ code, message, data: null });
}

function requireEnabled(request, response) {
  const mode = resolveAuthMode(request.app.locals.env || process.env);
  if (mode === "off") {
    fail(
      response,
      404,
      "AUTH_DISABLED",
      "当前为本地演示模式（AUTH_MODE=off），未启用用户体系。设置 AUTH_MODE=local 并配置 AUTH_SECRET 后可用。",
    );
    return null;
  }
  return mode;
}

function authSecret(request) {
  const env = request.app.locals.env || process.env;
  const secret = String(env.AUTH_SECRET || "").trim();
  return secret || null;
}

authRouter.post("/register", async (request, response, next) => {
  try {
    if (!requireEnabled(request, response)) return;
    const repository = request.app.locals.usersRepository;
    if (!repository) {
      return fail(response, 503, "SERVICE_UNAVAILABLE", "用户仓储未初始化");
    }

    const username = String(request.body?.username || "").trim();
    const password = String(request.body?.password || "");
    const email = String(request.body?.email || "").trim() || null;

    if (username.length < 3) {
      return fail(response, 400, "INVALID_PARAM", "用户名至少 3 个字符");
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return fail(response, 400, "INVALID_PARAM", `密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
    }

    const user = await repository.create({
      username,
      email,
      password,
      tenantId: request.body?.tenantId ? String(request.body.tenantId) : null,
    });

    response.status(201).json({
      code: "SUCCESS",
      message: "注册成功",
      data: { user },
    });
  } catch (error) {
    if (error?.statusCode === 409) {
      return fail(response, 409, "USER_EXISTS", error.message);
    }
    next(error);
  }
});

authRouter.post("/login", async (request, response, next) => {
  try {
    if (!requireEnabled(request, response)) return;
    const repository = request.app.locals.usersRepository;
    const secret = authSecret(request);
    if (!repository) {
      return fail(response, 503, "SERVICE_UNAVAILABLE", "用户仓储未初始化");
    }
    if (!secret) {
      // fail-closed：没有 secret 就不签发，避免用空密钥签出可被随意伪造的 token。
      return fail(
        response,
        503,
        "AUTH_SECRET_MISSING",
        "未配置 AUTH_SECRET，无法签发登录凭证。请在环境变量中设置至少 16 位的随机字符串。",
      );
    }

    const username = String(request.body?.username || "").trim();
    const password = String(request.body?.password || "");
    if (!username || !password) {
      return fail(response, 400, "INVALID_PARAM", "用户名和密码不能为空");
    }

    const { verifyPassword } = await import("../repositories/users-repository.js");
    const user = await repository.findByUsername(username);
    const storedHash = user
      ? await (typeof repository.findCredential === "function"
          ? repository.findCredential(user.id)
          : Promise.resolve(user.passwordHash))
      : null;

    // 用户不存在与密码错误返回同一句话：区分开会让攻击者能枚举有效用户名。
    const ok = storedHash ? await verifyPassword(password, storedHash) : false;
    if (!ok) {
      return fail(response, 401, "INVALID_CREDENTIALS", "用户名或密码错误");
    }

    const token = signToken(
      { sub: user.id, tenant: user.tenantId || null },
      { secret },
    );

    response.json({
      code: "SUCCESS",
      message: "登录成功",
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          tenantId: user.tenantId || null,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", async (request, response, next) => {
  try {
    if (!requireEnabled(request, response)) return;
    const identity = request.identity;
    if (!identity || identity.kind === "anonymous") {
      return fail(response, 401, "UNAUTHORIZED", "未登录");
    }
    const repository = request.app.locals.usersRepository;
    const user = repository ? await repository.findById(identity.userId) : null;
    response.json({
      code: "SUCCESS",
      message: "成功",
      data: {
        identity,
        user: user
          ? {
              id: user.id,
              username: user.username,
              email: user.email,
              tenantId: user.tenantId || null,
            }
          : null,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 当前用户在各项目中的角色 + 折算出的平台级角色。
 *
 * 这个接口的存在是为了消除 `X-Content-Role` 那个"前端自述角色"的边界：
 * 前端不再需要自己声明角色，问这个接口即可。后端守卫本身也走同一套查询
 * （见 requirePlatformPermission），不依赖请求头。
 *
 * 返回 platformRole 是服务端折算的最高角色，前端只用于控制按钮显隐；
 * 真正的判定仍在后端。
 */
authRouter.get("/me/projects", async (request, response, next) => {
  try {
    if (!requireEnabled(request, response)) return;
    const identity = request.identity;
    if (!identity || identity.kind === "anonymous") {
      return fail(response, 401, "UNAUTHORIZED", "请先登录");
    }

    const projectsRepository = request.app.locals.projectsRepository;
    const memberships = projectsRepository?.listRolesForUser
      ? await projectsRepository.listRolesForUser(identity.userId)
      : [];

    const platformRole = highestRole(memberships.map((item) => item.roleCode));

    response.json({
      code: "SUCCESS",
      message: "成功",
      data: {
        userId: identity.userId,
        // 项目级角色：前端可据此在具体项目页面控制写操作
        memberships,
        // 平台级角色：服务端折算，前端不得自行声明
        platformRole,
        // 让前端知道当前账号能做什么，避免"点了才 403"
        actions: platformRole ? actionsForRole(platformRole) : [],
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 当前用户的额度余额与计费单价。
 *
 * 前端在调用付费接口前可以先查这里，或在 402 后引导充值。
 * 单价一并返回，让前端能显示"本次约消耗 N 点"。
 */
authRouter.get("/me/credits", async (request, response, next) => {
  try {
    if (!requireEnabled(request, response)) return;
    const identity = request.identity;
    if (!identity || identity.kind === "anonymous") {
      return fail(response, 401, "UNAUTHORIZED", "请先登录");
    }

    const repository = request.app.locals.creditRepository;
    if (!repository) {
      return fail(response, 503, "SERVICE_UNAVAILABLE", "额度服务未初始化");
    }

    const balance = await repository.getBalance(identity.userId);
    const env = request.app.locals.env || process.env;
    const { resolveCosts } = await import("../lib/billing.js");

    response.json({
      code: "SUCCESS",
      message: "成功",
      data: {
        ...balance,
        costs: resolveCosts(env),
        mode: repository.mode || "unknown",
      },
    });
  } catch (error) {
    next(error);
  }
});