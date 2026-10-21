/**
 * 权限门与登录面板。
 *
 * `<PermissionGate>` 的设计意图是**只做一件事**：没权限就不渲染，并说明为什么。
 * 不做"禁用一个看起来正常的按钮"——灰色按钮不告诉用户原因，是常见的糟糕体验。
 * 因此无权限时优先渲染一句说明文案；只有调用方明确要求 `mode="disable"` 时才
 * 渲染禁用按钮（用于"按钮必须在原位、否则布局跳动"的工具栏场景）。
 *
 * 重要：**这不是安全边界**。后端才是。前端只负责不让用户白点一下吃 403。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  buildPermissionView,
  forbiddenHint,
} from "./permissions.js";
import {
  detectAuthMode,
  login,
  readRoleCode,
  readToken,
  register,
  saveSession,
  clearSession,
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

  const hint = forbiddenText || forbiddenHint(action, permissions?.roleCode);

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
 * 登录/注册面板。只在后端 authMode 为 local/strict 时显示。
 *
 * 交互取舍：注册与登录放在同一个面板，用 tab 切换。本地工具的用户量下，
 * 拆成两个页面只会增加点击次数。
 */
export function AuthPanel({
  apiBaseUrl,
  authMode,
  onAuthenticated,
  fetchImpl = fetch,
}) {
  const [tab, setTab] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = useCallback(
    async (event) => {
      event.preventDefault();
      setError("");
      setBusy(true);
      try {
        if (tab === "register") {
          await register(apiBaseUrl, { username, password }, fetchImpl);
        }
        const data = await login(apiBaseUrl, { username, password }, fetchImpl);
        saveSession({ token: data?.token, roleCode: data?.user?.roleCode || "" });
        onAuthenticated?.(data);
      } catch (cause) {
        setError(cause?.message || "操作失败");
      } finally {
        setBusy(false);
      }
    },
    [apiBaseUrl, fetchImpl, onAuthenticated, password, tab, username],
  );

  if (authMode === "off") return null;

  return (
    <section className="auth-panel" aria-label="登录">
      <div className="auth-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "login"}
          className={tab === "login" ? "is-active" : ""}
          onClick={() => setTab("login")}
        >
          登录
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "register"}
          className={tab === "register" ? "is-active" : ""}
          onClick={() => setTab("register")}
        >
          注册
        </button>
      </div>
      <form onSubmit={submit} className="auth-form">
        <label>
          用户名
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
            minLength={3}
          />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={tab === "register" ? "new-password" : "current-password"}
            required
            minLength={tab === "register" ? 8 : 1}
          />
        </label>
        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? "处理中" : tab === "register" ? "注册并登录" : "登录"}
        </button>
      </form>
      <p className="auth-note">
        当前后端为 <code>{authMode}</code> 鉴权模式。登录后按项目角色显示可执行操作。
      </p>
    </section>
  );
}

/**
 * 会话 hook：探测后端鉴权模式、读取本地 token/角色、给出 permissions 视图。
 *
 * 探测失败一律回落 off（与后端默认一致）。理由：网络抖动不该让用户突然
 * 看到"要求登录"，那比不提要求更困扰。
 */
export function usePermissionSession(apiBaseUrl, { projectId = "", fetchImpl = fetch } = {}) {
  const [authMode, setAuthMode] = useState("off");
  const [roleCode, setRoleCode] = useState(() => readRoleCode());
  const [token, setToken] = useState(() => readToken());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    detectAuthMode(apiBaseUrl, fetchImpl).then((mode) => {
      if (cancelled) return;
      setAuthMode(mode);
      // off 模式下清掉残留 token/角色，避免上一次登录的状态影响演示模式显示。
      if (mode === "off") {
        clearSession();
        setToken("");
        setRoleCode("");
      }
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, fetchImpl]);

  const permissions = useMemo(
    () => buildPermissionView({ authMode, roleCode: roleCode || null }),
    [authMode, roleCode],
  );

  const signOut = useCallback(() => {
    clearSession();
    setToken("");
    setRoleCode("");
  }, []);

  const signIn = useCallback((data) => {
    const nextToken = data?.token || "";
    const nextRole = data?.user?.roleCode || "";
    setToken(nextToken);
    setRoleCode(nextRole);
  }, []);

  return {
    authMode,
    token,
    roleCode,
    permissions,
    ready,
    projectId,
    signIn,
    signOut,
    setRoleCode,
  };
}
