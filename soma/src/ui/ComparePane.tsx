// 并排对照：另一人体，限定一个系统，使用独立的渲染器，视角与主视图双向联动。
// 姿势、体型和疼痛表情也跟随主视图：另一人体自己的绑定 / 体型 / 表情数据在用到时才下载。
//   · 姿势按关节 id 原样套用（两副身体的关节 id 相同）；
//   · 体型按"相对各自默认值的偏移"套用（主视图身高 +10 cm → 这边也 +10 cm），再限制在这副身体的可用范围内；
//   · 表情用同一组 AU 强度，位移场用这副身体自己的。
// Side-by-side comparison: the other body, restricted to one system, in its own renderer
// with the camera linked to the main view (both ways).
// Pose, shape and the pain expression follow the main view too; the other body's own rig / shape /
// face data are downloaded only when used.
//   · the pose is applied as it is, by joint id (both bodies share joint ids);
//   · the shape is applied as offsets from each body's own defaults (stature +10 cm in the main view
//     → +10 cm here), then clamped to the range valid on this body;
//   · the expression uses the same AU intensities with this body's own displacement fields.

import { useEffect, useRef, useState } from 'react'
import { AnatomyGraph, boundsCenter } from '../anatomy/graph.ts'
import { fetchJson, loadDataset } from '../anatomy/load.ts'
import { loadRig, poseIsRest, type LoadedRig, type Scales } from '../anatomy/rig.ts'
import { loadShape, mapShapeControls, shapeScales, type LoadedShape, type ShapeControls } from '../anatomy/shape.ts'
import { loadFace, type LoadedFace } from '../pain/face.ts'
import type { SystemId } from '../anatomy/types.ts'
import { debug } from '../debug.ts'
import { EMPTY_SELECTION, hideListFrom, useApp } from '../state/store.ts'
import type { Viewer, ViewState } from '../viewer/Viewer.ts'
import { Icon } from './Icon.tsx'

const BODY_LABEL: Record<string, string> = { male: '男性 Male', female: '女性 Female' }
const EMPTY_POSE = {}
const NO_SHAPE: { controls: ShapeControls; scales: Scales | null } = { controls: {}, scales: null }
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

/** 另一人体按需下载的数据；undefined = 还没要过，null = 没有或不可用 / The other body's data, fetched on demand; undefined = not asked for yet, null = absent or unusable. */
interface OtherAssets {
  rig?: LoadedRig | null
  shape?: LoadedShape | null
  face?: LoadedFace | null
  /** 这副身体自己的"皮肤不透明时隐藏"清单（display.json）；null = 没有，按名称的规则 / This body's own "hide under an opaque skin" list (display.json); null = none, the name rule applies. */
  hide?: readonly string[] | null
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
  const [rigNote, setRigNote] = useState('')
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
    setRigNote('')
    ;(async () => {
      try {
        const [{ Viewer }, g] = await Promise.all([import('../viewer/Viewer.ts'), otherGraph(other)])
        if (cancelled) return
        const base = `${import.meta.env.BASE_URL}anatomy/${other}/`
        const assets: OtherAssets = {}
        // 主视图的清单是它那副身体的部件 id，这边要用这副身体自己的（文件只有一千字节左右，直接取）
        // the main view's list holds its own body's part ids; this pane needs this body's own (the file is about a kilobyte, so it is simply fetched)
        void fetchJson<unknown>(`${base}display.json`)
          .catch(() => null)
          .then((display) => {
            if (cancelled) return
            assets.hide = hideListFrom(display, (id) => !!g.part(id))
            viewer?.invalidateState()
          })
        // 按主视图当前的需要去取另一人体的数据；到了就让对照窗格重新同步
        // fetch what the main view's current state needs for the other body; re-sync the pane when it arrives
        const want = (): void => {
          const s = useApp.getState()
          const shaped = Object.keys(s.shapeControls).length > 0
          const facing = s.pain.hold || Object.keys(s.aus).length > 0 || s.painNonce !== nonce0 || !!s.expr || !!s.viseme || s.speech.status === 'playing'
          const got = (): void => {
            if (!cancelled) viewer?.invalidateState()
          }
          if (assets.shape === undefined && shaped) {
            assets.shape = null
            void loadShape(base).then((x) => ((assets.shape = x), got()), () => undefined)
          }
          if (assets.face === undefined && facing) {
            assets.face = null
            void loadFace(base).then((x) => ((assets.face = x), got()), () => undefined)
          }
          if (assets.rig === undefined && (!poseIsRest(s.pose) || s.breathing || s.jointScales || facing)) {
            assets.rig = null
            void loadRig(base).then((x) => ((assets.rig = x.ok ? x.rig : null), setRigNote(x.ok ? '' : '此人体暂不能摆姿势 posing unavailable'), got()), () => undefined)
          }
        }
        const nonce0 = useApp.getState().painNonce
        // 体型的换算按输入缓存，保证引用稳定（Viewer 按引用判断是否变化）
        // the mapped shape is cached per input so references stay stable (the Viewer compares by reference)
        let shapeKey: unknown[] = []
        let mapped = NO_SHAPE
        const shapeFor = (s: ReturnType<typeof useApp.getState>): typeof mapped => {
          const o = assets.shape
          if (!o) return NO_SHAPE
          if (shapeKey[0] !== s.shape || shapeKey[1] !== s.shapeControls || shapeKey[2] !== o) {
            shapeKey = [s.shape, s.shapeControls, o]
            const controls = mapShapeControls(s.shape, s.shapeControls, o)
            mapped = { controls, scales: shapeScales(o.data, controls) }
          }
          return mapped
        }
        // 显示它加载的全部内容（一个系统）；跟随主视图的着色方式、剖切和神经加粗
        // shows everything it loads (one system); follows the main view's colour mode, section and nerve aid
        const state = (): ViewState => {
          const s = useApp.getState()
          const shape = shapeFor(s)
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
            // 姿势、体型、表情跟随主视图，用这副身体自己的数据 / pose, shape and expression follow the main view with this body's own data
            rig: assets.rig ?? null,
            pose: assets.rig ? s.pose : EMPTY_POSE,
            poseAnimate: s.poseAnimate,
            breathing: s.breathing,
            poseJoint: null,
            jointScales: shape.scales,
            leftTab: 'display',
            cameraRequest: null,
            face: assets.face ?? null,
            // 对照窗格不画皱纹细节 / no wrinkle detail in the compare pane
            faceDetail: null,
            skinHide: assets.hide ?? null,
            skinOpaque: s.skinOpaque,
            shape: assets.shape ?? null,
            shapeControls: shape.controls,
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
        v.onReject = (kind, text) => {
          assets[kind] = null
          console.warn(`[soma] compare view: ${kind} data refused: ${text}`)
          if (kind === 'rig') setRigNote('此人体暂不能摆姿势 posing unavailable')
        }
        unsubscribe = useApp.subscribe(() => {
          want()
          v.invalidateState()
        })
        want()
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
        {status === 'ready' && rigNote && <span className="en"> {rigNote}</span>}
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
