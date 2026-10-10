import { useEffect, useRef, useState } from 'react'
import type { AnatomyGraph } from '../anatomy/graph.ts'
import { debug } from '../debug.ts'
import { useApp } from '../state/store.ts'
import type { Viewer } from '../viewer/Viewer.ts'
import { Icon } from './Icon.tsx'

export function ViewerPane({ graph }: { graph: AnatomyGraph }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const [backend, setBackend] = useState<string | null>(null)
  const dataset = useApp((s) => s.dataset)
  const load = useApp((s) => s.load)
  const hover = useApp((s) => s.hover)
  const notices = useApp((s) => s.notices)
  const isolated = useApp((s) => s.isolated)
  const adjacentMode = useApp((s) => s.adjacentMode)
  const hiddenCount = useApp((s) => s.hidden.size)
  const peel = useApp((s) => s.peel)
  const section = useApp((s) => s.section.enabled)
  const colorMode = useApp((s) => s.colorMode)
  const provenanceHiddenCount = useApp((s) => s.provenanceHidden.size)
  const selection = useApp((s) => s.selection)
  const hasSelection = selection.ids.length > 0

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const app = useApp.getState()
    const params = new URLSearchParams(location.search)
    let viewer: Viewer | null = null
    let cancelled = false
    ;(async () => {
      try {
        // three.js and the loaders are a separate chunk, fetched while the UI is already up
        const { Viewer } = await import('../viewer/Viewer.ts')
        if (cancelled) return
        viewer = new Viewer(host, graph, `${import.meta.env.BASE_URL}anatomy/${dataset}/`, {
          forceWebGL: params.get('renderer') === 'webgl',
        })
        await viewer.init()
        if (cancelled) return viewer.dispose()
        debug.viewer = viewer
        debug.backend = viewer.backend
        setBackend(viewer.backend)
        // the tooltip follows the mouse and only shows for hovers that came from the canvas
        // (list rows in the info panel also set the hover highlight)
        viewer.onPointer = (xy) => {
          const tip = tipRef.current
          if (!tip) return
          tip.dataset.on = xy ? '1' : '0'
          if (xy) tip.style.transform = `translate(${xy.x + 14}px, ${xy.y + 16}px)`
        }
        const problems = await viewer.loadSystems((done, total) =>
          app.setLoad({ progress: 0.1 + 0.9 * (total ? done / total : 1), message: `加载模型… ${done}/${total}` }),
        )
        if (cancelled) return
        for (const p of problems) app.addNotice(p)
        app.setLoad({ phase: 'ready', progress: 1, message: '' })
      } catch (err) {
        console.error('[soma] viewer failed', err)
        if (!cancelled) app.setLoad({ phase: 'error', message: `渲染器初始化失败：${err instanceof Error ? err.message : String(err)}` })
      }
    })()
    return () => {
      cancelled = true
      if (debug.viewer === viewer) debug.viewer = null
      viewer?.dispose()
    }
  }, [graph, dataset])

  const app = useApp.getState()
  const hoverPart = hover ? graph.part(hover) : undefined
  const hoverName = hoverPart ? graph.partName(hoverPart) : null

  let selectionLabel: string | null = null
  if (selection.concept) {
    const c = graph.concept(selection.concept.tree, selection.concept.id)
    if (c) selectionLabel = `${graph.conceptName(c).primary}（${selection.ids.length}）`
  } else if (selection.ids.length === 1) {
    const p = graph.part(selection.ids[0]!)
    if (p) selectionLabel = graph.partName(p).primary
  } else if (selection.ids.length > 1) selectionLabel = `已选择 ${selection.ids.length} 个结构`

  return (
    <div className="viewer">
      <div className="viewer-host" ref={hostRef} />

      <div className="viewer-tools">
        <button className="tool-btn" onClick={() => app.requestHome()} title="复位视角 Reset view">
          <Icon name="home" /> <span>复位</span>
        </button>
        <button className="tool-btn" onClick={() => app.requestFocus()} title="聚焦所选 / 全部可见结构 (F)">
          <Icon name="target" /> <span>聚焦</span>
        </button>
        <button className="tool-btn" onClick={() => app.showAll()} title="显示全部 Show all">
          <Icon name="eye" /> <span>显示全部</span>
        </button>
      </div>

      <div className="viewer-status">
        {isolated && (
          <button className="chip chip-action" onClick={() => app.clearIsolation()}>
            隔离显示中（{isolated.size}） <Icon name="close" size={12} />
          </button>
        )}
        {adjacentMode && (
          <button className="chip chip-action" onClick={() => app.setAdjacentMode(false)}>
            相邻结构模式{hasSelection ? '' : '（请先选择结构）'} <Icon name="close" size={12} />
          </button>
        )}
        {hiddenCount > 0 && !isolated && (
          <button className="chip chip-action" onClick={() => app.showParts([...useApp.getState().hidden])}>
            已隐藏 {hiddenCount} 个结构 · 恢复
          </button>
        )}
        {peel > 0 && !isolated && (
          <button className="chip chip-action" onClick={() => app.setPeel(0)}>
            已剥离 {peel} 层 <Icon name="close" size={12} />
          </button>
        )}
        {colorMode === 'source' && (
          <button className="chip chip-action" onClick={() => app.setColorMode('tissue')} title="绿：扫描重建　橙：配准变形　蓝 / 紫：人工建模">
            按来源着色 <Icon name="close" size={12} />
          </button>
        )}
        {provenanceHiddenCount > 0 && !isolated && (
          <button className="chip chip-action" onClick={() => { for (const p of [...useApp.getState().provenanceHidden]) app.setProvenanceVisible(p, true) }}>
            已按来源隐藏 {provenanceHiddenCount} 类 · 恢复
          </button>
        )}
        {section && (
          <button className="chip chip-action" onClick={() => app.setSection({ enabled: false })}>
            剖切中 <Icon name="close" size={12} />
          </button>
        )}
      </div>

      {notices.length > 0 && (
        <div className="notice" role="status">
          <div>
            {notices.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
          <button className="icon-btn" aria-label="关闭提示" onClick={() => app.dismissNotices()}>
            <Icon name="close" />
          </button>
        </div>
      )}

      <div className="tooltip" ref={tipRef} data-on="0" style={{ visibility: hoverName ? undefined : 'hidden' }}>
        {hoverName && (
          <>
            <strong>{hoverName.primary}</strong>
            {hoverName.zh && <span>{hoverName.en}</span>}
          </>
        )}
      </div>

      {load.phase === 'loading' && (
        <div className="loading">
          <div className="loading-bar">
            <div style={{ width: `${Math.round(load.progress * 100)}%` }} />
          </div>
          <span>{load.message}</span>
        </div>
      )}

      {selectionLabel && (
        <button className="selection-bar" onClick={() => app.setRightOpen(true)}>
          <strong>{selectionLabel}</strong>
          <span>详情 ›</span>
        </button>
      )}

      <div className="viewer-footer">
        <span>仅供教学使用，非临床依据</span>
        {backend && <span className="mono">{backend === 'webgpu' ? 'WebGPU' : 'WebGL2'}</span>}
      </div>
    </div>
  )
}
