import { useEffect, useState } from 'react'

// 打开着的页面怎么知道自己过时了：记住第一次 /api/health 的回答，以后的回答和它不一样就是过时。
// How an open page learns it is out of date: remember the first /api/health reply and call any later reply that differs stale.

/** 后端的两个版本记号。 / The backend's two version marks. */
export interface Version {
  // 进程启动的时刻，重启就变。 / When the process started; changes on restart.
  started: string | null
  // 磁盘上界面构建的记号，重新构建就变；没有构建时是 null。 / Mark of the UI build on disk; changes on rebuild, null when there is none.
  ui: number | null
}

const POLL_MS = 30_000

/**
 * 从 /api/health 的回答里取出版本记号；回答不像样（比如旧后端只回 ok）时是 null。
 * Pick the version marks out of an /api/health reply; null when the reply is not usable (an old backend that only says ok, say).
 */
export function parseVersion(reply: unknown): Version | null {
  if (typeof reply !== 'object' || reply === null) return null
  const r = reply as Record<string, unknown>
  if (r.ok !== true || typeof r.started !== 'string' || !r.started) return null
  return { started: r.started, ui: typeof r.ui === 'number' ? r.ui : null }
}

/**
 * 现在的回答和第一次的不一样，就是过时。任何一边没有，都不算。
 * Stale when the current reply differs from the first one. A missing side never counts.
 */
export function isStale(first: Version | null, now: Version | null): boolean {
  if (!first || !now) return false
  return first.started !== now.started || first.ui !== now.ui
}

async function fetchVersion(): Promise<Version | null> {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' })
    if (!response.ok) return null
    return parseVersion(await response.json())
  } catch {
    // 连不上不算过时：后端可能正在重启。 / A failed request is not staleness: the backend may be mid-restart.
    return null
  }
}

/**
 * 页面运行的东西过时了没有。每 30 秒问一次，标签页重新可见时也问一次；只报告，不自己刷新。
 * Whether what this page runs is out of date. Asks every 30 seconds and when the tab becomes visible again; it only reports and never reloads by itself.
 */
export function useStale(): boolean {
  const [stale, setStale] = useState(false)
  useEffect(() => {
    let first: Version | null = null
    let stopped = false
    const check = async () => {
      // 看不见的时候不问——但第一次一定要问：基准得是页面加载那一刻的版本，否则在后台打开的标签页
      // 会把"它第一次被看见时"的版本当基准，这之前的更新就漏掉了。
      // Do not ask while hidden — except the first time: the baseline must be the version at page load,
      // or a tab opened in the background would take the version at "first seen" as its baseline and
      // miss every update before that.
      if (first && document.visibilityState === 'hidden') return
      const now = await fetchVersion()
      if (stopped || !now) return
      if (!first) first = now
      else if (isStale(first, now)) setStale(true)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    void check()
    const timer = window.setInterval(() => void check(), POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  return stale
}
