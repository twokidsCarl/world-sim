// 把会话的事件流折叠成界面要画的东西：一条条消息、工具步骤、等你回答的卡片。
// Fold a session's event stream into what the UI draws: messages, tool steps and the cards awaiting your answer.

export type SessionEvent = { seq: number; type: string; [key: string]: unknown }

export type Question = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }

// 命令的一段：算哪一类、以前允许过没有。 / One segment of a command: its kind and whether it was allowed before.
export type Segment = { text: string; kind: string; known: boolean }

export type Item =
  | { kind: 'user'; seq: number; text: string; images: number }
  | { kind: 'text'; seq: number; text: string }
  | { kind: 'tool'; seq: number; id: string; name: string; label: string; input: Record<string, unknown>; state: 'running' | 'done' | 'failed'; result: string }
  | { kind: 'request'; seq: number; request_id: string; what: 'permission' | 'question' | 'plan'; tool: string; input: Record<string, unknown>; summary: string; decision: string | null; note: string; risky: string | null; segments: Segment[] }
  | { kind: 'note'; seq: number; tone: 'muted' | 'bad'; code: 'interrupted' | 'error' | 'failed'; message: string }

export type View = {
  items: Item[]
  status: 'idle' | 'running' | 'waiting' | 'closed' | 'error'
  waitingFor: string | null
  mode: string | null
  cost: number
  lastSeq: number
}

export const emptyView = (): View => ({ items: [], status: 'idle', waitingFor: null, mode: null, cost: 0, lastSeq: 0 })

function lastIndex(items: Item[], test: (item: Item) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i]!)) return i
  return -1
}

export function fold(view: View, events: SessionEvent[]): View {
  const next: View = { ...view, items: [...view.items] }
  let interrupted = false
  for (const e of events) {
    if (e.seq <= next.lastSeq) continue // 续传时可能重复 / may repeat on resume
    next.lastSeq = e.seq
    if (e.type === 'user') next.items.push({ kind: 'user', seq: e.seq, text: String(e.text ?? ''), images: Number(e.images ?? 0) })
    else if (e.type === 'text') {
      // 连着的几段话并成一段，读起来是一口气说的。 / Consecutive pieces of text merge, reading as one breath.
      const last = next.items[next.items.length - 1]
      if (last?.kind === 'text') next.items[next.items.length - 1] = { ...last, text: `${last.text}\n\n${String(e.text ?? '')}` }
      else next.items.push({ kind: 'text', seq: e.seq, text: String(e.text ?? '') })
    } else if (e.type === 'tool') {
      next.items.push({ kind: 'tool', seq: e.seq, id: String(e.id ?? ''), name: String(e.name ?? ''), label: String(e.label ?? ''), input: (e.input as Record<string, unknown>) ?? {}, state: 'running', result: '' })
    } else if (e.type === 'tool_result') {
      const i = lastIndex(next.items, (x) => x.kind === 'tool' && x.id === e.id)
      const item = next.items[i]
      if (item?.kind === 'tool') next.items[i] = { ...item, state: e.error ? 'failed' : 'done', result: String(e.text ?? '') }
    } else if (e.type === 'request') {
      next.items.push({ kind: 'request', seq: e.seq, request_id: String(e.request_id), what: e.kind as 'permission' | 'question' | 'plan', tool: String(e.tool ?? ''), input: (e.input as Record<string, unknown>) ?? {}, summary: String(e.summary ?? ''), decision: null, note: '', risky: typeof e.risky === 'string' ? e.risky : null, segments: Array.isArray(e.segments) ? (e.segments as Segment[]) : [] })
    } else if (e.type === 'resolved') {
      const i = lastIndex(next.items, (x) => x.kind === 'request' && x.request_id === e.request_id)
      const item = next.items[i]
      if (item?.kind === 'request') next.items[i] = { ...item, decision: String(e.decision ?? ''), note: String(e.note ?? '') }
    } else if (e.type === 'interrupted') {
      interrupted = true
      next.items.push({ kind: 'note', seq: e.seq, tone: 'muted', code: 'interrupted', message: '' })
    } else if (e.type === 'result') {
      next.cost = Number(e.cost_usd ?? next.cost)
      // 打断之后的那个"出错"的结果是打断本身，不算出错。 / The "error" result right after an interrupt is the interrupt itself, not a failure.
      if (e.is_error && !interrupted) next.items.push({ kind: 'note', seq: e.seq, tone: 'bad', code: 'failed', message: String(e.subtype ?? '') })
      interrupted = false
    } else if (e.type === 'error') next.items.push({ kind: 'note', seq: e.seq, tone: 'bad', code: 'error', message: String(e.message ?? '') })
    else if (e.type === 'status') {
      next.status = e.status as View['status']
      next.waitingFor = (e.waiting_for as string | null) ?? null
    } else if (e.type === 'mode') next.mode = String(e.mode)
  }
  return next
}

// 还在等你回答的卡片，可能不止一张：它会一次发起几个工具调用，每个都要你点头。
// （曾经只认最后一张，别的卡片没有按钮，会话就永远卡在那里。）
// The cards still awaiting your answer, possibly several: it can issue a few tool calls at once and each needs your nod.
// (Only the last used to count; the other cards had no buttons and the session hung there forever.)
export function pending(view: View): Extract<Item, { kind: 'request' }>[] {
  return view.items.filter((x): x is Extract<Item, { kind: 'request' }> => x.kind === 'request' && x.decision === null)
}
