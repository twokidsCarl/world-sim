// 配色主题跟随系统，除非用户自行选择；该选择保存在
// localStorage 中，并以 data-theme 属性应用到根元素上。
// The colour theme follows the system unless the user picks one; the choice is kept in
// localStorage and applied as data-theme on the root element.

import { invalidateTheme } from '../plot/plot'

export type ThemeChoice = 'system' | 'light' | 'dark'

const KEY = 'strata-theme'

export function storedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(choice: ThemeChoice): void {
  if (choice === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = choice
  try {
    localStorage.setItem(KEY, choice)
  } catch {
    // 存储可能不可用；主题在本次访问中仍然生效。
    // Storage can be unavailable; the theme still applies for this visit.
  }
  invalidateTheme()
}
