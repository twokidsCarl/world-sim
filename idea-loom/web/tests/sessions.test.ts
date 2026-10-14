import { describe, expect, it } from 'vitest'
import { type SessionEvent, emptyView, fold, pending } from '../src/sessions/view'

const ev = (seq: number, type: string, more: Record<string, unknown> = {}): SessionEvent => ({ seq, type, ...more })

describe('session view', () => {
  it('folds messages, tool steps and results in order and ignores repeats', () => {
    const events = [
      ev(1, 'user', { text: '/wishes 3b30', images: 1 }), ev(2, 'status', { status: 'running' }), ev(3, 'text', { text: '我先读代码。' }), ev(4, 'text', { text: '再看测试。' }),
      ev(5, 'tool', { id: 't1', name: 'Read', label: '在读 a.py', input: { file_path: 'a.py' } }), ev(6, 'tool_result', { id: 't1', error: false, text: 'x = 1' }),
      ev(7, 'result', { is_error: false, cost_usd: 0.12, tokens: { input_tokens: 10, output_tokens: 40 } }), ev(8, 'status', { status: 'idle' }),
    ]
    const view = fold(fold(emptyView(), events.slice(0, 5)), events.slice(3)) // 续传时重复的不算两次 / repeats on resume are not counted twice
    expect(view.items.map((i) => i.kind)).toEqual(['user', 'text', 'tool'])
    expect(view.items[1]).toMatchObject({ text: '我先读代码。\n\n再看测试。' })
    expect(view.items[2]).toMatchObject({ state: 'done', result: 'x = 1', label: '在读 a.py' })
    expect([view.status, view.tokens, view.lastSeq]).toEqual(['idle', { input_tokens: 10, output_tokens: 40 }, 8])
  })

  it('follows the running token estimate and settles on the figure in the result', () => {
    const working = fold(emptyView(), [ev(1, 'usage', { tokens: { output_tokens: 5 }, estimate: true }), ev(2, 'usage', { tokens: { output_tokens: 9 }, estimate: true })])
    expect(working.tokens).toEqual({ output_tokens: 9 })
    expect(fold(working, [ev(3, 'result', { is_error: false, tokens: { output_tokens: 12 } })]).tokens).toEqual({ output_tokens: 12 })
    // 旧的结果事件没有 token：留着手上的。 / An old result event has no tokens: keep what is there.
    expect(fold(working, [ev(3, 'result', { is_error: false, cost_usd: 0.1 })]).tokens).toEqual({ output_tokens: 9 })
  })

  it('shows the card that awaits an answer and clears it once answered', () => {
    const asked = fold(emptyView(), [ev(1, 'request', { request_id: 'r1', kind: 'plan', tool: 'ExitPlanMode', input: { plan: '# 计划' }, summary: '计划写好了' }), ev(2, 'status', { status: 'waiting', waiting_for: '计划写好了' })])
    expect(pending(asked)).toMatchObject([{ request_id: 'r1', what: 'plan' }])
    expect(asked.waitingFor).toBe('计划写好了')
    const answered = fold(asked, [ev(3, 'resolved', { request_id: 'r1', decision: 'reject', note: '不要动测试' }), ev(4, 'status', { status: 'running' })])
    expect(pending(answered)).toEqual([])
    expect(answered.items[0]).toMatchObject({ decision: 'reject', note: '不要动测试' })
  })

  it('treats the error result after an interrupt as the interrupt, and a real one as a failure', () => {
    const stopped = fold(emptyView(), [ev(1, 'interrupted'), ev(2, 'result', { is_error: true, subtype: 'error_during_execution' })])
    expect(stopped.items.map((i) => (i.kind === 'note' ? i.code : i.kind))).toEqual(['interrupted'])
    const failed = fold(emptyView(), [ev(1, 'result', { is_error: true, subtype: 'error_max_turns' }), ev(2, 'error', { message: '会话出错了' })])
    expect(failed.items.map((i) => (i.kind === 'note' ? i.code : i.kind))).toEqual(['failed', 'error'])
  })

  it('keeps every unanswered card answerable when several requests arrive at once', () => {
    const ask = (seq: number, id: string) => ev(seq, 'request', { request_id: id, kind: 'permission', tool: 'Read', input: { file_path: `/tmp/${id}.png` }, summary: id })
    const both = fold(emptyView(), [ask(1, 'narrow'), ask(2, 'wide'), ev(3, 'status', { status: 'waiting' })])
    expect(pending(both).map((p) => p.request_id)).toEqual(['narrow', 'wide'])
    // 回答了后一张，前一张仍然在等——即使状态一时显示"在跑"。 / After the later one is answered the earlier still waits, even if the status briefly says running.
    const one = fold(both, [ev(4, 'resolved', { request_id: 'wide', decision: 'allow_always' }), ev(5, 'status', { status: 'running' })])
    expect(pending(one).map((p) => p.request_id)).toEqual(['narrow'])
  })

  it('carries the parts of a command and why it must always be asked about', () => {
    const view = fold(emptyView(), [
      ev(1, 'request', { request_id: 'r1', kind: 'permission', tool: 'Bash', input: { command: 'tools/ci.sh x | wc -l' }, summary: '在跑', risky: null, segments: [{ text: 'tools/ci.sh x', kind: 'tools/ci.sh', known: true }, { text: 'wc -l', kind: 'wc', known: false }] }),
      ev(2, 'request', { request_id: 'r2', kind: 'permission', tool: 'Bash', input: { command: 'rm -rf build' }, summary: '在跑', risky: '`rm` 每次都要你确认', segments: [{ text: 'rm -rf build', kind: 'rm', known: false }] }),
    ])
    const [first, second] = pending(view)
    expect(first!.segments.map((s) => [s.kind, s.known])).toEqual([['tools/ci.sh', true], ['wc', false]])
    expect([first!.risky, second!.risky]).toEqual([null, '`rm` 每次都要你确认'])
  })
})

