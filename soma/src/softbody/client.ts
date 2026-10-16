// 软组织物理在主线程这一侧：界面状态（小 store）、两个 Web Worker 的生命周期、把部件几何送过去、把算出的位移
// （按压的凹陷、体位的下垂）合成后交给视图，以及 phys= / grav= 地址参数。计算都在 worker 里（src/softbody/worker.ts）。
// The main-thread side of the soft-tissue physics: UI state (a small store), the life cycle of the two Web Workers,
// shipping part geometry to them, composing the displacements they return (a press's dent, a posture's sag) for the
// viewer, and the phys= / grav= URL parameters. All computing happens in the workers (src/softbody/worker.ts).
//
// 疼痛输入 / Pain input
//   钝压（pressure）在"物理按压"打开时，由这里注册的 ContactProvider（src/pain/stim.ts）先算接触，再把到达的力和接触面积
//   交给疼痛模型：模型的压强 = 力 ÷ 面积 = 算出的平均接触压强。
//   With "physics press" on, a pressure stimulus first gets its contact from the ContactProvider registered here
//   (src/pain/stim.ts); the force reached and the contact area then go to the pain model, whose pressure = force ÷ area =
//   the computed mean contact pressure.

import { create } from 'zustand'
import { applyStimulus, registerContactProvider } from '../pain/stim.ts'
import { defaultSettings, formatSite, parseSite, siteRefOf, type Contact, type ResolvedSite } from '../pain/stimulus.ts'
import { useApp } from '../state/store.ts'
import { whenSoftHost, type SoftHost } from './host.ts'
import type { DentPatchData } from '../viewer/dentPatch.ts'
import { interpolateToDent } from './dentmesh.ts'
import { type BodyPayload, type MeshPayload, type PartDent, type PartLite, type PatchUpdate, type PhysParam, type Posture, type PostureStats, type PressSite, type PressSummary, type PressTiming, type ProbeSpec, type Reply, type SparseOffsets, addSparse, cageParts, displacementColors, formatGravParam, formatPhysParam, parseGravParam, parsePhysParam, releaseEnvelope, siteBox, siteGeometry, sparseMaxMm } from './protocol.ts'
import { FEMALE_UNAVAILABLE } from './statements.ts'

export type JobStatus = 'idle' | 'preparing' | 'running' | 'paused' | 'done' | 'error' | 'unavailable'

export interface SoftState {
  /** 钝压用物理按压（而不是名义的 1 cm² 探头）/ pressure uses the physics press (rather than the nominal 1 cm² probe) */
  pressOn: boolean
  probe: ProbeSpec
  control: 'force' | 'depth'
  forceN: number
  depthMm: number
  pressStatus: JobStatus
  pressMessage: string
  pressProgress: { stage: 'cage' | 'solve'; frames: number; depthMm: number | null; elapsedMs: number; dentMm: number } | null
  pressResult: PressSummary | null
  /** worker 的计时，加上主线程看到的：点击到第一次显示凹陷、点击到结果 / the worker's timing plus what the main thread saw: click to first dent shown, click to result */
  pressTiming: (PressTiming & { clickToFirstDentMs: number | null; clickToResultMs: number; prepareMs: number }) | null
  /** 地址里怎么写上一次按压的部位 / how the last press's site is written in the URL */
  pressSite: string | null
  /** 体位物理打开（phys=1 或选了一个体位）/ posture physics on (phys=1, or a posture was chosen) */
  physOn: boolean
  posture: Posture
  postureStatus: JobStatus
  postureMessage: string
  postureProgress: { frames: number; maxSpeed: number; msPerFrame: number; elapsedMs: number } | null
  postureStats: PostureStats | null
  /** 两个 worker 的求解器在哪里跑（GPU = WebGPU；null = 还没开）与没用 GPU 的原因 / where each worker's solver runs (GPU = WebGPU; null = not opened yet) and why the GPU is not used */
  pressBackend: 'gpu' | 'cpu' | null
  postureBackend: 'gpu' | 'cpu' | null
  gpuReason: string
  /** 显示的放大倍数（1 = 真实大小）/ display exaggeration (1 = true size) */
  exaggerate: number
  /** 皮肤按体位位移着色（真实大小）/ colour the skin by the posture displacement (true size) */
  colorOn: boolean
  setPress(patch: Partial<Pick<SoftState, 'pressOn' | 'probe' | 'control' | 'forceN' | 'depthMm'>>): void
  setPosture(p: Posture): void
  setExaggerate(k: number): void
  setColorOn(on: boolean): void
}

