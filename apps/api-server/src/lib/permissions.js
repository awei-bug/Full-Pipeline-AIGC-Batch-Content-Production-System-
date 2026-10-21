/**
 * 项目级权限矩阵（内容平台）。
 *
 * 为什么是"项目级"而不是"全局角色"
 * ------------------------------
 * 这个平台的核心数据单元是 `project`：商品、内容任务、作品、额度都挂在项目下。
 * 全局角色（admin/member）无法表达"我是 A 项目的美术、B 项目的只读"这种真实情况，
 * 而且 `project_members` 表本来就是按项目存 `role_code` 的——沿用既有表结构，
 * 不另造一套全局角色。
 *
 * 角色（`project_members.role_code`）
 * ----------------------------------
 * - `owner`  创建者，全权，可管理成员
 * - `editor` 可编辑项目内容（商品、内容任务、素材），不能管理成员
 * - `viewer` 只读
 *
 * 权限点（而非直接把角色写进路由）
 * ------------------------------
 * 路由检查 `can(action)`，不是 `role === 'owner'`。这样将来加角色（比如 `reviewer`
 * 只能审核不能发布）只需改这张表，不用在路由里加 if。这是把"策略"和"执行"分开。
 *
 * 与 AUTH_MODE=off 的关系
 * ----------------------
 * `off` 模式下没有真实身份，所有检查放行并标记 `bypass=true`。理由：这个模式
 * 服务于双击启动的本地单用户演示，那里"权限"没有意义；强加检查只会让既有使用
 * 方式坏掉。但**检查本身仍然记录**（`reason` 字段），便于在测试里断言哪些动作
 * 被放行过——不做静默的"假放行"。
 */

/** 权限点。命名用 `资源:动作`，与客服项目的 `service:read` 风格保持一致。 */
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

  // --- 平台级权限点 ---
  //
  // 为什么需要这一类：`import_batches` / `content_jobs` / `products` 这几张表
  // **没有 project_id**（见 infra/sql/005_import_batch_domain.sql），它们只按
  // batch_id 关联，是平台级共享资源，不是项目内资源。强行把它们塞进项目级校验
  // 只能靠"猜一个项目 id"，那是假的隔离。
  //
  // 诚实的做法是承认它们是平台级资源，用独立权限点，并且**只给可信角色**。
  // 将来若要把批次/任务纳入项目隔离，需要给表加 project_id 并回填——那是
  // 独立的数据迁移工作，不该混在权限改动里。
  PLATFORM_IMPORT: "platform:import",
  PLATFORM_GENERATE: "platform:generate",
  PLATFORM_AI_CHAT: "platform:ai_chat",
};

export const ROLES = {
  owner: "owner",
  editor: "editor",
  viewer: "viewer",
};

/**
 * 角色 → 权限集合。
 *
 * `viewer` 只能读。`editor` 能读写项目内容与素材、也能跑平台级生成与导入
 * （这些是日常生产动作），但**不能**管理成员、删除项目、发布到大仓
 * （发布是对外动作，误操作的代价比其他写操作高一个量级）。
 * `owner` 全有。
 */
const ROLE_ACTIONS = {
  [ROLES.owner]: new Set(Object.values(ACTIONS)),
  [ROLES.editor]: new Set([
    ACTIONS.PROJECT_READ,
    ACTIONS.CONTENT_READ,
    ACTIONS.CONTENT_WRITE,
    ACTIONS.ASSET_READ,
    ACTIONS.ASSET_WRITE,
    ACTIONS.MEMBER_READ,
    ACTIONS.PLATFORM_IMPORT,
    ACTIONS.PLATFORM_GENERATE,
    ACTIONS.PLATFORM_AI_CHAT,
  ]),
  [ROLES.viewer]: new Set([
    ACTIONS.PROJECT_READ,
    ACTIONS.CONTENT_READ,
    ACTIONS.ASSET_READ,
  ]),
};

/** 平台级权限点：不需要 projectId，只按身份与角色判定。 */
export const PLATFORM_ACTIONS = new Set([
  ACTIONS.PLATFORM_IMPORT,
  ACTIONS.PLATFORM_GENERATE,
  ACTIONS.PLATFORM_AI_CHAT,
]);

export function actionsForRole(roleCode) {
  const role = String(roleCode || "").trim().toLowerCase();
  const set = ROLE_ACTIONS[role];
  return set ? [...set] : [];
}

export function isKnownRole(roleCode) {
  return Boolean(ROLE_ACTIONS[String(roleCode || "").trim().toLowerCase()]);
}

/**
 * 判定一个成员角色是否具备某权限。
 * @returns {{allowed: boolean, bypass?: boolean, reason: string}}
 */
