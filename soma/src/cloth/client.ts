// 布料模拟在主线程这一侧：worker 的生命周期、什么时候推进一帧、把结果写进各件衣服的预览层。
// 视图每帧调 frame()：姿势变了、或衣服还在动，就请 worker 推进一帧（一次只有一帧在路上）；都停了就不再发，
// 视图也就不必重画。页面隐藏时视图的循环停下，这里自然也停。
// The main-thread side of the cloth simulation: the worker's life cycle, when to advance a frame, and writing the
// results into each garment's preview layer. The viewer calls frame() every tick: when the pose changed or the cloth
// is still moving, the worker is asked for one frame (only one frame is in flight at a time); when everything is
// still nothing is sent and the viewer need not redraw. While the page is hidden the viewer's loop stops, and so does
// this.

import type { Pose, Scales } from '../../tools/rig/pose.ts'
import type { LoadedRig } from '../anatomy/rig.ts'
import type { GarmentId } from './garments.ts'
import type { ClothLayer } from './layer.ts'
import type { BodyMsg, Reply, Request } from './protocol.ts'

/**
 * 速度超过 2 cm/s 的顶点不到这个比例、连续这么多帧，就算停了（夹在皮肤褶里的个别顶点会一直抖，不按最大值算）。
 * The cloth counts as still once fewer than this share of its vertices move faster than 2 cm/s for this many frames
 * (a few vertices caught in a fold of skin keep trembling, so the maximum is not used).
 */
const STILL_SHARE = 0.01
const STILL_FRAMES = 12
/**
 * 姿势不变以后最多再算这么多帧（4 秒）：深蹲时夹在两层皮和两层布之间的少数顶点会一直抖，不能让 worker 因此一直转。
 * At most this many frames (4 s) once the pose stops changing: in a deep squat a few vertices caught between two layers
 * of skin and cloth keep trembling, and the worker must not keep running because of them.
 */
const MAX_SETTLE_FRAMES = 240

export interface ClothStats {
  frames: number
  /** worker 里每帧的用时（毫秒，最近 60 帧的平均）/ worker time per frame (ms, mean of the last 60). */
  workerMs: number
  poseMs: number
  /** 主线程收结果、写缓冲的用时 / main-thread time to take a result and write the buffers. */
  mainMs: number
  maxSpeed: number
  settled: boolean
  /** 皮肤静止位置变了几次（每次衣服按绑定重新放好）/ how many times the skin's rest positions changed (each time the garments are put back by their binding) */
  rests: number
  /** 做反向检查的皮肤顶点数 / the number of skin vertices given the reverse check */
  guard: number
}

export class ClothSim {
  private readonly worker: Worker
  private seq = 0
  private inflight = false
  private pending: { pose: Pose; scales: Scales | null } | null = null
  private quiet = 0
  /** 上次姿势变化以来算了几帧 / frames computed since the last pose change */
  private since = 0
  private layers = new Map<GarmentId, ClothLayer>()
  private readonly times: number[] = []
  private readonly poseTimes: number[] = []
  private applied = false
  readonly stats: ClothStats = { frames: 0, workerMs: 0, poseMs: 0, mainMs: 0, maxSpeed: 0, settled: false, rests: 0, guard: 0 }

  /** init 发出之前的消息先排队 / messages wait in line until init has gone */
  private queue: Request[] | null = []
  private ready = false

