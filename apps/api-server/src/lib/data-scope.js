/**
 * 「当前请求能看哪些项目」的统一判定。
 *
 * 导入批次与内容任务都需要同一套可见性规则——各写一份必然漂移，所以抽到这里。
 *
 * 三种情况：
 * - `AUTH_MODE=off`：本地演示，不做过滤（返回 null，仓储层不过滤）。
 *   这是刻意的向后兼容，否则单机演示看不到自己刚导入的东西。
 * - 已登录：只返回该用户是成员的项目；**额外包含未分配资源**。
 * - 匿名：返回空数组，看不到任何资源。
 *
 * 为什么已登录用户还能看见「未分配」资源
 * ------------------------------------
 * 历史数据与"导入时未指定项目"的资源没有归属。完全隐藏会让用户以为刚导入的东西
 * 丢了（前端还没有项目选择器）。折中：可见但明确标注 `projectId: null`，
 * 前端可提示"未分配，建议归入项目"。**等前端接上选择器后应关闭这个口子。**
 */

/** 未分配资源的哨兵值，与仓储层约定保持一致。 */
export const UNSCOPED = "__unscoped__";

export async function resolveVisibleProjectIds(request) {
  if ((request.identityMode || "off") === "off") return null;

  const identity = request.identity;
  if (!identity || identity.kind === "anonymous") return [];

  const repository = request.app.locals.projectsRepository;
  if (!repository?.listRolesForUser) return [UNSCOPED];

  const memberships = await repository.listRolesForUser(identity.userId);
  const projectIds = [...new Set(memberships.map((item) => item.projectId).filter(Boolean))];
  return [...projectIds, UNSCOPED];
}
