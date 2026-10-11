import { useEffect } from 'react'
import { NavLink, Route, Routes } from 'react-router'
import { IdeaPage } from '../pages/IdeaPage'
import { InboxPage } from '../pages/InboxPage'
import { LineagePage } from '../pages/LineagePage'
import { NewIdeaPage } from '../pages/NewIdeaPage'
import { MapPage } from '../pages/MapPage'
import { PoolPage } from '../pages/PoolPage'
import { WishPage, WishesPage } from '../pages/WishesPage'
import { AssistantDock } from '../assistant/AssistantDock'
import { useAssistant } from '../assistant/store'
import { useStore } from '../state/store'

const NAV = [
  { to: '/', label: '地图', end: true },
  { to: '/ideas', label: '想法池', end: false },
  { to: '/inbox', label: '生成与候选', end: false },
  { to: '/lineage', label: '血缘', end: false },
  { to: '/wishes', label: '许愿池', end: false },
]

export function App() {
  const { state, error, load, theme, toggleTheme, sync, syncing, syncResult, runSync, clearSyncResult, proposals } = useStore()
  const openWishes = useAssistant((a) => a.openWishes)
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <div className="shell">
      <nav className="nav" aria-label="主导航">
        <div className="mark">
          idea-loom<small>想法池</small>
        </div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className="nav-item">
            {n.label}
            {n.to === '/ideas' && state && <span className="count num">{state.counts.live}</span>}
            {n.to === '/wishes' && openWishes > 0 && <span className="count pill num">{openWishes}</span>}
            {n.to === '/inbox' && proposals && proposals.open > 0 && <span className="count pill num">{proposals.open}</span>}
          </NavLink>
        ))}
        <NavLink to="/new" className="nav-item nav-new">
          ＋ 手写一条
        </NavLink>
        <div className="nav-foot">
          {sync && (
            <div className="sync">
              {sync.can_sync ? (
                <>
                  <div className="small">
                    {sync.pending > 0 ? `${sync.pending} 处改动还没进仓库` : 'IDEAS.md 需要更新'}
                  </div>
                  <button className="primary" disabled={syncing} onClick={() => void runSync()}>
                    {syncing ? '正在同步…' : '同步到仓库'}
                  </button>
                </>
              ) : (
                <div className="muted small">{sync.reason ?? '已和仓库同步'}</div>
              )}
            </div>
          )}
          <button onClick={toggleTheme} aria-label="切换昼夜配色">
            {theme === 'dark' ? '昼' : '夜'}
          </button>
        </div>
      </nav>
      <main className="main">
        {error && (
          <div className="notice bad" role="alert">
            {error} <button onClick={() => void load()}>重试</button>
          </div>
        )}
        {syncResult && (
          <div className={`notice ${syncResult.ok ? 'good' : 'bad'}`} role="status">
            {syncResult.message}
            {syncResult.pr_url && (
              <>
                {' '}
                <a href={syncResult.pr_url} target="_blank" rel="noreferrer">
                  看这个合并请求
                </a>
              </>
            )}{' '}
            <button onClick={clearSyncResult}>知道了</button>
          </div>
        )}
        {state && state.unreadable > 0 && <div className="notice warn">事件日志里有 {state.unreadable} 行读不出来，已跳过。</div>}
        {!state && !error && <p className="muted pad">正在读取想法池…</p>}
        {state && (
          <Routes>
            <Route path="/" element={<MapPage state={state} />} />
            <Route path="/ideas" element={<PoolPage state={state} />} />
            <Route path="/ideas/:id" element={<IdeaPage state={state} />} />
            <Route path="/inbox" element={<InboxPage state={state} />} />
            <Route path="/lineage" element={<LineagePage state={state} />} />
            <Route path="/wishes" element={<WishesPage />} />
            <Route path="/wishes/:id" element={<WishPage />} />
            <Route path="/new" element={<NewIdeaPage state={state} />} />
            <Route path="*" element={<p className="pad">没有这个页面。</p>} />
          </Routes>
        )}
      </main>
      <AssistantDock />
    </div>
  )
}
