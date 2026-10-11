import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api } from '../api'
import { label, pick, plural } from '../i18n'
import { useLang, useStore, useT } from '../state/store'
import type { State, ThreadId } from '../contract'
import { type Filters, NO_FILTERS, activeFilterCount, filterIdeas, filtersFromQuery, firstLine, queryFromFilters } from '../state/derive'
import { Empty, Page } from '../ui/Page'
import { StatusBadge, ThreadChips, ideaBody, ideaTitle, kernelName, levelName } from '../ui/bits'

const THREADS: ThreadId[] = ['A', 'B', 'C', 'D', 'E']

export function PoolPage({ state }: { state: State }) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const filters = filtersFromQuery(params)
  const set = (patch: Partial<Filters>) => navigate(`/ideas${queryFromFilters({ ...filters, ...patch })}`, { replace: true })
  const lang = useLang()
  const t = useT()
  const shown = filterIdeas(state, filters, lang)
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
    <Page title={t('想法池', 'Idea pool')} lead={t('每一条都是可以直接交给 Claude 开工的一段输入。', 'Each one is a piece of input you can hand straight to Claude to start on.')}>
      <div className="filters" role="search">
        <input
          type="search"
          placeholder={t('搜编号、标题、正文', 'Search number, title, body')}
          aria-label={t('搜索', 'Search')}
          value={filters.q}
          onChange={(e) => set({ q: e.target.value })}
        />
        <select aria-label={t('层', 'Level')} value={filters.level} onChange={(e) => set({ level: e.target.value as Filters['level'] })}>
          <option value="">{t('所有层', 'All levels')}</option>
          {state.frame.levels.map((l) => (
            <option key={l.id} value={l.id}>
              {levelName(state, l.id, lang)}
            </option>
          ))}
        </select>
        <span className="thread-toggles" role="group" aria-label={t('横线', 'Threads')}>
          {THREADS.map((id) => {
            const on = filters.threads.includes(id)
            const info = state.frame.threads.find((x) => x.id === id)
            return (
              <button
                key={id}
                aria-pressed={on}
                className={`chip thread thread-${id}${on ? ' on' : ''}`}
                title={pick(lang, info?.name, info?.name_en)}
                onClick={() => set({ threads: on ? filters.threads.filter((x) => x !== id) : [...filters.threads, id] })}
              >
                {id} {pick(lang, info?.short, info?.short_en)}
              </button>
            )
          })}
        </span>
        <select aria-label={t('内核', 'Kernel')} value={filters.kernel} onChange={(e) => set({ kernel: e.target.value })}>
          <option value="">{t('所有内核', 'All kernels')}</option>
          {state.frame.kernels.map((k) => (
            <option key={k.name} value={k.name}>
              {pick(lang, k.name, k.name_en)}
            </option>
          ))}
          <option value="—">{t('还没归类', 'Not classified yet')}</option>
        </select>
        <select aria-label={t('状态', 'Status')} value={filters.status} onChange={(e) => set({ status: e.target.value as Filters['status'] })}>
          <option value="live">{t('在池的', 'In the pool')}</option>
          <option value="all">{t('全部（含已并入、已丢弃）', 'All (including merged and discarded)')}</option>
          {Object.entries(state.labels.status ?? {}).map(([key, text]) => (
            <option key={key} value={key}>
              {label(lang, 'status', key, text)}
            </option>
          ))}
        </select>
        {active > 0 && <button onClick={() => navigate('/ideas', { replace: true })}>{t('清空筛选', 'Clear filters')}</button>}
      </div>
      {picked.length > 0 && (
        <div className="picked" role="status">
          <span>
            {t(`选了 ${picked.length} 条：${picked.join('、')}`, `${picked.length} selected: ${picked.join(', ')}`)}
          </span>
          <button className="primary" disabled={busy || picked.length < 2} onClick={() => void fuse()}>
            {busy ? t('正在写融合稿…', 'Writing the fused draft…') : t('让模型融合成一条', 'Have the model fuse them into one')}
          </button>
          <button onClick={() => setPicked([])}>{t('不选了', 'Clear selection')}</button>
          {picked.length < 2 && <span className="muted small">{t('融合至少要两条', 'Fusing needs at least two')}</span>}
          {error && <span className="err">{error}</span>}
        </div>
      )}
      <p className="muted small result-count">
        {t(`${shown.length} 条`, plural(shown.length, 'idea'))}
        {active > 0 && t(`（共 ${filterIdeas(state, NO_FILTERS).length} 条在池）`, ` (${filterIdeas(state, NO_FILTERS).length} in pool in all)`)}
        {filters.project && t(` · 提到 ${filters.project} 的`, ` · mentioning ${filters.project}`)}
      </p>
      {shown.length === 0 ? (
        <Empty>{t('没有符合条件的 idea。', 'No idea matches these filters.')}</Empty>
      ) : (
        <ul className="idea-list">
          {shown.map((idea) => (
            <li key={idea.id} className="idea-li">
              <input type="checkbox" aria-label={t(`选中 ${idea.id} ${idea.title}`, `Select ${idea.id} ${ideaTitle(lang, idea)}`)} checked={picked.includes(idea.id)} onChange={() => toggle(idea.id)} />
              <Link to={`/ideas/${encodeURIComponent(idea.id)}`} className="idea-row">
                <span className="id num">{idea.id}</span>
                <span className="what">
                  <span className="title">{ideaTitle(lang, idea)}</span>
                  <span className="first muted">{firstLine(ideaBody(lang, idea))}</span>
                </span>
                <span className="where">
                  <ThreadChips threads={idea.threads} state={state} />
                  <span className="muted small">{idea.kernel ? kernelName(state, idea.kernel, lang) : t('还没归类', 'Not classified yet')}</span>
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
