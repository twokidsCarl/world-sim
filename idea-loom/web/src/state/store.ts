import { create } from 'zustand'
import { api } from '../api'
import type { State } from '../contract'

type Theme = 'light' | 'dark'

// 当前页面的身份，由共用的 Page 组件上报；以后小助手靠它知道你在看什么。
// The identity of the current page, reported by the shared Page component; the
// assistant will later use it to know what you are looking at.
export type PageIdentity = { title: string; lead: string }

type Store = {
  state: State | null
  error: string | null
  loading: boolean
  theme: Theme
  page: PageIdentity
  load: () => Promise<void>
  toggleTheme: () => void
  setPage: (page: PageIdentity) => void
}

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('idea-loom:theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* 没有 localStorage 也能用 / works without localStorage */
  }
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export const useStore = create<Store>((set, get) => ({
  state: null,
  error: null,
  loading: false,
  theme: initialTheme(),
  page: { title: '', lead: '' },
  load: async () => {
    set({ loading: true })
    try {
      set({ state: await api.state(), error: null, loading: false })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false })
    }
  },
  toggleTheme: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark'
    try {
      localStorage.setItem('idea-loom:theme', theme)
    } catch {
      /* 同上 / as above */
    }
    set({ theme })
  },
  setPage: (page) => set({ page }),
}))
