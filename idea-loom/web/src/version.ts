import { useEffect, useState } from 'react'

// 打开着的页面怎么知道自己过时了：记住第一次 /api/health 的回答，以后的回答和它不一样就是过时；
// 过时了就在没有人打字的时候自己刷新。整页只有一个轮询，几个钩子共用它。
// How an open page learns it is out of date: remember the first /api/health reply and call any later reply that differs stale;
// once stale it reloads itself while nobody is typing. One poll serves the whole page and every hook shares it.

/** 后端的两个版本记号。 / The backend's two version marks. */
export interface Version {
  // 进程启动的时刻，重启就变。 / When the process started; changes on restart.
  started: string | null
  // 磁盘上界面构建的记号，重新构建就变；没有构建时是 null。 / Mark of the UI build on disk; changes on rebuild, null when there is none.
  ui: number | null
}

/** 后端的重启状况。 / Where the backend stands on restarting. */
export interface Restart {
  // 磁盘上的代码比正在跑的进程新。 / The code on disk is newer than the running process.
  needed: boolean
  // 后端会自己重启（本机用 idea-loom serve 起的）。 / The backend restarts itself (started locally with idea-loom serve).
  auto: boolean
  // 要重启了，在等什么；不在等是 null。 / What a pending restart waits for; null when none is pending.
  waiting: string | null
}

const POLL_MS = 10_000
const FAST_MS = 1_000
// 最后一次按键之后静多久才算"不在打字"。 / How long after the last keystroke typing counts as over.
export const IDLE_MS = 5_000

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

/** 从 /api/health 的回答里取出重启状况；旧后端没有的字段都当没有。 / Pick the restart state out of an /api/health reply; fields an old backend lacks count as absent. */
export function parseRestart(reply: unknown): Restart {
  const r = (typeof reply === 'object' && reply !== null ? reply : {}) as Record<string, unknown>
  return { needed: r.code_stale === true, auto: r.self_restart === true, waiting: typeof r.restart_waiting === 'string' ? r.restart_waiting : null }
}

/**
 * 现在的回答和第一次的不一样，就是过时。任何一边没有，都不算。
 * Stale when the current reply differs from the first one. A missing side never counts.
 */
export function isStale(first: Version | null, now: Version | null): boolean {
  if (!first || !now) return false
  return first.started !== now.started || first.ui !== now.ui
}

/**
 * 过时的页面现在能不能刷新：不能有打了字还没发出去的输入框，最后一次按键也要过去一会儿了。
 * Whether a stale page may reload now: no field may hold typed text not yet sent, and the last keystroke must be a while ago.
 */
export function shouldReload(p: { stale: boolean; unsaved: boolean; sinceInput: number }): boolean {
  return p.stale && !p.unsaved && p.sinceInput >= IDLE_MS
}

// ---------- 打字的痕迹 / traces of typing ----------

const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', 'tel', 'number', 'password', ''])
let lastInput = 0
const touched = new Set<HTMLElement>()

function isTextField(el: EventTarget | null): el is HTMLElement {
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.has(el.type)
  return el instanceof HTMLElement && el.isContentEditable
}

function textOf(el: HTMLElement): string {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? '')
}

/** 打过字、现在还有内容、还在页面上的输入框有没有。 / Whether any field that was typed into still holds text and is still on the page. */
function unsaved(): boolean {
  for (const el of [...touched]) {
    if (!el.isConnected || !textOf(el).trim()) touched.delete(el)
  }
  return touched.size > 0
}

function trackTyping(): void {
  document.addEventListener(
    'input',
    (e) => {
      if (!isTextField(e.target)) return
      lastInput = Date.now()
      touched.add(e.target)
    },
    true,
  )
}

// ---------- 共用的轮询 / the shared poll ----------

let first: Version | null = null
let latest: { version: Version | null; restart: Restart } = { version: null, restart: { needed: false, auto: false, waiting: null } }
let nextAt = 0
let fastUntil = 0
let polling = false
let ticker = 0
const listeners = new Set<() => void>()

async function poll(): Promise<void> {
  if (polling) return
  polling = true
  try {
    const response = await fetch('/api/health', { cache: 'no-store' })
    if (response.ok) {
      const reply: unknown = await response.json()
      const version = parseVersion(reply)
      if (version && !first) first = version
      latest = { version: version ?? latest.version, restart: parseRestart(reply) }
      listeners.forEach((f) => f())
    }
  } catch {
    // 连不上不算过时：后端可能正在重启。 / A failed request is not staleness: the backend may be mid-restart.
  } finally {
    polling = false
  }
}

function tick(): void {
  // 看不见的时候不问——但第一次一定要问：基准得是页面加载那一刻的版本，否则在后台打开的标签页
  // 会把"它第一次被看见时"的版本当基准，这之前的更新就漏掉了。
  // Do not ask while hidden — except the first time: the baseline must be the version at page load,
  // or a tab opened in the background would take the version at "first seen" as its baseline and
  // miss every update before that.
  if (first && document.visibilityState === 'hidden') return
  const now = Date.now()
  if (now < nextAt) return
  nextAt = now + (now < fastUntil ? FAST_MS : POLL_MS)
  void poll()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!ticker) {
    trackTyping()
    ticker = window.setInterval(tick, FAST_MS)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') nextAt = 0
    })
    tick()
  }
  return () => listeners.delete(listener)
}

/**
 * 后端要重启了：接下来两分钟每秒问一次，好尽快看到新的后端。
 * The backend is about to restart: ask every second for the next two minutes, to see the new backend as soon as possible.
 */
export function expectRestart(): void {
  fastUntil = Date.now() + 120_000
  nextAt = 0
}

/**
 * 后端的重启状况：代码是不是比进程新、会不是自己重启、在等什么。
 * The backend's restart state: whether the code is newer than the process, whether it restarts itself, what it waits for.
 */
export function useRestart(): Restart {
  const [restart, setRestart] = useState<Restart>(latest.restart)
  useEffect(() => subscribe(() => setRestart(latest.restart)), [])
  return restart
}

/**
 * 页面运行的东西过时了没有。过时了就在没有人打字的时候自己刷新；返回 true 表示过时了、正等着刷新。
 * Whether what this page runs is out of date. Once stale it reloads itself while nobody is typing; true means stale and waiting to reload.
 */
export function useStale(): boolean {
  const [stale, setStale] = useState(false)
  useEffect(() => subscribe(() => setStale(isStale(first, latest.version))), [])
  useEffect(() => {
    if (!stale) return
    const check = () => {
      if (shouldReload({ stale, unsaved: unsaved(), sinceInput: Date.now() - lastInput })) location.reload()
    }
    check()
    const timer = window.setInterval(check, 1_000)
    return () => window.clearInterval(timer)
  }, [stale])
  return stale
}