let writeParam: ((key: string, value: string | null) => void) | null = null
/** 由 urlSync 注册：写回一个地址参数 / Registered by urlSync: writes one URL parameter back. */
export function registerSoftUrlWriter(fn: ((key: string, value: string | null) => void) | null): void {
  writeParam = fn
}

function writeUrl(): void {
  const s = useSoft.getState()
  const press: PhysParam | null = s.pressOn && s.pressSite ? { probe: s.probe, target: s.control === 'force' ? { forceN: s.forceN } : { depthMm: s.depthMm }, site: s.pressSite } : null
  writeParam?.('phys', formatPhysParam(press, s.physOn))
  if (s.physOn) writeParam?.('grav', formatGravParam(s.posture))
}

export const useSoft = create<SoftState>((set) => ({
  pressOn: false,
  probe: { kind: 'sphere', radiusMm: 5 },
  control: 'force',
  forceN: 1,
  depthMm: 3,
  pressStatus: 'idle',
  pressMessage: '',
  pressProgress: null,
  pressResult: null,
  pressTiming: null,
  pressSite: null,
  physOn: false,
  posture: 'standing',
  postureStatus: 'idle',
  postureMessage: '',
  postureProgress: null,
  postureStats: null,
  pressBackend: null,
  postureBackend: null,
  gpuReason: '',
  exaggerate: 1,
  colorOn: true,
  setPress: (patch) => {
    set(patch)
    if (patch.pressOn === false) releaseDent()
    writeUrl()
  },
  setPosture: (p) => {
    set({ posture: p, physOn: true })
    writeUrl()
    void runPosture(p)
  },
  setExaggerate: (k) => {
    set({ exaggerate: k })
    compose()
  },
  setColorOn: (on) => {
    set({ colorOn: on })
    applyColors()
  },
}))

// ---------------------------------------------------------------- 人体与 worker / body and workers

interface Channel {
  worker: Worker
  sent: Set<string>
  handlers: Map<number, (r: Reply) => void>
  ready: Promise<void>
  skinN: number
  backend: 'gpu' | 'cpu'
}

/**
 * 地址参数 pgpu=0：软组织物理不用 GPU（对照、排查用）；缺省有 WebGPU 就用。
 * The URL parameter pgpu=0: the soft-tissue physics does not use the GPU (for comparison and troubleshooting); by
 * default it does whenever WebGPU is there.
 */
function gpuAllowed(): boolean {
  return typeof location === 'undefined' || new URLSearchParams(location.search).get('pgpu') !== '0'
}

let seq = 0
let pressCh: Promise<Channel> | null = null
let postureCh: Promise<Channel> | null = null
let bodyOf: unknown = null
let skinPart: string | null = null

/** 女性（以及没有绑定的人体）不开放 / Closed for the female (and for a body without a rig). */
export function softAvailable(): { ok: boolean; reason: { zh: string; en: string } | null } {
  const g = useApp.getState().graph
  if (!g) return { ok: false, reason: { zh: '人体还没有加载', en: 'no body loaded yet' } }
  if (g.data.body !== 'male') return { ok: false, reason: g.data.body === 'female' ? FEMALE_UNAVAILABLE : { zh: '只对男性人体开放', en: 'available on the male body only' } }
  return { ok: true, reason: null }
}

