/**
 * 主题管理：显式选择优先，其次跟随系统。
 * 结果写到 <html data-theme="light|dark">，样式表按该属性覆盖令牌。
 * 在 main.jsx 渲染前调用 initTheme()，避免首屏闪白。
 */

const STORAGE_KEY = "studio-theme";

export function getStoredTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function getSystemTheme() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "dark" : "light");
}

export function initTheme() {
  const theme = getStoredTheme() || getSystemTheme();
  applyTheme(theme);
  return theme;
}

export function setTheme(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* 隐私模式下 localStorage 可能不可用，此时仅本次生效 */
  }
  applyTheme(theme);
}
