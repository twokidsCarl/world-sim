import { useEffect } from 'react'
import { AnatomyGraph } from './anatomy/graph.ts'
import { loadDataset, requestedDataset } from './anatomy/load.ts'
import { debug } from './debug.ts'
import { useApp } from './state/store.ts'
import { AboutDialog } from './ui/AboutDialog.tsx'
import { DisplayPanel } from './ui/DisplayPanel.tsx'
import { Icon } from './ui/Icon.tsx'
import { InfoPanel } from './ui/InfoPanel.tsx'
import { TopBar } from './ui/TopBar.tsx'
import { TreePanel } from './ui/TreePanel.tsx'
import { ViewerPane } from './ui/ViewerPane.tsx'

export function App() {
  const graph = useApp((s) => s.graph)
  const phase = useApp((s) => s.load.phase)
  const message = useApp((s) => s.load.message)
  const leftTab = useApp((s) => s.leftTab)
  const leftOpen = useApp((s) => s.leftOpen)
  const rightOpen = useApp((s) => s.rightOpen)
  const setLeftTab = useApp((s) => s.setLeftTab)
  const setLeftOpen = useApp((s) => s.setLeftOpen)
  const setRightOpen = useApp((s) => s.setRightOpen)

  useEffect(() => {
    let cancelled = false
    const app = useApp.getState()
    app.setLoad({ phase: 'loading', progress: 0.02, message: '读取解剖数据…' })
    loadDataset(requestedDataset(location.search))
      .then((ds) => {
        if (cancelled) return
        const g = new AnatomyGraph(ds.data, ds.names, ds.relations)
        debug.graph = g
        for (const n of ds.notices) app.addNotice(n)
        app.init(g, ds.dataset)
        app.setLoad({ progress: 0.1, message: '加载模型…' })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.error('[soma] dataset load failed', err)
        app.setLoad({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      const app = useApp.getState()
      if (e.key === 'Escape') {
        if (app.aboutOpen) app.setAboutOpen(false)
        else app.clearSelection()
      } else if (e.key === 'f' || e.key === 'F') app.requestFocus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <TopBar />
      <div className="workspace">
        <aside className={`panel panel-left${leftOpen ? ' open' : ''}`} aria-label="显示与结构树">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={leftTab === 'display'} className={leftTab === 'display' ? 'active' : ''} onClick={() => setLeftTab('display')}>
              显示 <span className="en">Display</span>
            </button>
            <button role="tab" aria-selected={leftTab === 'tree'} className={leftTab === 'tree' ? 'active' : ''} onClick={() => setLeftTab('tree')}>
              结构树 <span className="en">Tree</span>
            </button>
            <button className="drawer-close" onClick={() => setLeftOpen(false)} aria-label="关闭">
              <Icon name="close" />
            </button>
          </div>
          {graph && (leftTab === 'display' ? <DisplayPanel graph={graph} /> : <TreePanel graph={graph} />)}
        </aside>

        <main className="stage">
          {graph ? <ViewerPane graph={graph} /> : null}
          {phase === 'error' && (
            <div className="overlay-center">
              <div className="error-card">
                <strong>无法启动 Unable to start</strong>
                <p>{message}</p>
              </div>
            </div>
          )}
        </main>

        <aside className={`panel panel-right${rightOpen ? ' open' : ''}`} aria-label="结构信息">
          <div className="panel-title">
            <span>
              结构信息 <span className="en">Details</span>
            </span>
            <button className="drawer-close" onClick={() => setRightOpen(false)} aria-label="关闭">
              <Icon name="close" />
            </button>
          </div>
          {graph && <InfoPanel graph={graph} />}
        </aside>

        {/* only the left drawer dims the stage; the details drawer leaves the model usable */}
        {leftOpen && <div className="backdrop" onClick={() => setLeftOpen(false)} />}
      </div>
      <AboutDialog />
    </div>
  )
}