function partsLite(): PartLite[] {
  const g = useApp.getState().graph!
  return g.data.parts.map((p) => ({ id: p.id, name: p.name, system: p.system, tissue: p.tissue, ...(p.side ? { side: p.side } : {}), bbox: [...p.bbox], centroid: [...p.centroid], triangles: p.triangles }))
}

async function bodyPayload(host: SoftHost): Promise<BodyPayload> {
  const app = useApp.getState()
  await host.request(['integumentary'])
  const rig = await app.ensureRig()
  if (!rig) throw new Error('这副人体没有可用的骨架绑定，软组织物理需要它 / this body has no usable rig, which the soft-tissue physics needs')
  const skin = host.skin()
  if (!skin) throw new Error('皮肤还没有加载 / the skin is not loaded')
  skinPart = skin.part
  return { body: 'male', parts: partsLite(), skin: { id: skin.part, positions: skin.positions.slice(), indices: skin.indices.slice() }, rig: rig.rig, rigBin: rig.bin }
}

function openChannel(kind: 'press' | 'posture'): Promise<Channel> {
  return (async () => {
    const host = await whenSoftHost()
    const payload = await bodyPayload(host)
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    const ch: Channel = { worker, sent: new Set([payload.skin.id]), handlers: new Map(), ready: Promise.resolve(), skinN: payload.skin.positions.length / 3, backend: 'cpu' }
    ch.ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<Reply>) => {
        const r = ev.data
        if (r.type === 'ready') {
          ch.backend = r.backend
          useSoft.setState(kind === 'press' ? { pressBackend: r.backend } : { postureBackend: r.backend })
          if (r.gpuReason) useSoft.setState({ gpuReason: r.gpuReason })
          return resolve()
        }
        if (r.type === 'error' && r.id < 0) return reject(new Error(r.message))
        if ('id' in r) ch.handlers.get(r.id)?.(r)
      }
      worker.onerror = (ev) => reject(new Error(ev.message || 'softbody worker failed'))
    })
    worker.postMessage({ type: 'init', body: payload, gpu: gpuAllowed() })
    await ch.ready
    return ch
  })()
}

/** 把还没送过的部件几何送去（先按需加载它们所在的系统）/ Ships the part geometry not sent yet (loading their systems on demand first). */
async function sendMeshes(ch: Channel, ids: string[]): Promise<number> {
  const host = await whenSoftHost()
  const g = useApp.getState().graph!
  const need = ids.filter((id) => !ch.sent.has(id))
  if (!need.length) return 0
  const systems = [...new Set(need.map((id) => g.part(id)?.system).filter((s): s is NonNullable<typeof s> => !!s))]
  await host.request(systems)
  const meshes: MeshPayload[] = []
  for (const id of need) {
    const m = host.restGeometry(id)
    if (!m) continue
    meshes.push({ id, positions: m.positions, indices: m.indices })
    ch.sent.add(id)
  }
  ch.worker.postMessage({ type: 'meshes', meshes }, meshes.flatMap((m) => [m.positions.buffer, m.indices.buffer]))
  return meshes.length
}

function resetForBody(): void {
  for (const p of [pressCh, postureCh]) void p?.then((c) => c.worker.terminate()).catch(() => {})
  pressCh = postureCh = null
  dent = null
  patch = patchMesh = patchOut = null
  dentPhase = 'none'
  postureNow = postureFrom = null
  partsNow = new Map()
  partsFrom = new Map()
  composed = null
  useSoft.setState({ pressStatus: 'idle', pressMessage: '', pressProgress: null, pressResult: null, pressTiming: null, pressSite: null, postureStatus: 'idle', postureMessage: '', postureProgress: null, postureStats: null, posture: 'standing', pressBackend: null, postureBackend: null })
  void whenSoftHost(1).then((h) => (h.setSkinOffset(null), h.setSkinColors(null))).catch(() => {})
}

// ---------------------------------------------------------------- 显示：位移的合成 / display: composing the displacement

