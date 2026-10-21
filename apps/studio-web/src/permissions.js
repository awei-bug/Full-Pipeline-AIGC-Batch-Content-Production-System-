/**
 * 前端权限判定（与后端 apps/api-server/src/lib/permissions.js 保持同一套权限点）。
 *
 * 为什么前端要复制一份矩阵
 * ----------------------
 * 理想是后端下发"这个用户有哪些权限点"。但当前后端只在路由层做判定，没有
 * `/api/projects/:id/me` 这样的能力查询接口。两种选择：
 *
 * 1. 加一个后端接口，前端每次都要先问一遍——多一次往返，且首屏要多等一轮；
 * 2. 前端按角色复制一份矩阵，后端仍然是唯一权威（越权一定被拒）。
 *
 * 选 2，但必须说清代价：**前端矩阵只用于「隐藏按钮」，绝不作为安全边界**。
 * 后端拒绝才是真正的防线。两份矩阵不一致时，最坏结果是多显示或少显示一个按钮，
 * 不会造成越权。为了让不一致尽快暴露，`permissions.test.js` 里用同一组用例覆盖
 * 两边都关心的关键边界（editor 不能管成员、viewer 不能写等）。
 *
 * 权限点命名与后端完全一致：`资源:动作`。
 */

export const ACTIONS = {
  PROJECT_READ: "project:read",
  PROJECT_WRITE: "project:write",
  PROJECT_DELETE: "project:delete",
  MEMBER_READ: "member:read",
  MEMBER_WRITE: "member:write",
  CONTENT_READ: "content:read",
  CONTENT_WRITE: "content:write",
  CONTENT_PUBLISH: "content:publish",
  ASSET_READ: "asset:read",
  ASSET_WRITE: "asset:write",
  BILLING_READ: "billing:read",
};

export const ROLES = {
  OWNER: "owner",
  EDITOR: "editor",
  VIEWER: "viewer",
};

const ROLE_ACTIONS = {
  [ROLES.OWNER]: new Set(Object.values(ACTIONS)),
  [ROLES.EDITOR]: new Set([
    ACTIONS.PROJECT_READ,
    ACTIONS.CONTENT_READ,
    ACTIONS.CONTENT_WRITE,
    ACTIONS.ASSET_READ,
    ACTIONS.ASSET_WRITE,
    ACTIONS.MEMBER_READ,
  ]),
  [ROLES.VIEWER]: new Set([
    ACTIONS.PROJECT_READ,
    ACTIONS.CONTENT_READ,
    ACTIONS.ASSET_READ,
  ]),
};

/** 角色是否已知。未知角色返回 false，由调用方决定降级策略。 */
export function isKnownRole(roleCode) {
  return Boolean(ROLE_ACTIONS[String(roleCode || "").trim().toLowerCase()]);
}

/**
 * 判定角色是否具备权限点。
 *
 * **未知角色返回 false**，与后端一致：`role_code` 可能来自服务端的历史脏数据，
 * 放行会让"数据里有个奇怪角色"变成"看得见写操作按钮"。
 */
export function can(roleCode, action) {
  const role = String(roleCode || "").trim().toLowerCase();
  if (!isKnownRole(role) || !action) return false;
  return ROLE_ACTIONS[role].has(action);
}

export function actionsForRole(roleCode) {
  const role = String(roleCode || "").trim().toLowerCase();
  return ROLE_ACTIONS[role] ? [...ROLE_ACTIONS[role]] : [];
}

/**
 * 组装前端用的权限视图。
 *
 * `authMode === "off"` 时一律允许：后端在这个模式下也放行（标记 bypass），
 * 前端若仍隐藏按钮，会让本地演示出现"功能看着没了"的困惑，与后端行为不一致。
 *
 * @param {{authMode: string, roleCode: string|null}} params
 */
export function buildPermissionView({ authMode = "off", roleCode = null }) {
  const bypass = authMode === "off";
  return {
    bypass,
    roleCode: roleCode || null,
    can(action) {
      if (bypass) return true;
      return can(roleCode, action);
    },
    /**
     * 未登录（非 off 模式下没有角色）时，只读类动作也隐藏——
     * 因为拿不到数据，显示按钮只会点出 401。
     */
    isAuthenticated: bypass || Boolean(roleCode),
  };
}

/** 无权限时按钮的提示文案。统一出口，避免各处各写一句不一致的话。 */
export function forbiddenHint(action, roleCode) {
  if (action === ACTIONS.MEMBER_WRITE) {
    return "只有项目 owner 可以管理成员";
  }
  if (action === ACTIONS.CONTENT_PUBLISH) {
    return "只有项目 owner 可以发布";
  }
  if (action === ACTIONS.CONTENT_WRITE || action === ACTIONS.ASSET_WRITE) {
    return roleCode ? `当前角色（${roleCode}）为只读，无法编辑` : "请先登录";
  }
  return "当前角色无权执行该操作";
}
