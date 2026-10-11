import { useEffect, useRef } from 'react'
import { AnatomyGraph } from './anatomy/graph.ts'
import { loadDataset, requestedDataset } from './anatomy/load.ts'
import { debug } from './debug.ts'
import { useApp } from './state/store.ts'
import { readLocation, restoreFromUrl } from './state/urlSync.ts'
import { setEmbedKeys } from './ui/EmbedControls.tsx'
import { AboutDialog } from './ui/AboutDialog.tsx'
import { CautionsDialog } from './ui/CautionsDialog.tsx'
import { DisplayPanel } from './ui/DisplayPanel.tsx'
import { Icon } from './ui/Icon.tsx'
import { InfoPanel } from './ui/InfoPanel.tsx'
import { PainPanel } from './ui/PainPanel.tsx'
import { PosePanel } from './ui/PosePanel.tsx'
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

  const requestedBody = useApp((s) => s.requestedBody)

  const embed = useApp((s) => s.embed)

  // 第一个人体和初始状态由 URL 指定；之后状态的变化写回地址栏
  // the URL names the first body and the initial state; later changes are written back to the address bar
  const url = useRef<ReturnType<typeof readLocation> | null>(null)
  useEffect(() => {
    const u = readLocation()
    url.current = u
    setEmbedKeys(u.keys)
    useApp.setState({ requestedBody: requestedDataset(location.search), embed: !!u.state.embed })
  }, [])

  useEffect(() => {
    if (!requestedBody) return
    let cancelled = false
    const app = useApp.getState()
    if (app.graph && app.dataset === requestedBody) return
    app.setLoad({ phase: 'loading', progress: 0.02, message: '读取解剖数据…', loaded: [] })
    loadDataset(requestedBody)
      .then(async (ds) => {
        if (cancelled) return
        const g = new AnatomyGraph(ds.data, ds.names, ds.relations)
        debug.graph = g
        for (const n of ds.notices) app.addNotice(n)
        app.init(g, ds.dataset)
        // 缺少的人体会回退到示例数据；切换控件随之显示实际加载的那个
        // a missing body falls back to the fixture; the switch then shows what is really loaded
        useApp.setState({ requestedBody: ds.dataset })
        app.setLoad({ progress: 0.1, message: '加载模型…' })
        const u = url.current
        if (u) {
          // 只在第一次加载时按 URL 恢复；之后开始把状态写回 URL
          // restore from the URL on the first load only, then start writing state back to it
          url.current = null
          const warnings = await restoreFromUrl(u.state)
          for (const w of warnings) console.warn(`[soma] URL: ${w}`)
          u.begin()
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.error('[soma] dataset load failed', err)
        app.setLoad({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [requestedBody])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      const app = useApp.getState()
      if (e.key === 'Escape') {
        if (app.cautionsOpen) app.dismissCautions()
        else if (app.aboutOpen) app.setAboutOpen(false)
        else app.clearSelection()
      } else if (e.key === 'f' || e.key === 'F') app.requestFocus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (embed) {
    // 嵌入模式：只有舞台；没有顶栏、侧栏和任何对话框
    // embed mode: the stage only; no top bar, side panels or dialogs
    return (
      <div className="app app-embed">
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
      </div>
    )
  }

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
            <button role="tab" aria-selected={leftTab === 'pose'} className={leftTab === 'pose' ? 'active' : ''} onClick={() => setLeftTab('pose')}>
              姿势 <span className="en">Pose</span>
            </button>
            <button role="tab" aria-selected={leftTab === 'pain'} className={leftTab === 'pain' ? 'active' : ''} onClick={() => setLeftTab('pain')}>
              疼痛 <span className="en">Pain</span>
            </button>
            <button className="drawer-close" onClick={() => setLeftOpen(false)} aria-label="关闭">
              <Icon name="close" />
            </button>
          </div>
          {graph && (leftTab === 'display' ? <DisplayPanel graph={graph} /> : leftTab === 'pose' ? <PosePanel graph={graph} /> : leftTab === 'pain' ? <PainPanel graph={graph} /> : <TreePanel graph={graph} />)}
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
      <CautionsDialog />
    </div>
  )
}