let dent: SparseOffsets | null = null
/** 凹陷的细分显示网格（来自 worker）/ the dent's subdivided display mesh (from the worker) */
let patchMesh: NonNullable<PatchUpdate['mesh']> | null = null
let patch: PatchUpdate | null = null
let patchOut: DentPatchData | null = null
/** 按压时其他部件（皮下脂肪等）的凹陷 / the dent of other parts (subcutaneous fat…) during a press */
let dentParts: PartDent[] = []
let dentPhase: 'none' | 'solving' | 'held' | 'releasing' = 'none'
let releaseAt = 0
let heldContact: Contact | null = null
/** 链接（卡片）施加的按压：凹陷一直留着，直到换掉或清除 / a press applied by a link (a card): the dent stays until replaced or cleared */
let dentPersist = false
let postureNow: Float32Array | null = null
let postureFrom: Float32Array | null = null
/** 其他部件（皮肤的其他片、皮下脂肪）的体位位移 / the posture displacement of other parts (other skin pieces, subcutaneous fat) */
let partsNow = new Map<string, Float32Array>()
let partsFrom = new Map<string, Float32Array>()
const partsOut = new Map<string, Float32Array>()
let tweenAt = 0
const TWEEN_MS = 900
let composed: Float32Array | null = null
let raf = 0

function skinCount(): number {
  return postureNow ? postureNow.length / 3 : composed ? composed.length / 3 : (useApp.getState().skinMaps?.vertexCount ?? 0)
}

/** 把体位位移和凹陷合成一份，交给视图；还在过渡时排下一帧 / Composes the posture displacement and the dent into one and hands it to the viewer; schedules another frame while a transition runs. */
function compose(): void {
  const now = performance.now()
  const k = useSoft.getState().exaggerate
  const tw = postureNow && postureFrom ? Math.min(1, (now - tweenAt) / TWEEN_MS) : 1
  const env = dentPhase === 'releasing' ? releaseEnvelope(now - releaseAt) : dent ? 1 : 0
  if (dentPhase === 'releasing' && env === 0) {
    dent = null
    dentParts = []
    patch = patchMesh = null
    dentPhase = 'none'
  }
  const posture = postureNow && postureNow.some((v) => v !== 0)
  const host = softHostSync
  if (!posture && !dent && !(postureFrom && tw < 1)) {
    composed = null
    partsOut.clear()
    host?.setSkinOffset(null)
  } else {
    const n = (postureNow?.length ?? postureFrom?.length ?? 0) || skinCount() * 3
    if (!composed || composed.length !== n) composed = new Float32Array(n)
    composed.fill(0)
    const e = tw < 0.5 ? 2 * tw * tw : 1 - Math.pow(-2 * tw + 2, 2) / 2
    if (postureNow) for (let i = 0; i < n; i++) composed[i] = k * ((postureFrom ? postureFrom[i]! * (1 - e) : 0) + postureNow[i]! * e)
    if (dent) addSparse(composed, dent, k * env)
    // 细分网格：静止位置 + 体位位移（由角插值）+ 凹陷；盖住的皮肤顶点 = 体位位移 + 向里收 / the subdivided mesh: rest + posture displacement (interpolated from the corners) + dent; covered skin vertices = posture displacement + drawn inward
    let dp: DentPatchData | null = null
    if (dent && patch && patchMesh && env > 0) {
      const m = patchMesh, nv = m.position.length / 3
      if (!patchOut || patchOut.position.length !== nv * 3 || patchOut.index !== m.index) patchOut = { position: new Float32Array(nv * 3), index: m.index, corners: m.corners, weights: m.weights, hidden: m.hidden, hideOffsets: new Float32Array(m.hidden.length * 3) }
      const pos = patchOut.position
      if (postureNow) interpolateToDent(m, composed, pos)
      else pos.fill(0)
      // composed 已含凹陷在粗顶点上的部分：减掉它，换成细分顶点上的凹陷 / composed already carries the dent at the coarse vertices: take that out, put the dent at the subdivided vertices in
      if (postureNow) {
        const coarseDent = new Float32Array(composed.length)
        addSparse(coarseDent, dent, k * env)
        const cd = interpolateToDent(m, coarseDent, new Float32Array(nv * 3))
        for (let q = 0; q < pos.length; q++) pos[q] = pos[q]! - cd[q]!
      }
      for (let q = 0; q < pos.length; q++) pos[q] = pos[q]! + m.position[q]! + k * env * patch.dent[q]!
      m.hidden.forEach((v, j) => {
        for (let r = 0; r < 3; r++) patchOut!.hideOffsets[j * 3 + r] = (postureNow ? k * (postureNow[v * 3 + r] ?? 0) : 0) + env * patch!.hide[j * 3 + r]!
      })
      dp = patchOut
    }
    partsOut.clear()
    for (const [id, now] of partsNow) {
      const from = partsFrom.get(id)
      const o = new Float32Array(now.length)
      for (let q = 0; q < o.length; q++) o[q] = k * ((from ? from[q]! * (1 - e) : 0) + now[q]! * e)
      partsOut.set(id, o)
    }
    if (dent) for (const d of dentParts) {
      let o = partsOut.get(d.id)
      if (!o) partsOut.set(d.id, (o = new Float32Array(d.count * 3)))
      addSparse(o, d, k * env)
    }
    host?.setSkinOffset(composed, dp, partsOut)
  }
  if (tw >= 1) {
    postureFrom = null
    partsFrom = new Map()
  }
  const again = (postureFrom !== null && tw < 1) || dentPhase === 'releasing'
  if (again && !raf) raf = requestAnimationFrame(() => {
    raf = 0
    compose()
  })
}

