import { describe, expect, it } from 'vitest'
import { doneAt, inShow, readShow, shownStatus, tally } from '../src/sessions/filter'

const s = (status: 'idle' | 'running' | 'waiting' | 'closed' | 'error', live = true) => ({ status, live })

describe('session filter', () => {
  it('counts closed sessions as finished and everything else as unfinished', () => {
    const list = [s('running'), s('waiting'), s('idle'), s('idle', false), s('error', false), s('closed', false), s('closed', false)]
    const { shows, statuses } = tally(list)
    expect(shows).toEqual({ open: 5, closed: 2, all: 7 })
    expect(statuses).toEqual({ running: 1, waiting: 1, idle: 2, error: 1, closed: 2 })
  })

  it('shows a session whose process is gone as idle, whatever its last status said', () => {
    expect(shownStatus(s('running', false))).toBe('idle')
    expect(shownStatus(s('waiting', false))).toBe('idle')
    expect(shownStatus(s('error', false))).toBe('error')
    expect(shownStatus(s('running'))).toBe('running')
  })

  it('filters by group', () => {
    expect([inShow('open', 'idle'), inShow('open', 'closed'), inShow('closed', 'closed'), inShow('closed', 'error'), inShow('all', 'closed')]).toEqual([true, false, true, false, true])
  })

  it('reads a remembered choice and falls back to unfinished', () => {
    expect([readShow('all'), readShow('closed'), readShow(null), readShow('nonsense')]).toEqual(['all', 'closed', 'open', 'open'])
  })

  it('tells done apart from plain idle, and only while it is idle', () => {
    expect(shownStatus({ status: 'idle', live: true, done_at: 100 })).toBe('done')
    expect(shownStatus({ status: 'idle', live: false, done_at: 100 })).toBe('done')       // 歇下了也还是做完了 / still done after resting
    expect(shownStatus({ status: 'idle', live: true, done_at: null })).toBe('idle')       // 后台还有任务，或者停下来等你说话 / background work remains, or it stopped for you to speak
    expect(shownStatus({ status: 'running', live: true, done_at: 100 })).toBe('running')
    expect(shownStatus({ status: 'closed', live: false, done_at: 100 })).toBe('closed')
    const { shows, statuses } = tally([{ status: 'idle', live: true, done_at: 1 }, s('idle'), s('closed', false)])
    expect([shows.open, statuses.done, statuses.idle]).toEqual([2, 1, 1])                  // 做完了的仍算没结束 / done still counts as unfinished
  })

  it('writes the time it finished, with the date when not today', () => {
    const now = new Date(2026, 9, 14, 17, 0)
    expect(doneAt(new Date(2026, 9, 14, 16, 37).getTime() / 1000, now)).toBe('16:37')
    expect(doneAt(new Date(2026, 9, 13, 9, 5).getTime() / 1000, now)).toBe('10/13 09:05')
  })
})
