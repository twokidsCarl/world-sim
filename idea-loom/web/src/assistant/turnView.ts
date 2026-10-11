// 把一个回合的事件折成界面要画的块。实时流和历史回放走同一个函数。
// Fold the events of one turn into the blocks the UI draws. Live streaming and
// history replay go through the same function.
export type TurnEvent = { seq: number; type: string; [key: string]: unknown }

export type Step = { id: string; label: string; state: 'running' | 'done' | 'refused' }
export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'wish'; wish_id: string; title: string; kind_label: string; occurrences: number; fresh: boolean }
  | { kind: 'idea'; proposal_id: string; title: string; body: string; level: string }
  | { kind: 'point'; points: { ref: string; note: string }[] }

export type TurnView = {
  question: string
  page_title: string
  images: string[] // 附的图的地址：刚发的是本地的，回看的是服务器上的 / URLs of attached images: local for a fresh turn, on the server when looking back
  imageCount: number
  steps: Step[]
  blocks: Block[]
  status: 'running' | 'done' | 'stopped' | 'failed'
  seconds: number | null
  message: string | null
  lastSeq: number
}

export function emptyTurn(question = '', page_title = '', images: string[] = []): TurnView {
  return { question, page_title, images, imageCount: images.length, steps: [], blocks: [], status: 'running', seconds: null, message: null, lastSeq: 0 }
}

export function fold(view: TurnView, events: TurnEvent[]): TurnView {
  const next: TurnView = { ...view, steps: [...view.steps], blocks: [...view.blocks] }
  for (const e of events) {
    if (e.seq <= next.lastSeq) continue // 续传时可能重复 / may repeat on resume
    next.lastSeq = e.seq
    if (e.type === 'started') {
      next.question = String(e.question ?? next.question)
      next.page_title = String(e.page_title ?? next.page_title)
      next.imageCount = typeof e.images === 'number' ? e.images : next.imageCount
    } else if (e.type === 'text') {
      const last = next.blocks[next.blocks.length - 1]
      if (last?.kind === 'text') next.blocks[next.blocks.length - 1] = { kind: 'text', text: last.text + String(e.delta ?? '') }
      else next.blocks.push({ kind: 'text', text: String(e.delta ?? '') })
    } else if (e.type === 'step') {
      const step: Step = { id: String(e.id), label: String(e.label), state: e.state as Step['state'] }
      const i = next.steps.findIndex((s) => s.id === step.id)
      if (i >= 0) next.steps[i] = step
      else next.steps.push(step)
    } else if (e.type === 'wish') {
      next.blocks.push({ kind: 'wish', wish_id: String(e.wish_id), title: String(e.title), kind_label: String(e.kind_label), occurrences: Number(e.occurrences ?? 1), fresh: Boolean(e.new) })
    } else if (e.type === 'idea') {
      next.blocks.push({ kind: 'idea', proposal_id: String(e.proposal_id), title: String(e.title), body: String(e.body), level: String(e.level) })
    } else if (e.type === 'point') {
      next.blocks.push({ kind: 'point', points: (e.points as { ref: string; note: string }[]) ?? [] })
    } else if (e.type === 'done' || e.type === 'stopped' || e.type === 'failed') {
      next.status = e.type
      next.seconds = typeof e.seconds === 'number' ? e.seconds : null
      // 没给原因就留空，由界面按当前语言补一句。 / No reason given: left empty, and the UI supplies a line in the current language.
      next.message = e.type === 'failed' ? String(e.message ?? '') : null
      next.steps = next.steps.map((s) => (s.state === 'running' ? { ...s, state: 'done' } : s))
      if (e.type === 'done' && !next.blocks.some((b) => b.kind === 'text') && e.text) next.blocks.push({ kind: 'text', text: String(e.text) })
    }
  }
  return next
}

// 从 SSE 的文本里取出事件。buffer 里留着还没收完的半条。
// Pull events out of SSE text. Whatever is incomplete stays in the buffer.
export function parseSse(buffer: string): { events: TurnEvent[]; turn: number | null; rest: string } {
  const events: TurnEvent[] = []
  let turn: number | null = null
  const chunks = buffer.split('\n\n')
  const rest = chunks.pop() ?? ''
  for (const chunk of chunks) {
    const data = chunk.split('\n').find((l) => l.startsWith('data: '))
    if (!data) continue
    try {
      const obj = JSON.parse(data.slice(6)) as Record<string, unknown>
      if (typeof obj.seq === 'number') events.push(obj as TurnEvent)
      else if (typeof obj.turn === 'number') turn = obj.turn
    } catch {
      /* 坏的一条跳过 / skip a bad chunk */
    }
  }
  return { events, turn, rest }
}
