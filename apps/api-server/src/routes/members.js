/**
 * 项目成员与角色管理。
 *
 * 只有 `owner` 能读写成员（`member:write`）。两条防线是刻意加的：
 *
 * 1. **不能移除或降级最后一个 owner**：否则项目会失去管理者，之后谁都进不来，
 *    只能改数据库救——这是最典型的"删多了"事故。
 * 2. **不能给自己降级**：等同于自杀式操作，且没有补偿路径。想换 owner 应该是
 *    "先把别人升为 owner，再降自己"，这个顺序不会被拦住。
 *
 * 角色集合由 lib/permissions.js 定义，这里只做校验与转发，不重复业务规则。
 */

import express from "express";

import {
  ACTIONS,
  ROLES,
  actionsForRole,
  isKnownRole,
  requireProjectPermission,
} from "../lib/permissions.js";

export const membersRouter = express.Router();

function fail(response, status, code, message) {
  return response.status(status).json({ code, message, data: null });
}

function projectIdOf(request) {
  return String(request.params.projectId || request.body?.projectId || "").trim() || null;
}

const requireMemberWrite = requireProjectPermission({
  action: ACTIONS.MEMBER_WRITE,
  resolveProjectId: projectIdOf,
});

const requireMemberRead = requireProjectPermission({
  action: ACTIONS.MEMBER_READ,
  resolveProjectId: projectIdOf,
});

/** 角色清单：供前端下拉与文档引用，避免前后端各写一份枚举。 */
membersRouter.get("/roles", (_request, response) => {
  response.json({
    code: "SUCCESS",
    message: "成功",
    data: {
      roles: Object.values(ROLES).map((role) => ({ code: role, actions: actionsForRole(role) })),
      actions: Object.values(ACTIONS),
    },
  });
});

membersRouter.get("/:projectId/members", requireMemberRead, async (request, response, next) => {
  try {
    const repository = request.app.locals.projectsRepository;
    const items = repository.listMembers ? await repository.listMembers(projectIdOf(request)) : [];
    response.json({ code: "SUCCESS", message: "成功", data: { items } });
  } catch (error) {
    next(error);
  }
});

membersRouter.put("/:projectId/members/:userId", requireMemberWrite, async (request, response, next) => {
  try {
    const repository = request.app.locals.projectsRepository;
    const projectId = projectIdOf(request);
    const userId = String(request.params.userId || "").trim();
    const roleCode = String(request.body?.roleCode || "").trim().toLowerCase();

    if (!userId) return fail(response, 400, "INVALID_PARAM", "缺少 userId");
    if (!isKnownRole(roleCode)) {
      return fail(response, 400, "INVALID_ROLE", `未知角色：${roleCode || "(空)"}`);
    }

    // 自我保护：不允许把自己降级（含移除自己）。换 owner 请先提升他人。
    if (userId === request.identity.userId && roleCode !== ROLES.owner) {
      const currentRole = await repository.findMemberRole(projectId, userId);
      if (currentRole === ROLES.owner) {
        return fail(
          response,
          409,
          "LAST_OWNER_GUARD",
          "不能降低自己的 owner 角色。请先把另一位成员提升为 owner，再调整自己的角色。",
        );
      }
    }

    // 最后一个 owner 保护：把唯一的 owner 降级会导致项目无人可管。
    const currentRole = await repository.findMemberRole(projectId, userId);
    if (currentRole === ROLES.owner && roleCode !== ROLES.owner) {
      const ownerTotal = repository.memberCount
        ? await repository.memberCount(projectId, ROLES.owner)
        : 0;
      if (ownerTotal <= 1) {
        return fail(
          response,
          409,
          "LAST_OWNER_GUARD",
          "项目至少需要保留一位 owner。请先提升其他成员为 owner 再调整。",
        );
      }
    }

    const member = await repository.upsertMember({ projectId, userId, roleCode });
    response.json({ code: "SUCCESS", message: "成员角色已更新", data: member });
  } catch (error) {
    next(error);
  }
});

membersRouter.delete("/:projectId/members/:userId", requireMemberWrite, async (request, response, next) => {
  try {
    const repository = request.app.locals.projectsRepository;
    const projectId = projectIdOf(request);
    const userId = String(request.params.userId || "").trim();

    if (!userId) return fail(response, 400, "INVALID_PARAM", "缺少 userId");

    if (userId === request.identity.userId) {
      return fail(
        response,
        409,
        "SELF_REMOVAL_GUARD",
        "不能移除自己。如需退出项目，请先让其他 owner 调整你的角色。",
      );
    }

    const currentRole = await repository.findMemberRole(projectId, userId);
    if (!currentRole) {
      return fail(response, 404, "MEMBER_NOT_FOUND", "该用户不是项目成员");
    }
    if (currentRole === ROLES.owner) {
      const ownerTotal = repository.memberCount
        ? await repository.memberCount(projectId, ROLES.owner)
        : 0;
      if (ownerTotal <= 1) {
        return fail(
          response,
          409,
          "LAST_OWNER_GUARD",
          "项目至少需要保留一位 owner，不能移除最后一位。",
        );
      }
    }

    const removed = await repository.removeMember({ projectId, userId });
    if (!removed) return fail(response, 404, "MEMBER_NOT_FOUND", "该用户不是项目成员");
    response.json({ code: "SUCCESS", message: "成员已移除", data: { projectId, userId } });
  } catch (error) {
    next(error);
  }
});
