/**
 * 权限门与会话 hook。
 *
 * `<PermissionGate>` 的设计意图是**只做一件事**：没权限就不渲染，并说明为什么。
 * 不做"禁用一个看起来正常的按钮"——灰色按钮不告诉用户原因，是常见的糟糕体验。
 * 因此无权限时优先渲染一句说明文案；只有调用方明确要求 `mode="disable"` 时才
 * 渲染禁用按钮（用于"按钮必须在原位、否则布局跳动"的工具栏场景）。
 *
 * 重要：**这不是安全边界**。后端才是。前端只负责不让用户白点一下吃 403。
 *
 * 登录不再由本应用提供：唯一登录入口是云购商家后台（`MERCHANT_LOGIN_URL`）。
 * 本文件因此没有登录表单，只有"未登录时引导去商家后台"的说明块。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  buildPermissionView,
  forbiddenHint,
} from "./permissions.js";
import {
  MERCHANT_LOGIN_HINT,
  MERCHANT_LOGIN_URL,
  clearSession,
  detectAuthMode,
  fetchMyRoles,
  readToken,
  hydrateSession,
  readRoleCode,
  saveSession,
} from "./session.js";

/**
 * 权限门。
 *
 * @param {object} props
 * @param {object} props.permissions buildPermissionView() 的返回值
 * @param {string} props.action 需要的权限点
 * @param {React.ReactNode} props.children 有权限时渲染的内容
 * @param {"hide"|"disable"} [props.mode] 无权限时的表现，默认 hide
 * @param {string} [props.forbiddenText] 自定义提示文案
 */
export function PermissionGate({
  permissions,
  action,
  children,
  mode = "hide",
  forbiddenText = "",
}) {
  const allowed = permissions?.can(action) ?? false;
  if (allowed) return children;

  const hint = forbiddenText || forbiddenHint(action, permissions?.roleCode, permissions?.authenticated);

  if (mode === "disable") {
    return (
      <span className="permission-disabled" title={hint}>
        <button type="button" className="primary-button" disabled>
          无权限
        </button>
      </span>
    );
  }

  return (
    <p className="permission-hint" role="note" aria-label="权限提示">
      {hint}
    </p>
  );
}

/**
 * 未检测到统一会话时的引导块。
 *
 * 明确指向唯一登录入口，而不是在原地再开一个登录表单——用户已明确要求
 * 全链路只能有一个登录页。`target="_blank"` + `rel="noopener noreferrer"`
 * 保证商家后台不会拿到本页的 `window.opener`。
 */
export function MerchantLoginPrompt({ authMode = "strict", onRefresh }) {
  return (
    <section className="merchant-login-prompt" aria-label="统一登录提示">
      <p>
        {MERCHANT_LOGIN_HINT}。
        <a href={MERCHANT_LOGIN_URL} target="_blank" rel="noopener noreferrer">
          前往商家后台登录
        </a>
      </p>
      <p className="merchant-login-note">
        当前内容平台鉴权模式为 <code>{authMode}</code>，身份统一由云购商家会话签发。
        在商家后台登录后回到本页，点击下方按钮重新检查。
      </p>
      {onRefresh ? (
        <button type="button" className="secondary-button" onClick={onRefresh}>
          我已登录，重新检查会话
        </button>
      ) : null}
    </section>
  );
}

/**
 * 会话 hook：探测后端鉴权模式、从统一会话换 token、从服务端取真实角色。
 *
 * 角色来源是 **`GET /api/auth/me/projects`（服务端权威）**，不是本地缓存。
 * 本地缓存只在首屏渲染时作为占位，拿到服务端结果后立即覆盖——否则用户
 * 可能因为缓存里是 owner 而短暂看到不该看到的按钮。
 *
 * 探测失败或未知模式一律按 `strict`（fail-closed），只有后端明确报 `off`
 * 才进入演示模式。
 */
export function usePermissionSession(apiBaseUrl, { projectId = "", fetchImpl = fetch } = {}) {
  const [authMode, setAuthMode] = useState("strict");
  const [roleCode, setRoleCode] = useState(() => readRoleCode());
  const [token, setToken] = useState(() => readToken());
  const [memberships, setMemberships] = useState([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    detectAuthMode(apiBaseUrl, fetchImpl).then((mode) => {
      if (cancelled) return;
      setAuthMode(mode);
      // off 模式下清掉残留 token/角色，避免上一次会话的状态影响演示模式显示。
      if (mode === "off") {
        clearSession();
        setToken("");
        setRoleCode("");
        setReady(true);
        return;
      }
      // 非 off 模式：向云购确认会话。hydrateSession 会先校验本地缓存的 token，
      // 失效或过期时自动用共享 Cookie 换一个新的——首屏不再依赖手动刷新。
      hydrateSession(fetchImpl, undefined, apiBaseUrl).then((nextToken) => {
        if (cancelled) return;
        setToken(nextToken);
        setReady(true);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, fetchImpl]);

  // 已登录时向服务端确认真实角色。这是权限显示的唯一可信来源。
  useEffect(() => {
    if (!token || authMode === "off") return undefined;
    let cancelled = false;
    fetchMyRoles(apiBaseUrl, fetchImpl).then((data) => {
      if (cancelled || !data) return;
      setRoleCode(data.platformRole || "");
      setMemberships(data.memberships || []);
      // 服务端结果覆盖本地缓存，下次首屏直接用它。
      saveSession({ token, roleCode: data.platformRole || "" });
    });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, authMode, fetchImpl, token]);

  const permissions = useMemo(
    () => buildPermissionView({ authMode, roleCode: roleCode || null, authenticated: Boolean(token) }),
    [authMode, roleCode, token],
  );

  /**
   * 重新读取统一会话。
   *
   * 用户在商家后台登录后回到本页，点"我已登录，重新检查"就走这里：
   * 清掉可能失效的本地 token，再向云购换一次。
   */
  const refresh = useCallback(async () => {
    clearSession();
    setRoleCode("");
    setMemberships([]);
    const nextToken = await hydrateSession(fetchImpl, undefined, apiBaseUrl);
    setToken(nextToken);
    return nextToken;
  }, [apiBaseUrl, fetchImpl]);

  return {
    authMode,
    token,
    roleCode,
    memberships,
    permissions,
    ready,
    projectId,
    refresh,
    setRoleCode,
  };
}