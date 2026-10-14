import type { SessionMeta } from '../api'

// 会话列表的筛选：默认只看没结束的，结束了的堆多了会把在干活的埋掉。
// "结束"就是主人点了"结束会话"（closed）。出错的、歇着的都还能接着说，算没结束。
// The session list filter: by default only unfinished sessions, since finished ones pile up and bury those at work.
// "Finished" means the owner chose "End session" (closed). Failed and resting sessions can still be continued, so they count as unfinished.

export type SessionShow = 'open' | 'closed' | 'all'
export const SESSION_SHOWS: readonly SessionShow[] = ['open', 'closed', 'all']
// "做完了"（done）是"闲着"里的一种：一轮说完、后台没有任务，不是停下来等你。 / "Done" is a kind of idle: a turn over with nothing in the background, not a stop to wait for you.
export type Shown = SessionMeta['status'] | 'done'

const KEY = 'idea-loom:session-show'

// 列表上显示的状态：进程不在了，"在跑""在等"都只是停在那里，算闲着。
// The status shown in the list: with the process gone, "running" and "waiting" only mean it stopped there, so it counts as idle.
export function shownStatus(s: Pick<SessionMeta, 'status' | 'live'> & { done_at?: number | null }): Shown {
  const status = s.live || s.status === 'closed' || s.status === 'error' ? s.status : 'idle'
  return status === 'idle' && s.done_at ? 'done' : status
}

// 做完的时刻，今天的只写几点几分。 / When it finished; today's show only the time.
export function doneAt(seconds: number, now = new Date()): string {
  const at = new Date(seconds * 1000)
  const today = at.toDateString() === now.toDateString()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${today ? '' : `${at.getMonth() + 1}/${at.getDate()} `}${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export function inShow(show: SessionShow, status: Shown): boolean {
  return show === 'all' || (show === 'closed') === (status === 'closed')
}

// 每一组有几个，和每个状态有几个。 / How many in each group, and how many in each status.
export function tally(sessions: (Pick<SessionMeta, 'status' | 'live'> & { done_at?: number | null })[]): { shows: Record<SessionShow, number>; statuses: Partial<Record<Shown, number>> } {
  const shows: Record<SessionShow, number> = { open: 0, closed: 0, all: 0 }
  const statuses: Partial<Record<Shown, number>> = {}
  for (const s of sessions) {
    const status = shownStatus(s)
    statuses[status] = (statuses[status] ?? 0) + 1
    for (const show of SESSION_SHOWS) if (inShow(show, status)) shows[show]++
  }
  return { shows, statuses }
}

export function readShow(raw: string | null): SessionShow {
  return (SESSION_SHOWS as readonly string[]).includes(raw ?? '') ? (raw as SessionShow) : 'open'
}

export function loadShow(): SessionShow {
  try {
    return readShow(localStorage.getItem(KEY))
  } catch {
    return 'open' // 没有 localStorage 也能用 / works without localStorage
  }
}

export function saveShow(show: SessionShow): void {
  try {
    localStorage.setItem(KEY, show)
  } catch {
    /* 同上 / as above */
  }
}
