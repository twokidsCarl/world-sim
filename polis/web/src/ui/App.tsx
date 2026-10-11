import { useCallback, useEffect, useRef, useState } from 'react'
import { Stage } from '../stage/stage.ts'
import { loc, tr } from '../state/lang.ts'
import { EMBED, OPEN_LIBRARY, useApp } from '../state/store.ts'
import { Library } from './Library.tsx'
import { Side } from './Side.tsx'
import { Timeline } from './Timeline.tsx'

export function App() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const phase = useApp((s) => s.phase)
  const error = useApp((s) => s.error)
  const runs = useApp((s) => s.runs)
  const run = useApp((s) => s.run)
  const theme = useApp((s) => s.theme)
  // 读一下语言，切换时整棵树重画 / subscribing to the language makes the whole tree re-render when it changes
  const lang = useApp((s) => s.lang)
  const [library, setLibrary] = useState(OPEN_LIBRARY)
  // 嵌入时平常不显示右侧面板；进了实验台或点了某个人才显示 / when embedded the side panel appears only in the lab or once a person is picked
  const side = useApp((s) => s.tab === 'lab' || s.selected != null)
  const closeLibrary = useCallback(() => setLibrary(false), [])

  useEffect(() => {
    void useApp.getState().boot()
    const stage = new Stage(canvas.current!)
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement) return
      if (document.querySelector('.library')) return
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
    <div className={EMBED ? (side ? 'app embed with-side' : 'app embed') : 'app'}>
      <header className="header">
        <span className="mark">
          polis<small>{tr('城邦', 'the city')}</small>
        </span>
        {run && <span className="title">{loc(run.manifest.title, run.manifest.title_en)}</span>}
        <span className="spacer" />
        {runs.length > 0 && (
          <select
            aria-label={tr('运行记录', 'Run')}
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
        <button onClick={() => setLibrary(true)}>{tr('依据', 'Evidence')}</button>
        <button aria-label={tr('切换语言', 'Switch language')} onClick={() => useApp.getState().setLang(lang === 'en' ? 'zh' : 'en')}>
          {lang === 'en' ? '中文' : 'EN'}
        </button>
        <button aria-label={tr('切换明暗', 'Toggle light and dark')} onClick={() => useApp.getState().setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? tr('昼', 'Light') : tr('夜', 'Dark')}
        </button>
      </header>

      <main className="stage">
        <canvas ref={canvas} />
        {phase !== 'ready' && <div className="status">{phase === 'loading' ? tr('正在读取记录…', 'Loading the run…') : error}</div>}
        {phase === 'ready' && <Legend />}
        {phase === 'ready' && <div className="hint">{tr('滚轮缩放 · 拖动平移 · 双击复位 · 空格播放', 'Scroll to zoom · drag to pan · double-click to reset · space to play')}</div>}
      </main>

      <Side />
      <Timeline />
      {library && <Library onClose={closeLibrary} />}
    </div>
  )
}

function Legend() {
  return (
    <div className="legend">
      <div className="ramp" />
      <div className="ends">
        <span>{tr('不信', 'Doubts')}</span>
        <span>{tr('深信钱庄要倒', 'Sure it will fail')}</span>
      </div>
      <div className="item">
        <span className="glyph">
          <i style={{ width: 4, height: 4, background: 'var(--ink-2)', opacity: 0.5 }} />
        </span>
        {tr('还没听说', 'Has not heard')}
      </div>
      <div className="item">
        <span className="glyph">
          <i style={{ width: 9, height: 9, border: '1.5px solid var(--s-withdrew)' }} />
        </span>
        {tr('已取出存款', 'Has withdrawn')}
      </div>
      <div className="item">
        <span className="glyph">
          <i style={{ width: 8, height: 8, background: 'var(--ink)' }} />
        </span>
        {tr('钱没取出来', 'Lost their money')}
      </div>
      <div className="item">
        <span className="key" style={{ borderColor: 'var(--rumor)' }} />
        {tr('谣言', 'Rumour')}
        <span className="key" style={{ borderColor: 'var(--rebut)', marginLeft: 6 }} />
        {tr('辟谣', 'Rebuttal')}
      </div>
      <div className="item">{tr('钱庄外圈：库里剩下的现银', 'Ring around the bank: cash left in the vault')}</div>
    </div>
  )
}