  /** `clothUrl`：这副人体衣服数据的目录（读 index.json 里要做反向检查的皮肤顶点）/ `clothUrl`: this body's garment directory (index.json names the skin vertices given the reverse check). */
  constructor(rig: LoadedRig, skinId: string, rest: Float32Array, index: Uint32Array, pose: Pose, scales: Scales | null, clothUrl: string) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (ev: MessageEvent<Reply>) => this.receive(ev.data)
    const b = rig.bindingOf.get(skinId)
    const n = rest.length / 3
    const off = b?.offset ?? 0
    const body: BodyMsg = { joints: rig.rig.joints, skinBin: rig.bin.slice(off, off + n * 12), index, rest: Float32Array.from(rest) }
    this.pending = { pose, scales }
    void fetch(`${clothUrl}index.json`)
      .then((r) => (r.ok ? (r.json() as Promise<{ guard?: { vertices?: number[] } }>) : null))
      .catch(() => null)
      .then((idx) => {
        const g = idx?.guard?.vertices
        if (g?.length && g.every((v) => v < n)) body.guard = Uint32Array.from(g)
        this.stats.guard = body.guard?.length ?? 0
        this.worker.postMessage({ type: 'init', body } satisfies Request)
        for (const m of this.queue ?? []) this.worker.postMessage(m)
        this.queue = null
      })
  }

  private post(m: Request): void {
    if (this.queue) this.queue.push(m)
    else this.worker.postMessage(m)
  }

  /** 穿着的衣服变了 / The garments worn changed. */
  setLayers(layers: ClothLayer[]): void {
    this.layers = new Map(layers.map((l) => [l.cloth.data.garment, l]))
    this.post({ type: 'wear', garments: layers.map((l) => l.cloth) })
    this.quiet = 0
    this.since = 0
  }

  /** 皮肤的静止位置变了（体型）/ The skin's rest positions changed (shape). */
  setRest(rest: Float32Array): void {
    this.stats.rests++
    this.post({ type: 'rest', rest: Float32Array.from(rest) })
    this.quiet = 0
    this.since = 0
  }

  /** 显示的姿势变了 / The displayed pose changed. */
  pose(pose: Pose, scales: Scales | null): void {
    this.pending = { pose, scales }
    this.quiet = 0
  }

  /** 每帧调用；有新结果写进了衣服时返回 true（要重画）/ Called every tick; true when a new result was written into the garments (a redraw is due). */
  frame(): boolean {
    const was = this.applied
    this.applied = false
    if (this.ready && !this.inflight && (this.pending || (this.quiet < STILL_FRAMES && this.since < MAX_SETTLE_FRAMES))) {
      this.since = this.pending ? 0 : this.since + 1
      const m: Request = this.pending ? { type: 'step', seq: this.seq++, pose: this.pending } : { type: 'step', seq: this.seq++ }
      this.pending = null
      this.inflight = true
      this.post(m)
    }
    this.stats.settled = !this.inflight && !this.pending && (this.quiet >= STILL_FRAMES || this.since >= MAX_SETTLE_FRAMES)
    return was
  }

  private receive(r: Reply): void {
    if (r.type === 'error') {
      console.warn('[soma] cloth worker:', r.message)
      this.inflight = false
      return
    }
    if (r.type === 'ready') this.ready = true
    if (r.type !== 'frame') return
    this.inflight = false
    const t0 = performance.now()
    for (const g of r.garments) this.layers.get(g.id)?.setSimulated(g.positions, g.normals)
    this.applied = true
    this.quiet = r.movingShare < STILL_SHARE && !r.behind ? this.quiet + 1 : 0
    // 还在追赶姿势时不算进"姿势不变以后"的帧数 / frames still catching up with the pose do not count as frames after the pose stopped changing
    if (r.behind) this.since = 0
    const s = this.stats
    s.frames++
    s.maxSpeed = r.maxSpeed
    this.times.push(r.poseMs + r.solveMs)
    this.poseTimes.push(r.poseMs)
    if (this.times.length > 60) {
      this.times.shift()
      this.poseTimes.shift()
    }
    s.workerMs = this.times.reduce((a, b) => a + b, 0) / this.times.length
    s.poseMs = this.poseTimes.reduce((a, b) => a + b, 0) / this.poseTimes.length
    s.mainMs = s.mainMs * 0.9 + (performance.now() - t0) * 0.1
  }

  dispose(): void {
    this.worker.terminate()
    for (const l of this.layers.values()) l.setSimulated(null, null)
  }
}