describe('subagents', () => {
  it('puts each subagent step under the step that launched it and follows the task to its end', () => {
    const launch = [
      ev(1, 'tool', { id: 'ag1', name: 'Agent', label: '派了一个子 Agent：查代码', input: { description: '查代码' } }),
      ev(2, 'task', { task_id: 't1', tool_use_id: 'ag1', state: 'started', status: null, summary: '' }),
      ev(3, 'tool_result', { id: 'ag1', error: false, text: 'Async agent launched' }),
      ev(4, 'tool', { id: 'b1', name: 'Bash', label: '在跑 ls', input: { command: 'ls' }, parent: 'ag1' }),
      ev(5, 'task', { task_id: 't1', tool_use_id: 'ag1', state: 'progress', last_tool: 'Bash', summary: '' }),
      ev(6, 'text', { text: '派出去了' }),
    ]
    const running = fold(emptyView(), launch)
    expect(running.items.map((i) => i.kind)).toEqual(['tool', 'text'])                       // 子 Agent 的一步不在最外层 / the subagent's step is not at the top
    const agent = running.items[0] as Extract<(typeof running.items)[number], { kind: 'tool' }>
    expect(agent.children.map((c) => (c.kind === 'tool' ? c.id : c.kind))).toEqual(['b1'])
    expect(agent.task).toMatchObject({ state: 'progress', lastTool: 'Bash' })
    const done = fold(running, [
      ev(7, 'tool_result', { id: 'b1', error: false, text: 'a b', parent: 'ag1' }),
      ev(8, 'text', { text: '看完了', parent: 'ag1' }), ev(9, 'text', { text: '两个文件', parent: 'ag1' }),
      ev(10, 'task', { task_id: 't1', tool_use_id: 'ag1', state: 'done', status: 'completed', summary: '看完了：两个文件' }),
      ev(10.5, 'task', { task_id: 't1', tool_use_id: 'ag1', state: 'done', status: 'completed', summary: '' }),   // 结束报两次，结论不丢 / an end reported twice keeps its conclusion
      ev(11, 'resumed'), ev(12, 'text', { text: '子 Agent 回来了' }), ev(13, 'result', { is_error: false }),
      ev(14, 'resumed'), ev(15, 'result', { is_error: false }),   // 什么都没说的一轮不留提示 / a turn that said nothing leaves no note
    ])
    const finished = done.items[0] as Extract<(typeof done.items)[number], { kind: 'tool' }>
    expect(finished.children).toMatchObject([{ kind: 'tool', id: 'b1', state: 'done', result: 'a b' }, { kind: 'text', text: '看完了\n\n两个文件' }])
    expect(finished.task).toMatchObject({ state: 'done', status: 'completed', summary: '看完了：两个文件', lastTool: 'Bash' })   // 做完时仍记得最近用过的工具 / the last tool is kept at the end
    expect(done.items.map((i) => (i.kind === 'note' ? i.code : i.kind))).toEqual(['tool', 'text', 'resumed', 'text'])
  })

  it('keeps a step whose parent is unknown at the top instead of dropping it', () => {
    const view = fold(emptyView(), [ev(1, 'tool', { id: 'x', name: 'Read', label: '在读 a', input: {}, parent: 'gone' })])
    expect(view.items).toMatchObject([{ kind: 'tool', id: 'x' }])
  })
})