let softHostSync: SoftHost | null = null
void whenSoftHost(600000).then((h) => (softHostSync = h)).catch(() => {})

/** 体位位移的着色：真实大小，与放大倍数无关；站立（位移为零）时关闭 / colours of the posture displacement: true size, whatever the exaggeration; off when standing (zero displacement) */
function applyColors(): void {
  const on = useSoft.getState().colorOn && !!postureNow && postureNow.some((v) => v !== 0)
  softHostSync?.setSkinColors(on ? displacementColors(postureNow!) : null)
}

function releaseDent(): void {
  if (!dent || dentPhase === 'releasing') return
  dentPhase = 'releasing'
  releaseAt = performance.now()
  compose()
}

// 按压的凹陷在刺激结束（或被清除、换掉）时回弹 / a press's dent springs back when the stimulus ends (or is cleared or replaced)
useApp.subscribe((s, p) => {
  if (s.graph !== p.graph && bodyOf !== s.graph) {
    bodyOf = s.graph
    resetForBody()
    return
  }
  if (dentPhase !== 'held') return
  const stim = s.stim
  if (!stim || stim.contact !== heldContact) return releaseDent()
  if (!dentPersist && s.stimNow && s.stimNow.t >= stim.e.stimulusEnd) releaseDent()
})

// ---------------------------------------------------------------- 按压 / press

let pressJob = 0

/**
 * 在一点上按压（ContactProvider：钝压施加时由 src/pain/stim.ts 调用）。返回接触；物理按压没打开时返回 null（用名义值）。
 * Presses at a site (the ContactProvider, called by src/pain/stim.ts when a pressure stimulus is applied). Returns the
 * contact; returns null when the physics press is off (the nominal value is used).
 */
function provideContact(site: ResolvedSite): Promise<Contact | null> | null {
  if (!useSoft.getState().pressOn) return null
  const persist = fromLink
  fromLink = false
  return runPress(site, persist)
}
let fromLink = false
registerContactProvider(provideContact)

