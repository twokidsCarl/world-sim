import { describe, expect, it } from 'vitest'
import type { Idea, State } from '../src/contract'
import { NO_FILTERS, activeFilterCount, filterIdeas, filtersFromQuery, formatTime, matches, maxCell, queryFromFilters, shade } from '../src/state/derive'

const idea = (over: Partial<Idea>): Idea =>
  ({
    id: '1.1', title: '往上走一层', body: '接着 strata：现在只有粒子。', level: 'L1', threads: ['E'], kernel: '粒子',
    status: 'pool', status_label: '在池', created_at: '', updated_at: '', projects: ['strata'], mentions: [], edges: [],
    ...over,
  }) as Idea

const ideas = [
  idea({}),
  idea({ id: '1.2', title: '沙堆', body: '一粒一粒往下落。', threads: ['B'], kernel: '阈值与级联', projects: [] }),
  idea({ id: '6.1', title: '谈判桌', body: '两个人谈判。', level: 'L6', threads: ['C'], kernel: null, projects: [] }),
  idea({ id: '1.7', title: '行星', body: '碎石。', status: 'merged', status_label: '已并入', projects: [] }),
]
const state = { ideas, coverage: { cells: { L1: { A: [], B: ['1.2'], E: ['1.1', '1.6', '1.4'] } } } } as unknown as State

describe('filters', () => {
  it('shows only live ideas by default', () => {
    expect(filterIdeas(state, NO_FILTERS).map((i) => i.id)).toEqual(['1.1', '1.2', '6.1'])
  })
  it('filters by level, thread, kernel, project and text', () => {
    expect(filterIdeas(state, { ...NO_FILTERS, level: 'L1' }).length).toBe(2)
    expect(filterIdeas(state, { ...NO_FILTERS, threads: ['B'] }).map((i) => i.id)).toEqual(['1.2'])
    expect(filterIdeas(state, { ...NO_FILTERS, kernel: '粒子' }).map((i) => i.id)).toEqual(['1.1'])
    expect(filterIdeas(state, { ...NO_FILTERS, kernel: '—' }).map((i) => i.id)).toEqual(['6.1'])
    expect(filterIdeas(state, { ...NO_FILTERS, project: 'strata' }).map((i) => i.id)).toEqual(['1.1'])
    expect(filterIdeas(state, { ...NO_FILTERS, q: '谈判' }).map((i) => i.id)).toEqual(['6.1'])
    expect(filterIdeas(state, { ...NO_FILTERS, q: '1.2' }).map((i) => i.id)).toEqual(['1.2'])
  })
  it('can show merged ideas or everything', () => {
    expect(filterIdeas(state, { ...NO_FILTERS, status: 'merged' }).map((i) => i.id)).toEqual(['1.7'])
    expect(filterIdeas(state, { ...NO_FILTERS, status: 'all' }).length).toBe(4)
    expect(matches(ideas[3]!, NO_FILTERS)).toBe(false)
  })
  it('round-trips through the query string', () => {
    const f = { ...NO_FILTERS, q: '火', level: 'L8' as const, threads: ['B' as const, 'A' as const], kernel: '粒子', status: 'all' as const }
    const back = filtersFromQuery(new URLSearchParams(queryFromFilters(f)))
    expect(back).toEqual({ ...f, threads: ['A', 'B'] })
    expect(queryFromFilters(NO_FILTERS)).toBe('')
    expect(activeFilterCount(f)).toBe(5)
    expect(activeFilterCount(NO_FILTERS)).toBe(0)
  })
})

describe('map shading', () => {
  it('scales to the largest cell', () => {
    expect(maxCell(state)).toBe(3)
    expect([0, 1, 2, 3].map((n) => shade(n, 3))).toEqual([0, 2, 3, 4])
    expect(shade(1, 8)).toBe(1)
    expect(shade(5, 0)).toBe(0)
  })
})

describe('formatTime', () => {
  it('formats in local time and passes garbage through', () => {
    expect(formatTime('2026-10-11T02:18:00')).toBe('2026-10-11 02:18')
    expect(formatTime('不是时间')).toBe('不是时间')
  })
})
