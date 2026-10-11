import { useEffect } from 'react'
import { NavLink, Route, Routes } from 'react-router'
import { IdeaPage } from '../pages/IdeaPage'
import { MapPage } from '../pages/MapPage'
import { PoolPage } from '../pages/PoolPage'
import { useStore } from '../state/store'

const NAV = [
  { to: '/', label: '地图', end: true },
  { to: '/ideas', label: '想法池', end: false },
]

export function App() {
  const { state, error, load, theme, toggleTheme } = useStore()
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
          </NavLink>
        ))}
        <div className="nav-foot">
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
        {state && state.unreadable > 0 && <div className="notice warn">事件日志里有 {state.unreadable} 行读不出来，已跳过。</div>}
        {!state && !error && <p className="muted pad">正在读取想法池…</p>}
        {state && (
          <Routes>
            <Route path="/" element={<MapPage state={state} />} />
            <Route path="/ideas" element={<PoolPage state={state} />} />
            <Route path="/ideas/:id" element={<IdeaPage state={state} />} />
            <Route path="*" element={<p className="pad">没有这个页面。</p>} />
          </Routes>
        )}
      </main>
    </div>
  )
}
