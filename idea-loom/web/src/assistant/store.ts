import { create } from 'zustand'
import { currentLang, tr } from '../i18n'
import type { PageSnapshot } from './pageSnapshot'
import { note, recentActions } from './trail'
import { type TurnView, emptyTurn, fold, parseSse } from './turnView'

export type ConversationSummary = { id: string; created_at: string; title: string; turns: number }

type AssistantState = {
  open: boolean
  width: number
  conversationId: string | null
  turns: TurnView[]
  running: boolean
  ready: boolean
  notReadyReason: string | null
  openWishes: number
  history: ConversationSummary[]
  error: string | null
  offer: boolean // 卡住提示：要不要解释这一页 / the stuck offer
  setOpen: (open: boolean) => void
  setWidth: (width: number) => void
  setOffer: (offer: boolean) => void
  refresh: () => Promise<void>
  ask: (question: string, page: PageSnapshot, ideaId: string | null) => Promise<void>
  stop: () => Promise<void>
  newConversation: () => void
  loadHistory: () => Promise<void>
  openConversation: (id: string) => Promise<void>
}

export const MIN_WIDTH = 360
export const MAX_WIDTH = 640

const saved = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(`idea-loom:assistant:${key}`)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(`idea-loom:assistant:${key}`, JSON.stringify(value))
  } catch {
    /* 没有 localStorage 也能用 / works without localStorage */
  }
}

// 这里不在 React 里，语言取 i18n 里的那份副本。 / Outside React: the language is the copy kept in i18n.
const failed = (status: number) => tr(currentLang(), `请求失败（${status}）`, `Request failed (${status})`)

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    const detail = await res.json().then((b: { detail?: unknown }) => (typeof b.detail === 'string' ? b.detail : null), () => null)
    throw new Error(detail ?? failed(res.status))
  }
  return (await res.json()) as T
}

export const useAssistant = create<AssistantState>((set, get) => {
  const patchLast = (fn: (t: TurnView) => TurnView) => set((s) => ({ turns: s.turns.map((t, i) => (i === s.turns.length - 1 ? fn(t) : t)) }))

  // 读一条事件流直到结束；断了就从最后一个序号接着读，最多三次。
  // Read one event stream to its end; on a drop, resume from the last sequence number, three times at most.
  const consume = async (first: Response, conversationId: string) => {
    let response: Response | null = first
    let turn: number | null = null
    for (let attempt = 0; attempt < 4 && response; attempt++) {
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (reader) {
          const { done, value } = await reader.read()
          if (done) break
          const parsed = parseSse(buffer + decoder.decode(value, { stream: true }))
          buffer = parsed.rest
          if (parsed.turn !== null) turn = parsed.turn
          if (parsed.events.length) patchLast((t) => fold(t, parsed.events))
        }
      } catch {
        /* 连接断了，下面续传 / dropped; resume below */
      }
      const last = get().turns[get().turns.length - 1]
      if (!last || last.status !== 'running' || turn === null) break
      response = await fetch(`/api/assistant/conversations/${conversationId}/turns/${turn}/events?after=${last.lastSeq}`).catch(() => null)
    }
    const last = get().turns[get().turns.length - 1]
    if (last?.status === 'running') patchLast((t) => ({ ...t, status: 'failed', message: tr(currentLang(), '和后端的连接断了，没有等到回答。', 'The connection to the backend dropped before an answer arrived.') }))
    set({ running: false })
    void get().refresh()
  }

  return {
    open: saved('open', false),
    width: saved('width', 420),
    conversationId: saved<string | null>('conversation', null),
    turns: [],
    running: false,
    ready: true,
    notReadyReason: null,
    openWishes: 0,
    history: [],
    error: null,
    offer: false,
    setOpen: (open) => {
      save('open', open)
      set({ open })
    },
    setWidth: (width) => {
      const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)))
      save('width', w)
      set({ width: w })
    },
    setOffer: (offer) => set({ offer }),
    refresh: async () => {
      try {
        const s = await json<{ ready: boolean; not_ready_reason: string | null; open_wishes: number }>('/api/assistant')
        set({ ready: s.ready, notReadyReason: s.not_ready_reason, openWishes: s.open_wishes })
      } catch {
        set({ ready: false, notReadyReason: tr(currentLang(), '连不上后端', 'Cannot reach the backend') })
      }
    },
    ask: async (question, page, ideaId) => {
      if (get().running || !question.trim()) return
      set({ error: null, offer: false })
      note('ask', question)
      try {
        let id = get().conversationId
        if (!id || get().turns.length === 0) {
          id = (await json<{ id: string }>('/api/assistant/conversations', { method: 'POST' })).id
          save('conversation', id)
          set({ conversationId: id })
        }
        set((s) => ({ running: true, turns: [...s.turns, emptyTurn(question.trim(), page.title)] }))
        const res = await fetch(`/api/assistant/conversations/${id}/turns`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question, page, actions: recentActions(), idea_id: ideaId }),
        })
        if (!res.ok) {
          const detail = await res.json().then((b: { detail?: unknown }) => (typeof b.detail === 'string' ? b.detail : null), () => null)
          throw new Error(detail ?? failed(res.status))
        }
        await consume(res, id)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (get().turns.length && get().turns[get().turns.length - 1]!.status === 'running') patchLast((t) => ({ ...t, status: 'failed', message }))
        else set({ error: message })
        set({ running: false })
      }
    },
    stop: async () => {
      const id = get().conversationId
      if (id) await fetch(`/api/assistant/conversations/${id}/stop`, { method: 'POST' }).catch(() => undefined)
    },
    newConversation: () => {
      if (get().running) return
      save('conversation', null)
      set({ conversationId: null, turns: [], error: null })
    },
    loadHistory: async () => {
      try {
        set({ history: await json<ConversationSummary[]>('/api/assistant/conversations') })
      } catch {
        set({ history: [] })
      }
    },
    openConversation: async (id) => {
      if (get().running) return
      try {
        const c = await json<{ id: string; turns: { question: string; page_title: string; events: never[] }[] }>(`/api/assistant/conversations/${id}`)
        save('conversation', id)
        set({ conversationId: id, error: null, turns: c.turns.map((t) => {
          const view = fold(emptyTurn(t.question, t.page_title), t.events)
          return view.status === 'running' ? { ...view, status: 'stopped' as const } : view
        }) })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) })
      }
    },
  }
})
