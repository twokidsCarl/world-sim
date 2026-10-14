import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionMeta } from '../src/api'
import { bubbles, merge, useWaiting, waitingOf } from '../src/sessions/waiting'

const meta = (id: string, status: SessionMeta['status'], updated_at = 1, waiting_for: string | null = null): SessionMeta => ({
  id, title: `会话 ${id}`, wish_id: null, mode: 'plan', model: '', effort: 'high', model_used: null, status, cost_usd: 0, turns: 1, waiting_for, created_at: 0, updated_at, live: true,
})

describe('waiting sessions', () => {
  beforeEach(() => useWaiting.setState({ waiting: [], onScreen: {} }))

  it('keeps only the waiting ones, the longest-waiting first', () => {
    const list = [meta('a', 'running', 1), meta('b', 'waiting', 5, '计划写好了'), meta('c', 'idle'), meta('d', 'waiting', 2)]
    expect(waitingOf(list).map((s) => s.id)).toEqual(['d', 'b'])
  })

  it('drops a session once answered and adds one that starts waiting', () => {
    const waiting = waitingOf([meta('a', 'waiting', 1), meta('b', 'waiting', 2)])
    expect(merge(waiting, meta('a', 'running', 3)).map((s) => s.id)).toEqual(['b'])
    expect(merge(waiting, meta('c', 'waiting', 0)).map((s) => s.id)).toEqual(['c', 'a', 'b'])
    expect(merge(waiting, meta('b', 'waiting', 2, '要跑命令'))[1]?.waiting_for).toBe('要跑命令')
  })

  it('shows no bubble for a session whose own view is open, and shows it again once the view closes', () => {
    const { take, enter } = useWaiting.getState()
    take([meta('a', 'waiting'), meta('b', 'waiting', 2)])
    const leave = enter('a')
    let s = useWaiting.getState()
    expect(bubbles(s.waiting, s.onScreen).map((w) => w.id)).toEqual(['b'])
    expect(s.waiting).toHaveLength(2) // 左侧栏的数仍然算上它 / the nav count still includes it
    leave()
    s = useWaiting.getState()
    expect(bubbles(s.waiting, s.onScreen).map((w) => w.id)).toEqual(['a', 'b'])
  })

  it('clears the bubble when the open view reports the answer', () => {
    const { take, update } = useWaiting.getState()
    take([meta('a', 'waiting')])
    update(meta('a', 'running', 2))
    expect(useWaiting.getState().waiting).toEqual([])
  })
})