export function can(roleCode, action) {
  if (!action) return { allowed: false, reason: "未指定权限点" };
  const role = String(roleCode || "").trim().toLowerCase();
  if (!isKnownRole(role)) {
    // 未知角色一律拒绝，而不是放行——`role_code` 是外部可写的（邀请接口），
    // 放行等于把拼写错误变成提权漏洞。
    return { allowed: false, reason: `未知角色：${roleCode || "(空)"}` };
  }
  const allowed = ROLE_ACTIONS[role].has(action);
  return { allowed, reason: allowed ? `角色 ${role} 允许 ${action}` : `角色 ${role} 不允许 ${action}` };
}

/**
 * 组合判定：在 AUTH_MODE=off 下放行并标记 bypass。
 *
 * @param {object} params
 * @param {string} params.authMode off / local / strict
 * @param {string|null} params.roleCode 调用方在项目中的角色（无成员记录时为 null）
 * @param {string} params.action 权限点
 */
export function evaluateAccess({ authMode, roleCode, action }) {
  if (authMode === "off") {
    return { allowed: true, bypass: true, reason: "AUTH_MODE=off，本地演示模式放行" };
  }
  if (!roleCode) {
    return { allowed: false, reason: "不是该项目成员" };
  }
  return can(roleCode, action);
}

/**
 * 平台级守卫：资源没有项目维度时使用。
 *
 * 适用对象：`import_batches` / `content_jobs` / `products` / AI 对话 / data-hub 同步。
 * 这些表没有 `project_id`，无法做项目级隔离。判据是"身份存在且角色具备平台级权限点"。
 *
 * 角色从哪来？平台级动作不绑定具体项目，但角色是项目级的概念。当前实现：
 * 取请求头 `X-Content-Role`（由前端在登录后、选定项目时带上），或退化为
 * 询问任一项目的成员角色。为保持简单与可预测，这里**只接受显式声明的角色**，
 * 不做"扫所有项目取最高角色"——那种隐式放宽很难审计。
 *
 * 没有角色的已登录用户按 `viewer` 处理（只能读），不会误放行写操作。
 */
export function requirePlatformPermission({ action }) {
  return function platformPermissionGuard(request, response, next) {
    const authMode = request.identityMode || "off";

    if (authMode === "off") {
      request.access = { allowed: true, bypass: true, reason: "AUTH_MODE=off，本地演示模式放行" };
      return next();
    }

    const identity = request.identity;
    if (!identity || identity.kind === "anonymous") {
      return response.status(401).json({
        code: "UNAUTHORIZED",
        message: "请先登录",
        data: null,
      });
    }

    const declared = String(
      request.headers["x-content-role"] || request.headers["X-Content-Role"] || "",
    )
      .trim()
      .toLowerCase();
    // 未声明角色按 viewer 处理：能读，不能写。宁可少放行也不隐式放宽。
    const roleCode = isKnownRole(declared) ? declared : ROLES.viewer;

    const verdict = can(roleCode, action);
    request.access = { ...verdict, roleCode };

    if (!verdict.allowed) {
      return response.status(403).json({
        code: "FORBIDDEN",
        message: "当前角色无权执行该操作（平台级）",
        data: null,
      });
    }
    return next();
  };
}

/**
 * 路由守卫工厂：要求请求身份在指定项目中具备某权限。
 *
 * `resolveProjectId(request)` 让每个路由自己说明"项目 id 从哪来"——
 * 有的在 body，有的在 path，有的要从 jobId 反查。把这件事交给调用方，
 * 守卫本身保持通用。
 *
 * @param {object} options
 * @param {string} options.action 需要的权限点
 * @param {(request: object) => string|null} options.resolveProjectId
 */
export function requireProjectPermission({ action, resolveProjectId }) {
  return async function projectPermissionGuard(request, response, next) {
    try {
      const authMode = request.identityMode || "off";
      const identity = request.identity;

      // off 模式没有真实身份，直接放行（但记 reason 便于测试断言）。
      if (authMode === "off") {
        request.access = evaluateAccess({ authMode, roleCode: null, action });
        return next();
      }

      if (!identity || identity.kind === "anonymous") {
        return response.status(401).json({
          code: "UNAUTHORIZED",
          message: "请先登录",
          data: null,
        });
      }

      const projectId = resolveProjectId(request);
      if (!projectId) {
        return response.status(400).json({
          code: "INVALID_PARAM",
          message: "缺少项目标识",
          data: null,
        });
      }

      const repository = request.app.locals.projectsRepository;
      const roleCode = repository ? await repository.findMemberRole(projectId, identity.userId) : null;
      const verdict = evaluateAccess({ authMode, roleCode, action });
      request.access = verdict;

      if (!verdict.allowed) {
        // 404 而不是 403：对非成员暴露"项目存在但你没权限"本身就是信息泄漏，
        // 攻击者可以据此枚举哪些项目 id 真实存在。
        const status = roleCode ? 403 : 404;
        return response.status(status).json({
          code: status === 403 ? "FORBIDDEN" : "PROJECT_NOT_FOUND",
          message: status === 403 ? "当前角色无权执行该操作" : "项目不存在或无权访问",
          data: null,
        });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}
