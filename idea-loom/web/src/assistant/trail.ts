// 操作轨迹：换页、改筛选、点了什么、接口报错、提问，以及每一页的停留时长。
// 最近四十条留在内存里随提问带上；全部定时发给后端存在本机，供统计和回看用。不记输入的文字。
// The action trail: navigation, filter changes, clicks, API errors, questions, and the
// dwell time on each page. The last forty stay in memory and go with each question;
// everything is flushed to the backend and kept on this machine for statistics and
// reviews. Typed text is never recorded.
import { currentLang, tr } from '../i18n'
import { type Action, Dwell } from './stuck'

const KEEP = 40
const recent: Action[] = []
let unsent: Action[] = []
const listeners = new Set<() => void>()

let current = { url: '', title: '', idea: '' }
let dwell: Dwell | null = null

const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 120)

export function note(kind: Action['kind'], text: string, extra: Partial<Action> = {}) {
  const action: Action = { at: new Date().toISOString(), kind, url: current.url, text: clip(text), idea: current.idea, ...extra }
  recent.push(action)
  if (recent.length > KEEP) recent.shift()
  unsent.push(action)
  listeners.forEach((fn) => fn())
}

export const recentActions = (): Action[] => [...recent]
export const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn))

function closeDwell() {
  if (!dwell || !current.url) return
  const seconds = dwell.seconds(Date.now())
  if (seconds >= 1) unsent.push({ at: new Date().toISOString(), kind: 'dwell', url: current.url, text: clip(current.title), seconds, idea: current.idea })
}

// 换页或改筛选时调用。 / Called on navigation or a filter change.
export function arrive(url: string, title: string, idea: string) {
  const samePath = url.split('?')[0] === current.url.split('?')[0]
  if (url === current.url) {
    current.title = title
    return
  }
  if (!samePath) closeDwell()
  const before = current.url
  current = { url, title, idea }
  const none = tr(currentLang(), '没有', 'none')
  if (samePath) note('filter', `${before.split('?')[1] ?? none} → ${url.split('?')[1] ?? none}`)
  else {
    dwell = new Dwell(Date.now())
    note('navigate', title || url)
  }
}

export function flush(useBeacon = false) {
  if (useBeacon) closeDwell()
  if (unsent.length === 0) return
  const body = JSON.stringify({ actions: unsent })
  unsent = []
  if (useBeacon && navigator.sendBeacon) navigator.sendBeacon('/api/trail', new Blob([body], { type: 'application/json' }))
  else void fetch('/api/trail', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => undefined)
}

let installed = false
export function install() {
  if (installed) return
  installed = true
  document.addEventListener(
    'click',
    (e) => {
      dwell?.activity(Date.now())
      const el = (e.target as Element | null)?.closest('button, a, [role="tab"], summary, select')
      if (!el || el.closest('[data-assistant]')) return
      const name = el.getAttribute('aria-label') || el.textContent || ''
      if (name.trim()) note('click', name)
    },
    true,
  )
  for (const type of ['keydown', 'scroll', 'pointermove'] as const) document.addEventListener(type, () => dwell?.activity(Date.now()), { capture: true, passive: true })
  document.addEventListener('visibilitychange', () => dwell?.setVisible(document.visibilityState === 'visible', Date.now()))
  window.addEventListener('pagehide', () => flush(true))
  setInterval(() => flush(), 20_000)
}
