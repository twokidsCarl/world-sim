import { useCallback } from 'react'
import { create } from 'zustand'
import { type Proposals, api } from '../api'
import type { State, SyncResult, SyncStatus } from '../contract'
import { type Lang, type T, applyLang, initialLang } from '../i18n'

type Theme = 'light' | 'dark'

// 当前页面的身份，由共用的 Page 组件上报；以后小助手靠它知道你在看什么。
// The identity of the current page, reported by the shared Page component; the
// assistant will later use it to know what you are looking at.
export type PageIdentity = { title: string; lead: string; idea?: string }

type Store = {
  state: State | null
  error: string | null
  loading: boolean
  theme: Theme
  lang: Lang
  page: PageIdentity
  sync: SyncStatus | null
  proposals: Proposals | null
  syncing: boolean
  syncResult: SyncResult | null
  runSync: () => Promise<void>
  clearSyncResult: () => void
  load: () => Promise<void>
  toggleTheme: () => void
  toggleLang: () => void
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
  lang: initialLang(),
  page: { title: '', lead: '' },
  sync: null,
  proposals: null,
  syncing: false,
  syncResult: null,
  runSync: async () => {
    set({ syncing: true, syncResult: null })
    try {
      set({ syncResult: await api.sync() })
    } catch (e) {
      set({ syncResult: { ok: false, pr_url: null, message: e instanceof Error ? e.message : String(e) } })
    }
    set({ syncing: false })
    await get().load()
  },
  clearSyncResult: () => set({ syncResult: null }),
  load: async () => {
    set({ loading: true })
    try {
      const [state, sync, proposals] = await Promise.all([api.state(), api.syncStatus().catch(() => null), api.proposals().catch(() => null)])
      set({ state, sync, proposals, error: null, loading: false })
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
  toggleLang: () => {
    const lang: Lang = get().lang === 'en' ? 'zh' : 'en'
    applyLang(lang)
    set({ lang })
  },
  setPage: (page) => set({ page }),
}))

// 界面语言，和按它二选一的 t。 / The UI language, and the t that chooses by it.
export const useLang = (): Lang => useStore((s) => s.lang)

export function useT(): T {
  const lang = useLang()
  return useCallback((zh: string, en: string) => (lang === 'en' ? en : zh), [lang])
}
