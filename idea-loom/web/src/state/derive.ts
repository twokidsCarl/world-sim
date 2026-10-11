// 纯函数：从状态和筛选条件算出界面要显示的东西。
// Pure functions: derive what the UI shows from the state and the filters.
import type { Idea, LevelId, State, Status, ThreadId } from '../contract'

export const LIVE: Status[] = ['pool', 'building', 'built']

export type Filters = {
  q: string
  level: LevelId | ''
  threads: ThreadId[]
  kernel: string
  status: Status | 'live' | 'all'
  project: string
}

export const NO_FILTERS: Filters = { q: '', level: '', threads: [], kernel: '', status: 'live', project: '' }

const THREADS: ThreadId[] = ['A', 'B', 'C', 'D', 'E']

export function filtersFromQuery(params: URLSearchParams): Filters {
  const status = params.get('status')
  return {
    q: params.get('q') ?? '',
    level: (params.get('level') ?? '') as Filters['level'],
    threads: (params.get('threads') ?? '').split('').filter((t): t is ThreadId => THREADS.includes(t as ThreadId)),
    kernel: params.get('kernel') ?? '',
    status: (status ?? 'live') as Filters['status'],
    project: params.get('project') ?? '',
  }
}

export function queryFromFilters(f: Filters): string {
  const p = new URLSearchParams()
  if (f.q) p.set('q', f.q)
  if (f.level) p.set('level', f.level)
  if (f.threads.length) p.set('threads', [...f.threads].sort().join(''))
  if (f.kernel) p.set('kernel', f.kernel)
  if (f.status !== 'live') p.set('status', f.status)
  if (f.project) p.set('project', f.project)
  const s = p.toString()
  return s ? `?${s}` : ''
}

export function matches(idea: Idea, f: Filters): boolean {
  if (f.status === 'live' ? !LIVE.includes(idea.status) : f.status !== 'all' && idea.status !== f.status) return false
  if (f.level && idea.level !== f.level) return false
  if (f.kernel && (f.kernel === '—' ? idea.kernel != null : idea.kernel !== f.kernel)) return false
  if (f.project && !(idea.projects ?? []).includes(f.project)) return false
  if (f.threads.length && !f.threads.every((t) => (idea.threads ?? []).includes(t))) return false
  if (f.q) {
    const q = f.q.trim().toLowerCase()
    if (q && !`${idea.id} ${idea.title} ${idea.body}`.toLowerCase().includes(q)) return false
  }
  return true
}

export function filterIdeas(state: State, f: Filters): Idea[] {
  return state.ideas.filter((i) => matches(i, f))
}

export function activeFilterCount(f: Filters): number {
  return [f.q, f.level, f.kernel, f.project].filter(Boolean).length + (f.threads.length ? 1 : 0) + (f.status !== 'live' ? 1 : 0)
}

// 格子的深浅：0 到 4 档，按全表最大值分。
// Cell shade: five steps from 0 to 4, scaled to the largest cell.
export function shade(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4))) as 1 | 2 | 3 | 4
}

export function maxCell(state: State): number {
  let max = 0
  for (const row of Object.values(state.coverage.cells)) for (const ids of Object.values(row)) max = Math.max(max, ids.length)
  return max
}

export function ideaById(state: State): Map<string, Idea> {
  return new Map(state.ideas.map((i) => [i.id, i]))
}

export function firstLine(body: string): string {
  return body.split('\n')[0] ?? ''
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
