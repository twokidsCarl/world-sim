import { describe, expect, it } from 'vitest'
import { type SessionEvent, emptyView, fold, pending } from '../src/sessions/view'

const ev = (seq: number, type: string, more: Record<string, unknown> = {}): SessionEvent => ({ seq, type, ...more })

describe('session view', () => {
  it('folds messages, tool steps and results in order and ignores repeats', () => {
    const events = [
      ev(1, 'user', { text: '/wishes 3b30', images: 1 }), ev(2, 'status', { status: 'running' }), ev(3, 'text', { text: '我先读代码。' }), ev(4, 'text', { text: '再看测试。' }),
      ev(5, 'tool', { id: 't1', name: 'Read', label: '在读 a.py', input: { file_path: 'a.py' } }), ev(6, 'tool_result', { id: 't1', error: false, text: 'x = 1' }),
      ev(7, 'result', { is_error: false, cost_usd: 0.12 }), ev(8, 'status', { status: 'idle' }),
    ]
    const view = fold(fold(emptyView(), events.slice(0, 5)), events.slice(3)) // 续传时重复的不算两次 / repeats on resume are not counted twice
    expect(view.items.map((i) => i.kind)).toEqual(['user', 'text', 'tool'])
    expect(view.items[1]).toMatchObject({ text: '我先读代码。\n\n再看测试。' })
    expect(view.items[2]).toMatchObject({ state: 'done', result: 'x = 1', label: '在读 a.py' })
    expect([view.status, view.cost, view.lastSeq]).toEqual(['idle', 0.12, 8])
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
