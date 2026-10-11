import { describe, expect, it } from 'vitest'
import { parseTab, recent } from '../src/ui/tabs'

const TABS = ['projects', 'runs', 'attention', 'calls'] as const

describe('parseTab', () => {
  it('falls back to the first tab when empty', () => {
    expect(parseTab(null, TABS)).toBe('projects')
    expect(parseTab(undefined, TABS)).toBe('projects')
    expect(parseTab('', TABS)).toBe('projects')
  })
  it('falls back on garbage', () => {
    expect(parseTab('乱写', TABS)).toBe('projects')
    expect(parseTab('runs2', TABS)).toBe('projects')
  })
  it('accepts a valid value, ignoring case', () => {
    expect(parseTab('runs', TABS)).toBe('runs')
    expect(parseTab('Calls', TABS)).toBe('calls')
  })
})

describe('recent', () => {
  const rows = [{ id: 'a', last_at: '2026-10-01T00:00:00Z' }, { id: 'c', last_at: '2026-10-03T00:00:00Z' }, { id: 'b', last_at: '2026-10-02T00:00:00Z' }]
  it('takes the newest by last_at, whatever the incoming order', () => {
    expect(recent(rows, 2).map((r) => r.id)).toEqual(['c', 'b'])
    expect(rows.map((r) => r.id)).toEqual(['a', 'c', 'b']) // 不改原数组 / input untouched
  })
  it('does not fail when n exceeds the total', () => {
    expect(recent(rows, 99)).toHaveLength(3)
    expect(recent([], 5)).toEqual([])
  })
})