export async function runPress(site: ResolvedSite & { triangle?: [number, number, number]; barycentric?: [number, number, number] }, persist = false): Promise<Contact | null> {
  const avail = softAvailable()
  if (!avail.ok) {
    useSoft.setState({ pressStatus: 'unavailable', pressMessage: `${avail.reason!.zh} / ${avail.reason!.en}` })
    throw new Error(`${avail.reason!.zh} / ${avail.reason!.en}`)
  }
  const st = useSoft.getState()
  const t0 = performance.now()
  // 上一次还在算：结果作废，worker 重开（按压一次算完，中途停不下来）/ the previous press is still solving: dropped, and its worker restarted (a press runs in one go)
  if (st.pressStatus === 'running' || st.pressStatus === 'preparing') {
    const old = pressCh
    pressCh = null
    void old?.then((c) => c.worker.terminate()).catch(() => {})
  }
  const job = ++pressJob
  dentPersist = persist
  if (dent) {
    dent = null
    patch = patchMesh = null
    dentPhase = 'none'
    compose()
  }
  useSoft.setState({ pressStatus: 'preparing', pressMessage: '', pressProgress: null, pressResult: null, pressTiming: null, pressSite: formatSite(siteRefOf(site)) })
  writeUrl()
  try {
    pressCh ??= openChannel('press')
    const ch = await pressCh
    const probe = { ...st.probe }
    const target = st.control === 'force' ? { forceN: st.forceN } : { depthMm: st.depthMm }
    const g = siteGeometry(probe.radiusMm / 1000)
    await sendMeshes(ch, cageParts(partsLite(), siteBox(site.position, g.extent, g.cell)).map((p) => p.id))
    const prepareMs = Math.round(performance.now() - t0)
    if (job !== pressJob) return null
    useSoft.setState({ pressStatus: 'running' })
    const id = ++seq
    let firstShown: number | null = null
    const done = await new Promise<Reply>((resolve) => {
      ch.handlers.set(id, (r) => {
        if (job !== pressJob) {
          ch.handlers.delete(id)
          return resolve({ type: 'error', id, message: 'superseded' })
        }
        if (r.type === 'progress') {
          if (r.patch) {
            if (r.patch.mesh) patchMesh = r.patch.mesh
            patch = r.patch
          }
          if (r.parts) dentParts = r.parts
          if (r.dent) {
            dent = r.dent
            dentPhase = 'solving'
            compose()
            if (firstShown === null && r.dent.vertices.length) firstShown = Math.round(performance.now() - t0)
          }
          useSoft.setState({ pressProgress: { stage: r.stage, frames: r.frames, depthMm: r.depthMm ?? null, elapsedMs: r.elapsedMs, dentMm: r.dent ? Math.round(sparseMaxMm(r.dent) * 100) / 100 : 0 } })
          return
        }
        ch.handlers.delete(id)
        resolve(r)
      })
      const ps: PressSite = { position: [...site.position], vertex: site.vertex, ...(site.triangle && site.barycentric ? { triangle: [...site.triangle], barycentric: [...site.barycentric] } : {}) }
      ch.worker.postMessage({ type: 'press', id, site: ps, probe, target })
    })
    if (job !== pressJob) return null
    if (done.type === 'error') throw new Error(done.message)
    if (done.type !== 'press-done') throw new Error('softbody worker: unexpected reply')
    dent = done.dent
    dentParts = done.parts
    if (done.patch) {
      if (done.patch.mesh) patchMesh = done.patch.mesh
      patch = done.patch
    }
    if (firstShown === null) firstShown = Math.round(performance.now() - t0)
    const r = done.result
    const contact: Contact | null = r.contactAreaMm2 > 0 && r.forceN > 0 && Number.isFinite(r.forceN) ? { forceN: r.forceN, areaMm2: r.contactAreaMm2, meanPressureKPa: r.meanPressureKPa, peakPressureKPa: r.peakPressureKPa, depthMm: r.depthMm } : null
    heldContact = contact
    dentPhase = contact ? 'held' : 'none'
    compose()
    if (!contact) releaseDent()
    useSoft.setState({
      pressStatus: contact ? 'done' : 'error',
      pressMessage: contact ? '' : '压头没有接触到皮肤（或求解不是有限数），疼痛模型没有收到压强 / the probe made no contact (or the solve was not finite); the pain model received no pressure',
      pressResult: r,
      pressTiming: { ...done.timing, clickToFirstDentMs: firstShown, clickToResultMs: Math.round(performance.now() - t0), prepareMs },
    })
    return contact
  } catch (err) {
    if (job !== pressJob) return null
    const message = err instanceof Error ? err.message : String(err)
    useSoft.setState({ pressStatus: 'error', pressMessage: message })
    releaseDent()
    throw err
  }
}

