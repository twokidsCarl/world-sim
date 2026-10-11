import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api } from '../api'
import { useStore } from '../state/store'
import type { State, ThreadId } from '../contract'
import { type Filters, NO_FILTERS, activeFilterCount, filterIdeas, filtersFromQuery, firstLine, queryFromFilters } from '../state/derive'
import { Empty, Page } from '../ui/Page'
import { StatusBadge, ThreadChips, levelName } from '../ui/bits'

const THREADS: ThreadId[] = ['A', 'B', 'C', 'D', 'E']

export function PoolPage({ state }: { state: State }) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const filters = filtersFromQuery(params)
  const set = (patch: Partial<Filters>) => navigate(`/ideas${queryFromFilters({ ...filters, ...patch })}`, { replace: true })
  const shown = filterIdeas(state, filters)
  const active = activeFilterCount(filters)
  const load = useStore((st) => st.load)
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id])
  const fuse = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.fuse(picked)
      await load()
      navigate('/inbox')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Page title="想法池" lead="每一条都是可以直接交给 Claude 开工的一段输入。">
      <div className="filters" role="search">
        <input
          type="search"
          placeholder="搜编号、标题、正文"
          aria-label="搜索"
          value={filters.q}
          onChange={(e) => set({ q: e.target.value })}
        />
        <select aria-label="层" value={filters.level} onChange={(e) => set({ level: e.target.value as Filters['level'] })}>
          <option value="">所有层</option>
          {state.frame.levels.map((l) => (
            <option key={l.id} value={l.id}>
              {levelName(state, l.id)}
            </option>
          ))}
        </select>
        <span className="thread-toggles" role="group" aria-label="横线">
          {THREADS.map((t) => {
            const on = filters.threads.includes(t)
            const info = state.frame.threads.find((x) => x.id === t)
            return (
              <button
                key={t}
                aria-pressed={on}
                className={`chip thread thread-${t}${on ? ' on' : ''}`}
                title={info?.name}
                onClick={() => set({ threads: on ? filters.threads.filter((x) => x !== t) : [...filters.threads, t] })}
              >
                {t} {info?.short}
              </button>
            )
          })}
        </span>
        <select aria-label="内核" value={filters.kernel} onChange={(e) => set({ kernel: e.target.value })}>
          <option value="">所有内核</option>
          {state.frame.kernels.map((k) => (
            <option key={k.name} value={k.name}>
              {k.name}
            </option>
          ))}
          <option value="—">还没归类</option>
        </select>
        <select aria-label="状态" value={filters.status} onChange={(e) => set({ status: e.target.value as Filters['status'] })}>
          <option value="live">在池的</option>
          <option value="all">全部（含已并入、已丢弃）</option>
          {Object.entries(state.labels.status ?? {}).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        {active > 0 && <button onClick={() => navigate('/ideas', { replace: true })}>清空筛选</button>}
      </div>
      {picked.length > 0 && (
        <div className="picked" role="status">
          <span>
            选了 {picked.length} 条：{picked.join('、')}
          </span>
          <button className="primary" disabled={busy || picked.length < 2} onClick={() => void fuse()}>
            {busy ? '正在写融合稿…' : '让模型融合成一条'}
          </button>
          <button onClick={() => setPicked([])}>不选了</button>
          {picked.length < 2 && <span className="muted small">融合至少要两条</span>}
          {error && <span className="err">{error}</span>}
        </div>
      )}
      <p className="muted small result-count">
        {shown.length} 条{active > 0 && `（共 ${filterIdeas(state, NO_FILTERS).length} 条在池）`}
        {filters.project && ` · 提到 ${filters.project} 的`}
      </p>
      {shown.length === 0 ? (
        <Empty>没有符合条件的 idea。</Empty>
      ) : (
        <ul className="idea-list">
          {shown.map((idea) => (
            <li key={idea.id} className="idea-li">
              <input type="checkbox" aria-label={`选中 ${idea.id} ${idea.title}`} checked={picked.includes(idea.id)} onChange={() => toggle(idea.id)} />
              <Link to={`/ideas/${encodeURIComponent(idea.id)}`} className="idea-row">
                <span className="id num">{idea.id}</span>
                <span className="what">
                  <span className="title">{idea.title}</span>
                  <span className="first muted">{firstLine(idea.body)}</span>
                </span>
                <span className="where">
                  <ThreadChips threads={idea.threads} state={state} />
                  <span className="muted small">{idea.kernel ?? '还没归类'}</span>
                </span>
                <StatusBadge idea={idea} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  )
}
