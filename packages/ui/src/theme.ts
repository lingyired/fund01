export type AppTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'wzk-fund-theme'

export function getStoredTheme(): AppTheme {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    if (v === 'dark' || v === 'light') return v
  } catch {
    // ignore
  }
  return 'light'
}

export function applyTheme(theme: AppTheme) {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // ignore
  }
}
