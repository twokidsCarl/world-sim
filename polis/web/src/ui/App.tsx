import { useEffect, useRef } from 'react'
import { Stage } from '../stage/stage.ts'
import { useApp } from '../state/store.ts'
import { Side } from './Side.tsx'
import { Timeline } from './Timeline.tsx'

export function App() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const phase = useApp((s) => s.phase)
  const error = useApp((s) => s.error)
  const runs = useApp((s) => s.runs)
  const run = useApp((s) => s.run)
  const theme = useApp((s) => s.theme)

  useEffect(() => {
    void useApp.getState().boot()
    const stage = new Stage(canvas.current!)
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement) return
      const s = useApp.getState()
      if (e.key === ' ') s.toggle()
      else if (e.key === 'ArrowRight') s.seek(Math.floor(s.t) + 1)
      else if (e.key === 'ArrowLeft') s.seek(Math.ceil(s.t) - 1)
      else if (e.key === 'Escape') s.select(null)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      stage.destroy()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  return (
    <div className="app">
      <header className="header">
        <span className="mark">
          polis<small>城邦</small>
        </span>
        {run && <span className="title">{run.manifest.title}</span>}
        <span className="spacer" />
        {runs.length > 0 && (
          <select
            aria-label="运行记录"
            value={run?.manifest.run_id ?? ''}
            onChange={(e) => void useApp.getState().open(e.target.value)}
          >
            {runs.map((m) => (
              <option key={m.run_id} value={m.run_id}>
                {m.run_id}
              </option>
            ))}
          </select>
        )}
        <button onClick={() => useApp.getState().setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '昼' : '夜'}
        </button>
      </header>

      <main className="stage">
        <canvas ref={canvas} />
        {phase !== 'ready' && <div className="status">{phase === 'loading' ? '正在读取记录…' : error}</div>}
        {phase === 'ready' && <Legend />}
        {phase === 'ready' && <div className="hint">滚轮缩放 · 拖动平移 · 双击复位 · 空格播放</div>}
      </main>

      <Side />
      <Timeline />
    </div>
  )
}

function Legend() {
  return (
    <div className="legend">
      <div className="ramp" />
      <div className="ends">
        <span>不信</span>
        <span>深信钱庄要倒</span>
      </div>
      <div className="item">
        <span className="glyph">
          <i style={{ width: 4, height: 4, background: 'var(--ink-2)', opacity: 0.5 }} />
        </span>
        还没听说
      </div>
      <div className="item">
        <span className="glyph">
          <i style={{ width: 9, height: 9, border: '1.5px solid var(--s-withdrew)' }} />
        </span>
        已取出存款
      </div>
      <div className="item">
        <span className="glyph">
          <i style={{ width: 8, height: 8, background: 'var(--ink)' }} />
        </span>
        钱没取出来
      </div>
      <div className="item">
        <span className="key" style={{ borderColor: 'var(--rumor)' }} />
        谣言
        <span className="key" style={{ borderColor: 'var(--rebut)', marginLeft: 6 }} />
        辟谣
      </div>
      <div className="item">钱庄外圈：库里剩下的现银</div>
    </div>
  )
}
