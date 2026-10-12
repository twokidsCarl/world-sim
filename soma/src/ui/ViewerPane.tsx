import { useEffect, useRef, useState } from 'react'
import type { AnatomyGraph } from '../anatomy/graph.ts'
import { debug } from '../debug.ts'
import { useApp } from '../state/store.ts'
import { setUrlCamera } from '../state/urlSync.ts'
import type { Viewer } from '../viewer/Viewer.ts'
import { ComparePane } from './ComparePane.tsx'
import { EmbedControls } from './EmbedControls.tsx'
import { StimMonitor } from './StimMonitor.tsx'
import { Icon } from './Icon.tsx'

function bodyUrl(dataset: string): string {
  return `${import.meta.env.BASE_URL}anatomy/${dataset}/`
}

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
  const compare = useApp((s) => s.compare)
  const skinHover = useApp((s) => s.skinHover)
  const skinSeeThrough = useApp((s) => s.skinSeeThrough)
  const skinMap = useApp((s) => (s.skinMapMode === 'off' ? undefined : s.skinMaps?.maps.find((m) => m.id === s.skinMapMode)))
  const hasSelection = selection.ids.length > 0
  const embed = useApp((s) => s.embed)
  const stimArmed = useApp((s) => s.stimArmed)

  const viewerRef = useRef<Viewer | null>(null)
  const [ready, setReady] = useState(false)
  const firstGraph = useRef(graph)

  // 整个页面只用一个渲染器；人体在其中替换
  // one renderer for the life of the page; bodies are swapped into it
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const app = useApp.getState()
    const params = new URLSearchParams(location.search)
    let viewer: Viewer | null = null
    let cancelled = false
    ;(async () => {
      try {
        // three.js 与加载器是单独的代码块，界面先显示、随后再取
        // three.js and the loaders are a separate chunk, fetched while the UI is already up
        const { Viewer } = await import('../viewer/Viewer.ts')
        if (cancelled) return
        viewer = new Viewer(host, firstGraph.current, bodyUrl(app.dataset), {
          forceWebGL: params.get('renderer') === 'webgl',
          embed: app.embed,
        })
        viewer.autoLoad = true
        viewer.onCameraSettled = (cam) => setUrlCamera(cam)
        await viewer.init()
        if (cancelled) return viewer.dispose()
        viewerRef.current = viewer
        debug.viewer = viewer
        debug.backend = viewer.backend
        setBackend(viewer.backend)
        // 提示框跟随鼠标，且只对来自画布的悬停显示（信息面板的列表行也会设置悬停高亮）
        // the tooltip follows the mouse and only shows for hovers that came from the canvas
        // (list rows in the info panel also set the hover highlight)
        viewer.onPointer = (xy) => {
          const tip = tipRef.current
          if (!tip) return
          tip.dataset.on = xy ? '1' : '0'
          if (xy) tip.style.transform = `translate(${xy.x + 14}px, ${xy.y + 16}px)`
        }
        setReady(true)
      } catch (err) {
        console.error('[soma] viewer failed', err)
        if (!cancelled) app.setLoad({ phase: 'error', message: `渲染器初始化失败：${err instanceof Error ? err.message : String(err)}` })
      }
    })()
    return () => {
      cancelled = true
      if (debug.viewer === viewer) debug.viewer = null
      viewerRef.current = null
      viewer?.dispose()
    }
  }, [])

  // 加载当前人体的几何：只取显示状态需要的系统，隐藏的系统等到显示时再取；切换人体时释放旧的并保留视角
  // load the current body's geometry: only the systems the display state needs, hidden ones when
  // they are shown; a body switch frees the old one and keeps the camera
  useEffect(() => {
    const viewer = viewerRef.current
    if (!ready || !viewer) return
    const app = useApp.getState()
    if (viewer.isStale(graph)) viewer.setBody(graph, bodyUrl(app.dataset), { keepCamera: true })
    const reported = new Set<string>()
    viewer.onLoad = (p) => {
      if (viewer.isStale(graph)) return
      for (const problem of p.problems) {
        if (!reported.has(problem)) {
          reported.add(problem)
          app.addNotice(problem)
        }
      }
      const pending = p.done < p.total
      app.setLoad({
        phase: pending ? 'loading' : 'ready',
        progress: pending ? 0.1 + 0.9 * (p.total ? p.done / p.total : 1) : 1,
        message: pending ? `加载模型… ${p.done}/${p.total}` : '',
        loaded: p.loaded,
        bytes: p.bytes,
        bytesTotal: p.bytesTotal,
      })
    }
    viewer.invalidateState()
    return () => {
      viewer.onLoad = null
    }
  }, [ready, graph])

  const app = useApp.getState()
  const hoverPart = hover ? graph.part(hover) : undefined
  // 悬停在体表图上时，提示区域名而不是"皮肤" / over a skin map, the tooltip names the region, not "skin"
  const hoverRegion = skinMap && skinHover !== null && hoverPart ? skinMap.regions[skinHover] : undefined
  const hoverName = hoverRegion
    ? { primary: hoverRegion.name.zh, en: hoverRegion.name.en, zh: hoverRegion.name.zh, broader: undefined }
    : hoverPart
      ? graph.partName(hoverPart)
      : null

  let selectionLabel: string | null = null
  if (selection.concept) {
    const c = graph.concept(selection.concept.tree, selection.concept.id)
    if (c) selectionLabel = `${graph.conceptName(c).primary}（${selection.ids.length}）`
  } else if (selection.ids.length === 1) {
    const p = graph.part(selection.ids[0]!)
    if (p) selectionLabel = graph.partName(p).primary
  } else if (selection.ids.length > 1) selectionLabel = `已选择 ${selection.ids.length} 个结构`

  return (
    <div className={`viewer${compare ? ' comparing' : ''}${embed ? ' embedded' : ''}${stimArmed ? ' stim-armed' : ''}`}>
      <div className="viewer-host" ref={hostRef} />
      {compare && ready && <ComparePane graph={graph} dataset={dataset} system={compare.system} />}

      <StimMonitor />
      {embed && <EmbedControls graph={graph} />}
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
        {skinMap && (
          <button className="chip chip-action" onClick={() => app.setSkinMapMode('off')} title="教学示意图，未经临床审校 / teaching map, not clinically reviewed">
            体表图：{skinMap.name.zh} <Icon name="close" size={12} />
          </button>
        )}
        {skinSeeThrough && (
          <button className="chip chip-action" onClick={() => app.setSkinSeeThrough(false)}>
            皮肤半透明 · 恢复
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
            {hoverName.broader && <span>所属概念：{hoverName.broader.zh ?? hoverName.broader.en}</span>}
          </>
        )}
      </div>

      {load.phase === 'loading' && (
        <div className="loading">
          <div className="loading-bar">
            <div style={{ width: `${Math.round(load.progress * 100)}%` }} />
          </div>
          <span>
            {load.message}
            {load.bytesTotal ? ` · ${(Math.min(load.bytes ?? 0, load.bytesTotal) / 1048576).toFixed(1)} / ${(load.bytesTotal / 1048576).toFixed(1)} MB` : ''}
          </span>
          <ul className="loading-systems">
            {graph.data.systems
              .filter((sys) => sys.glb)
              .map((sys) => (
                <li key={sys.id} className={load.loaded.includes(sys.id) ? 'done' : ''}>
                  {sys.name.zh}
                </li>
              ))}
          </ul>
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
