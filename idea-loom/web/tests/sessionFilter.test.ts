import { describe, expect, it } from 'vitest'
import { inShow, readShow, shownStatus, tally } from '../src/sessions/filter'

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
})
