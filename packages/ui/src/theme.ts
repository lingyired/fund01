import type {AppThemePref} from '@fund01/core'

const THEME_STORAGE_KEY = 'fund01-theme'

/** 读取用户主题偏好（默认 system） */
export function getStoredThemePref(): AppThemePref {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    if (v === 'system' || v === 'light' || v === 'dark') return v
  } catch {
    // ignore
  }
  return 'system'
}

/** 读取系统级配色（prefers-color-scheme） */
export function getSystemTheme(): 'light' | 'dark' {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  } catch {
    return 'light'
  }
}

/** 把偏好解析为实际生效的亮/暗主题 */
export function resolveTheme(pref: AppThemePref): 'light' | 'dark' {
  if (pref === 'system') return getSystemTheme()
  return pref
}

/**
 * 应用主题：
 *  1. <html data-theme> —— 供我们自己的 CSS 使用
 *  2. <html class="light|dark"> —— Radix Themes 官方的配色切换方式
 *
 * Radix 文档明确建议「不要用 <Theme appearance={resolvedTheme}>，而是依赖 class 切换」，
 * 因为 class 可以在 React 挂载前同步写入，避免首帧闪烁；
 * 其 CSS 里的 `:is(.dark,.dark-theme) :where(.radix-themes:not(.light,.light-theme))`
 * 正是为祖先 class 驱动主题而设计的。
 * 见 https://www.radix-ui.com/themes/docs/theme/dark-mode
 */
export function applyTheme(pref: AppThemePref) {
  const resolved = resolveTheme(pref)
  const root = document.documentElement
  root.dataset.theme = resolved
  root.classList.toggle('dark', resolved === 'dark')
  root.classList.toggle('light', resolved === 'light')
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref)
  } catch {
    // ignore
  }
}

/**
 * 在 React 挂载前同步应用已存主题偏好。
 * 必须在 createRoot().render() 之前调用：否则暗色偏好下 :root 会先按亮色色阶绘制，
 * 每次打开 popup 都会白闪一帧。
 */
export function initTheme(): AppThemePref {
  const pref = getStoredThemePref()
  applyTheme(pref)
  return pref
}

/** 订阅系统配色变化（仅当偏好为 system 时有意义），返回取消订阅函数 */
export function onSystemThemeChange(cb: (t: 'light' | 'dark') => void): () => void {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => cb(e.matches ? 'dark' : 'light')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  } catch {
    return () => undefined
  }
}