// ---------------------------------------------------------------- 体位 / posture

let postureJob = 0

async function runPosture(p: Posture): Promise<void> {
  const avail = softAvailable()
  if (!avail.ok) {
    useSoft.setState({ postureStatus: 'unavailable', postureMessage: `${avail.reason!.zh} / ${avail.reason!.en}` })
    return
  }
  const job = ++postureJob
  const showOffsets = (o: Float32Array | null, parts: Map<string, Float32Array> = new Map()): void => {
    postureFrom = composed && postureNow ? postureNow : null
    postureNow = o
    partsFrom = partsNow
    partsNow = parts
    tweenAt = performance.now()
    compose()
    applyColors()
  }
  if (p === 'standing') {
    // 站立就是参考：位移为零（预应力使站立平衡在发布的形状上）/ standing is the reference: zero displacement (the pre-stress puts the standing equilibrium on the shipped shape)
    useSoft.setState({ postureStatus: 'done', postureMessage: '', postureProgress: null, postureStats: null })
    if (postureNow) showOffsets(new Float32Array(postureNow.length), new Map([...partsNow].map(([id, o]) => [id, new Float32Array(o.length)])))
    return
  }
  useSoft.setState({ postureStatus: 'preparing', postureMessage: '', postureProgress: null })
  try {
    postureCh ??= openChannel('posture')
    const ch = await postureCh
    await sendMeshes(ch, cageParts(partsLite()).map((x) => x.id))
    if (job !== postureJob) return
    const id = ++seq
    useSoft.setState({ postureStatus: document.visibilityState === 'hidden' ? 'paused' : 'running' })
    const done = await new Promise<Reply>((resolve) => {
      ch.handlers.set(id, (r) => {
        if (job !== postureJob) {
          ch.handlers.delete(id)
          ch.worker.postMessage({ type: 'cancel', id })
          return resolve({ type: 'error', id, message: 'superseded' })
        }
        if (r.type === 'progress') {
          useSoft.setState({ postureProgress: { frames: r.frames, maxSpeed: r.maxSpeed ?? 0, msPerFrame: r.msPerFrame ?? 0, elapsedMs: r.elapsedMs } })
          return
        }
        ch.handlers.delete(id)
        resolve(r)
      })
      ch.worker.postMessage({ type: 'posture', id, posture: p })
    })
    if (job !== postureJob) return
    if (done.type === 'error') throw new Error(done.message)
    if (done.type !== 'posture-done') throw new Error('softbody worker: unexpected reply')
    useSoft.setState({ postureStatus: 'done', postureStats: done.stats, postureMessage: done.stats.converged ? '' : `${done.stats.frames} 帧内没有走到平衡（最大速度 ${done.stats.maxSpeed.toExponential(1)} m/s）/ did not reach equilibrium within ${done.stats.frames} frames` })
    showOffsets(done.offsets, new Map(done.parts.map((p) => [p.id, p.offsets])))
  } catch (err) {
    if (job !== postureJob) return
    useSoft.setState({ postureStatus: 'error', postureMessage: err instanceof Error ? err.message : String(err) })
  }
}

// 页面隐藏时体位的求解暂停，回来再继续 / the posture solve pauses while the page is hidden and resumes on return
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden'
    void postureCh?.then((c) => c.worker.postMessage({ type: 'pause', paused: hidden })).catch(() => {})
    const s = useSoft.getState()
    if (hidden && s.postureStatus === 'running') useSoft.setState({ postureStatus: 'paused' })
    else if (!hidden && s.postureStatus === 'paused') useSoft.setState({ postureStatus: 'running' })
  })
}

