// 把会话的事件流折叠成界面要画的东西：一条条消息、工具步骤、等你回答的卡片。
// Fold a session's event stream into what the UI draws: messages, tool steps and the cards awaiting your answer.
import type { TokenUsage } from '../api'

export type SessionEvent = { seq: number; type: string; [key: string]: unknown }

export type Question = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }

// 命令的一段：算哪一类、以前允许过没有。 / One segment of a command: its kind and whether it was allowed before.
export type Segment = { text: string; kind: string; known: boolean }

// 一个后台任务（子 Agent、后台命令）的近况。 / How a background task (a subagent, a background command) is doing.
export type Task = { state: 'started' | 'progress' | 'done'; status: string | null; lastTool: string | null; summary: string; toolUses: number | null }

export type Item =
  | { kind: 'user'; seq: number; text: string; images: number }
  | { kind: 'text'; seq: number; text: string }
  // 派子 Agent 的那一步，下面挂着子 Agent 自己的每一步（children）和它的近况（task）。
  // The step that launched a subagent holds the subagent's own steps (children) and how it is doing (task).
  | { kind: 'tool'; seq: number; id: string; name: string; label: string; input: Record<string, unknown>; state: 'running' | 'done' | 'failed'; result: string; children: Item[]; task: Task | null }
  | { kind: 'request'; seq: number; request_id: string; what: 'permission' | 'question' | 'plan'; tool: string; input: Record<string, unknown>; summary: string; decision: string | null; note: string; risky: string | null; segments: Segment[] }
  | { kind: 'note'; seq: number; tone: 'muted' | 'bad'; code: 'interrupted' | 'error' | 'failed' | 'resumed'; message: string }

export type View = {
  items: Item[]
  status: 'idle' | 'running' | 'waiting' | 'closed' | 'error'
  waitingFor: string | null
  mode: string | null
  // 用掉的 token：一轮说完时是准数，干活时是边干边加的估计。 / Tokens used: exact when a turn ends, a running estimate while it works.
  tokens: TokenUsage | null
  lastSeq: number
}

export const emptyView = (): View => ({ items: [], status: 'idle', waitingFor: null, mode: null, tokens: null, lastSeq: 0 })

function lastIndex(items: Item[], test: (item: Item) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i]!)) return i
  return -1
}

// 在一层层的步骤里找到编号是 id 的那一步，换成 change 给出的新样子；找不到就是 null。
// Find the step with this id at any depth and replace it with what `change` returns; null when not found.
function updateTool(items: Item[], id: string, change: (item: Extract<Item, { kind: 'tool' }>) => Item): Item[] | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind !== 'tool') continue
    if (item.id === id) return [...items.slice(0, i), change(item), ...items.slice(i + 1)]
    const inner = item.children.length ? updateTool(item.children, id, change) : null
    if (inner) return [...items.slice(0, i), { ...item, children: inner }, ...items.slice(i + 1)]
  }
  return null
}

// 加一条：连着的几段话并成一段，读起来是一口气说的。 / Add one; consecutive pieces of text merge, reading as one breath.
function add(items: Item[], item: Item): Item[] {
  const last = items[items.length - 1]
  if (item.kind === 'text' && last?.kind === 'text') return [...items.slice(0, -1), { ...last, text: `${last.text}\n\n${item.text}` }]
  return [...items, item]
}

export function fold(view: View, events: SessionEvent[]): View {
  const next: View = { ...view, items: [...view.items] }
  let interrupted = false
  for (const e of events) {
    if (e.seq <= next.lastSeq) continue // 续传时可能重复 / may repeat on resume
    next.lastSeq = e.seq
    // 子 Agent 的一步放到派它的那一步下面；那一步不在（比如只拿到了后半段事件）就放在最外层。
    // A subagent's step goes under the step that launched it; when that step is absent (say only later events arrived) it goes at the top.
    const placed = (item: Item) => {
      const parent = typeof e.parent === 'string' ? e.parent : null
      const inside = parent ? updateTool(next.items, parent, (p) => ({ ...p, children: add(p.children, item) })) : null
      next.items = inside ?? add(next.items, item)
    }
    if (e.type === 'user') next.items.push({ kind: 'user', seq: e.seq, text: String(e.text ?? ''), images: Number(e.images ?? 0) })
    else if (e.type === 'text') placed({ kind: 'text', seq: e.seq, text: String(e.text ?? '') })
    else if (e.type === 'tool') {
      placed({ kind: 'tool', seq: e.seq, id: String(e.id ?? ''), name: String(e.name ?? ''), label: String(e.label ?? ''), input: (e.input as Record<string, unknown>) ?? {}, state: 'running', result: '', children: [], task: null })
    } else if (e.type === 'tool_result') {
      next.items = updateTool(next.items, String(e.id ?? ''), (x) => ({ ...x, state: e.error ? 'failed' : 'done', result: String(e.text ?? '') })) ?? next.items
    } else if (e.type === 'task') {
      const task: Task = { state: e.state as Task['state'], status: (e.status as string | null) ?? null, lastTool: (e.last_tool as string | null) ?? null, summary: String(e.summary ?? ''), toolUses: typeof e.tool_uses === 'number' ? e.tool_uses : null }
      next.items = updateTool(next.items, String(e.tool_use_id ?? ''), (x) => ({ ...x, task: { ...task, lastTool: task.lastTool ?? x.task?.lastTool ?? null, summary: task.summary || (x.task?.summary ?? '') } })) ?? next.items
    } else if (e.type === 'resumed') next.items.push({ kind: 'note', seq: e.seq, tone: 'muted', code: 'resumed', message: '' })
    else if (e.type === 'request') {
      next.items.push({ kind: 'request', seq: e.seq, request_id: String(e.request_id), what: e.kind as 'permission' | 'question' | 'plan', tool: String(e.tool ?? ''), input: (e.input as Record<string, unknown>) ?? {}, summary: String(e.summary ?? ''), decision: null, note: '', risky: typeof e.risky === 'string' ? e.risky : null, segments: Array.isArray(e.segments) ? (e.segments as Segment[]) : [] })
    } else if (e.type === 'resolved') {
      const i = lastIndex(next.items, (x) => x.kind === 'request' && x.request_id === e.request_id)
      const item = next.items[i]
      if (item?.kind === 'request') next.items[i] = { ...item, decision: String(e.decision ?? ''), note: String(e.note ?? '') }
    } else if (e.type === 'interrupted') {
      interrupted = true
      next.items.push({ kind: 'note', seq: e.seq, tone: 'muted', code: 'interrupted', message: '' })
    } else if (e.type === 'result') {
      if (e.tokens) next.tokens = e.tokens as TokenUsage
      // 它自己开的一轮什么都没说就结束了：那句"接着做"的提示收回。 / A turn it opened by itself ended without a word: take back the "carries on" note.
      const last = next.items[next.items.length - 1]
      if (last?.kind === 'note' && last.code === 'resumed') next.items = next.items.slice(0, -1)
      // 打断之后的那个"出错"的结果是打断本身，不算出错。 / The "error" result right after an interrupt is the interrupt itself, not a failure.
      if (e.is_error && !interrupted) next.items.push({ kind: 'note', seq: e.seq, tone: 'bad', code: 'failed', message: String(e.subtype ?? '') })
      interrupted = false
    } else if (e.type === 'usage') next.tokens = (e.tokens as TokenUsage | undefined) ?? next.tokens
    else if (e.type === 'error') next.items.push({ kind: 'note', seq: e.seq, tone: 'bad', code: 'error', message: String(e.message ?? '') })
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
