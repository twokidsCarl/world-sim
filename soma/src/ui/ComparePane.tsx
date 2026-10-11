// 并排对照：另一人体，限定一个系统，使用独立的渲染器，视角与主视图双向联动。
// Side-by-side comparison: the other body, restricted to one system, in its own renderer
// with the camera linked to the main view (both ways).

import { useEffect, useRef, useState } from 'react'
import { AnatomyGraph, boundsCenter } from '../anatomy/graph.ts'
import { loadDataset } from '../anatomy/load.ts'
import type { SystemId } from '../anatomy/types.ts'
import { debug } from '../debug.ts'
import { EMPTY_SELECTION, useApp } from '../state/store.ts'
import type { Viewer, ViewState } from '../viewer/Viewer.ts'
import { Icon } from './Icon.tsx'

const BODY_LABEL: Record<string, string> = { male: '男性 Male', female: '女性 Female' }
const graphCache = new Map<string, Promise<AnatomyGraph>>()

function otherGraph(dataset: string): Promise<AnatomyGraph> {
  let g = graphCache.get(dataset)
  if (!g) {
    g = loadDataset(dataset).then((ds) => {
      if (ds.dataset !== dataset) throw new Error(`没有“${dataset}”人体数据`)
      return new AnatomyGraph(ds.data, ds.names, ds.relations)
    })
    g.catch(() => graphCache.delete(dataset))
    graphCache.set(dataset, g)
  }
  return g
}

/** 某个系统在人体中的中心：两个联动相机都相对它环绕。 */
/** Centre of one system in a body: the point both linked cameras orbit relative to. */
function systemCenter(graph: AnatomyGraph, system: SystemId): [number, number, number] {
  const b = graph.bounds(graph.partsBySystem(system).map((p) => p.id)) ?? graph.bodyBounds
  return boundsCenter(b)
}

export function ComparePane({ graph, dataset, system }: { graph: AnatomyGraph; dataset: string; system: SystemId }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const other = dataset === 'female' ? 'male' : 'female'
  const systems = graph.data.systems.filter((s) => s.partCount > 0 && s.glb)
  const app = useApp.getState()

  useEffect(() => {
    const host = hostRef.current
    const main = debug.viewer
    if (!host || !main) return
    let cancelled = false
    let viewer: Viewer | null = null
    let unsubscribe: (() => void) | null = null
    setStatus('loading')
    ;(async () => {
      try {
        const [{ Viewer }, g] = await Promise.all([import('../viewer/Viewer.ts'), otherGraph(other)])
        if (cancelled) return
        // 显示它加载的全部内容（一个系统）；跟随主视图的着色方式、剖切和神经加粗
        // shows everything it loads (one system); follows the main view's colour mode, section and nerve aid
        const state = (): ViewState => {
          const s = useApp.getState()
          return {
            systems: {},
            peel: 0,
            hidden: new Set(),
            isolated: null,
            adjacentMode: false,
            provenanceHidden: s.provenanceHidden,
            colorMode: s.colorMode,
            selection: EMPTY_SELECTION,
            hover: null,
            explode: 0,
            explodeSelectionOnly: false,
            section: s.section,
            nerveBoost: s.nerveBoost,
            focusRequest: { nonce: 0, ids: null },
            homeRequest: 0,
            // 对照窗格不显示体表图 / the compare pane does not show skin maps
            skinMapMode: 'off',
            skinMaps: null,
            skinRegions: [],
            skinHover: null,
            skinSeeThrough: false,
          }
        }
        viewer = new Viewer(host, g, `${import.meta.env.BASE_URL}anatomy/${other}/`, {
          forceWebGL: new URLSearchParams(location.search).get('renderer') === 'webgl',
          state,
          interactive: false,
        })
        await viewer.init()
        if (cancelled) return viewer.dispose()
        debug.compareViewer = viewer
        const v = viewer
        unsubscribe = useApp.subscribe(() => v.invalidateState())
        main.setAnchor(...systemCenter(graph, system))
        v.setAnchor(...systemCenter(g, system))
        // 先在主视图中对准该系统，然后让两个相机保持同步
        // frame the system in the main view, then keep the two cameras in step
        useApp.getState().requestFocus(graph.partsBySystem(system).map((p) => p.id))
        main.onCamera = (pose) => v.setPose(pose)
        v.onCamera = (pose) => main.setPose(pose)
        v.setPose(main.getPose())
        const problems = await v.loadSystems(() => {}, [system])
        if (cancelled) return
        v.setPose(main.getPose())
        setMessage(problems.join('；'))
        setStatus('ready')
      } catch (err) {
        if (cancelled) return
        console.warn('[soma] compare view failed', err)
        setMessage(err instanceof Error ? err.message : String(err))
        setStatus('error')
      }
    })()
    return () => {
      cancelled = true
      unsubscribe?.()
      if (main.onCamera) main.onCamera = null
      main.setAnchor(0, 0, 0)
      if (debug.compareViewer === viewer) debug.compareViewer = null
      viewer?.dispose()
    }
  }, [graph, other, system])

  return (
    <>
      <div className="compare-host" ref={hostRef} />
      <div className="compare-label compare-label-main">{BODY_LABEL[dataset] ?? dataset}</div>
      <div className="compare-label compare-label-other">
        {BODY_LABEL[other] ?? other}
        {status === 'loading' && <span className="en"> 加载中…</span>}
        {status === 'error' && <span className="en"> 无法加载：{message}</span>}
        {status === 'ready' && message && <span className="en"> {message}</span>}
      </div>
      <div className="compare-bar">
        <span>对照</span>
        <select value={system} aria-label="对照的系统" onChange={(e) => app.setCompare(e.target.value as SystemId)}>
          {systems.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name.zh}
            </option>
          ))}
        </select>
        <span className="hint">视角联动 · 仅左侧可选取</span>
        <button className="icon-btn" aria-label="退出对照" onClick={() => app.setCompare(null)}>
          <Icon name="close" />
        </button>
      </div>
    </>
  )
}