// ---------------------------------------------------------------- 地址参数 / URL parameters

/**
 * 加载时（人体加载之后、其他参数恢复之前）读 phys= 和 grav=，设好状态；返回要报告的警告。
 * At load (after the body is loaded, before the other parameters are restored) reads phys= and grav= and sets the
 * state; returns warnings to report.
 */
export function prepareSoftFromUrl(search: string): string[] {
  const q = new URLSearchParams(search)
  const phys = parsePhysParam(q.get('phys'))
  const warnings = phys.error ? [phys.error] : []
  if (!phys.on) return warnings
  const posture = parseGravParam(q.get('grav'))
  const patch: Partial<SoftState> = { physOn: true, posture }
  if (phys.press) {
    patch.pressOn = true
    patch.probe = phys.press.probe
    if ('forceN' in phys.press.target) Object.assign(patch, { control: 'force', forceN: phys.press.target.forceN })
    else Object.assign(patch, { control: 'depth', depthMm: phys.press.target.depthMm })
    patch.pressSite = phys.press.site
  }
  useSoft.setState(patch)
  return warnings
}

/**
 * 其他参数恢复之后：开始体位的求解，并在地址里没有 stim= 时施加 phys= 给的按压（嵌入时也是自己开始，没有对话框）。
 * After the other parameters: starts the posture solve, and applies the press phys= gives when the URL has no stim=
 * (also by itself in embed mode, with no dialog).
 */
export async function startSoftFromUrl(search: string, opts: { frame: boolean }): Promise<string[]> {
  const q = new URLSearchParams(search)
  const s = useSoft.getState()
  const warnings: string[] = []
  if (!s.physOn) return warnings
  const avail = softAvailable()
  if (!avail.ok) {
    useSoft.setState({ postureStatus: 'unavailable', pressStatus: 'unavailable', postureMessage: `${avail.reason!.zh} / ${avail.reason!.en}`, pressMessage: `${avail.reason!.zh} / ${avail.reason!.en}` })
    return [`phys: ${avail.reason!.zh} / ${avail.reason!.en}`]
  }
  if (s.posture !== 'standing') void runPosture(s.posture)
  if (s.pressOn && s.pressSite && !q.get('stim')) {
    const site = parseSite(s.pressSite)
    if (!site) return [`phys: 无法解析部位 "${s.pressSite}" / could not parse the site`]
    const settings = defaultSettings('pressure')
    useApp.setState({ stimSettings: settings })
    // 下一次取接触时让凹陷留着；不等它算完（要几秒到几十秒），其余参数照常恢复
    // the next contact keeps its dent; not awaited (it takes seconds to tens of seconds), the other parameters restore meanwhile
    fromLink = true
    if (!useApp.getState().embed) useApp.getState().setLeftTab('pain')
    void applyStimulus(site, { settings, frame: opts.frame }).then((ok) => {
      if (!ok) console.warn(`[soma] phys: ${useApp.getState().stimMessage || useSoft.getState().pressMessage || '无法施加 / could not be applied'}`)
    })
  }
  return warnings
}

/** 测试和验证用 / For tests and verification. */
export function softDebug(): { dentVertices: number; dentMaxMm: number; dentPhase: string; postureMaxMm: number; composed: boolean } {
  let pm = 0
  if (postureNow) for (let i = 0; i < postureNow.length; i += 3) pm = Math.max(pm, Math.hypot(postureNow[i]!, postureNow[i + 1]!, postureNow[i + 2]!))
  return { dentVertices: dent?.vertices.length ?? 0, dentMaxMm: dent ? sparseMaxMm(dent) : 0, dentPhase, postureMaxMm: pm * 1000, composed: !!composed }
}

if (typeof window !== 'undefined') (window as unknown as { __somaSoft?: unknown }).__somaSoft = { useSoft, softDebug, runPress }
