// 哪些会话在等主人回答。整个界面共用一份：左侧栏「自我进化」上的数、每一页上的提醒气泡都读它。
// App 里的定时取数把它刷新；会话列表页和会话视图读到新状态时也顺手更新，回答完气泡马上就没了。
// Which sessions are waiting for the owner's answer. One copy for the whole UI: the count on "Self-evolution" in
// the navigation and the reminder bubble on every page both read it. App's periodic fetch refreshes it; the
// session list and a session's view update it too whenever they read a new state, so a bubble goes as soon as
// the question is answered.

import { create } from 'zustand'
import { type SessionMeta, api } from '../api'

// 在等回答的会话，先等的在前。 / The sessions waiting for an answer, the longest-waiting first.
export function waitingOf(sessions: readonly SessionMeta[]): SessionMeta[] {
  return sessions.filter((s) => s.status === 'waiting').sort((a, b) => a.updated_at - b.updated_at)
}

// 一个会话的新状态并进去：还在等就换成新的，不等了就拿掉。 / Fold one session's new state in: replace it while it waits, drop it once it does not.
export function merge(waiting: readonly SessionMeta[], meta: SessionMeta): SessionMeta[] {
  const rest = waiting.filter((s) => s.id !== meta.id)
  return meta.status === 'waiting' ? waitingOf([...rest, meta]) : rest
}

// 要弹气泡的：那个会话自己的视图正开着的不弹。 / Those that get a bubble: none for a session whose own view is open.
export function bubbles(waiting: readonly SessionMeta[], onScreen: Readonly<Record<string, number>>): SessionMeta[] {
  return waiting.filter((s) => !onScreen[s.id])
}

type WaitingState = {
  waiting: SessionMeta[]
  // 正开着的会话视图：编号 → 开着几个。 / Session views open now: id → how many.
  onScreen: Record<string, number>
  load: () => Promise<void>
  take: (sessions: readonly SessionMeta[]) => void
  update: (meta: SessionMeta) => void
  // 会话视图挂上时调用，返回卸下时调用的函数。 / Called when a session view mounts; returns the function to call when it unmounts.
  enter: (id: string) => () => void
}

export const useWaiting = create<WaitingState>((set, get) => ({
  waiting: [],
  onScreen: {},
  load: () =>
    api.sessions().then(
      (list) => get().take(list.sessions),
      () => undefined, // 取不到就留着上一次的 / on failure, keep the last known state
    ),
  take: (sessions) => set({ waiting: waitingOf(sessions) }),
  update: (meta) => set((s) => ({ waiting: merge(s.waiting, meta) })),
  enter: (id) => {
    set((s) => ({ onScreen: { ...s.onScreen, [id]: (s.onScreen[id] ?? 0) + 1 } }))
    return () => set((s) => ({ onScreen: { ...s.onScreen, [id]: Math.max(0, (s.onScreen[id] ?? 0) - 1) } }))
  },
}))
