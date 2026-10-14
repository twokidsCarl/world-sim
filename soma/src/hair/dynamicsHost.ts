// 长发动力学在主线程一侧：选模拟发丝、算静止位置和碰撞球、开工作线程、把位移放进一张小数据纹理（宽 = 每根的点数，
// 高 = 模拟发丝数），并给着色器一个"按模拟发丝和根→梢位置取位移"的节点。发片和真发丝在蒙皮之前加上这个位移。
// The main-thread side of long-hair dynamics: picks the simulated strands, computes their rest positions and the
// collision spheres, starts the worker, puts the displacement into a small data texture (width = points per strand,
// height = simulated strands), and gives the shaders a node that "fetches the displacement by simulated strand and
// root → tip position". Cards and real strands add it before skinning.

import { DataTexture, FloatType, NearestFilter, RGBAFormat } from 'three/webgpu'
import { fract, int, ivec2, min, mix, textureLoad } from 'three/tsl'
import { DT, HairSim, JOINT_STRIDE, type SimInit, type SkinMode, collisionSpheres } from './dynamics.ts'
import type { SimReply, SimRequest } from './dynamicsWorker.ts'
import type { DecodedGuides } from './strands.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

/** 大约这么多根模拟发丝 / about this many simulated strands */
const SIM_STRANDS = 450

export class HairDynamics {
  readonly S: number
  readonly P: number
  readonly texture: DataTexture
  /** 每根引导发丝跟哪根模拟发丝 / which simulated strand each guide follows */
  readonly simOfGuide: Int32Array
  private readonly sims: number[]
  private readonly rootPos: Float32Array
  private worker: Worker | null = null
  private local: HairSim | null = null
  private ready = false
  private busy = false
  private moving = true
  private lastT = 0

  constructor(
    private readonly guides: DecodedGuides,
    skinPos: ArrayLike<number>,
    skinNormal: ArrayLike<number>,
    /** 皮肤顶点的主关节行 / a skin vertex's main joint row */
    rowOf: (v: number) => number,
    /** 新的位移到了 / a new displacement arrived */
    private readonly onUpdate: () => void,
  ) {
    const G = guides.info.guides
    this.P = guides.info.points
    const k = Math.max(1, Math.ceil(G / SIM_STRANDS))
    this.sims = []
    for (let g = 0; g < G; g += k) this.sims.push(g)
    this.S = this.sims.length
    this.rootPos = new Float32Array(G * 3)
    this.placeRoots(skinPos)
    // 每根引导发丝找根最近的模拟发丝 / each guide takes the simulated strand with the nearest root
    this.simOfGuide = new Int32Array(G)
    for (let g = 0; g < G; g++) this.simOfGuide[g] = this.nearest(this.rootPos[g * 3]!, this.rootPos[g * 3 + 1]!, this.rootPos[g * 3 + 2]!)
    this.texture = new DataTexture(new Float32Array(this.P * this.S * 4), this.P, this.S, RGBAFormat, FloatType)
    this.texture.minFilter = this.texture.magFilter = NearestFilter
    this.texture.generateMipmaps = false
    this.texture.needsUpdate = true
    const rest = this.restPositions()
    const rows = Int32Array.from(this.sims, (g) => rowOf(this.dominant(g)))
    const sp = collisionSpheres(skinPos, skinNormal, rowOf, rest)
    this.keyRows = [...new Set([...rows, ...sp.row])]
    const init: SimInit = { points: this.P, rest, rows, sphereCentre: sp.centre, sphereRadius: sp.radius, sphereRow: sp.row }
    this.start(init)
  }

  /** 根最近的模拟发丝 / the simulated strand whose root is nearest */
  nearest(x: number, y: number, z: number): number {
    let best = 0, bd = Infinity
    this.sims.forEach((g, s) => {
      const d = (this.rootPos[g * 3]! - x) ** 2 + (this.rootPos[g * 3 + 1]! - y) ** 2 + (this.rootPos[g * 3 + 2]! - z) ** 2
      if (d < bd) (bd = d), (best = s)
    })
    return best
  }

  private dominant(g: number): number {
    const w = this.guides.rootBary
    let best = 0
    for (let k = 1; k < 3; k++) if (w[g * 3 + k]! > w[g * 3 + best]!) best = k
    return this.guides.rootVerts[g * 3 + best]!
  }

  private placeRoots(skin: ArrayLike<number>): void {
    const d = this.guides
    for (let g = 0; g < d.info.guides; g++) {
      for (let c = 0; c < 3; c++) {
        let v = 0
        for (let k = 0; k < 3; k++) v += skin[d.rootVerts[g * 3 + k]! * 3 + c]! * d.rootBary[g * 3 + k]!
        this.rootPos[g * 3 + c] = v
      }
    }
  }

  private restPositions(): Float32Array {
    const { P } = this
    const out = new Float32Array(this.S * P * 3)
    this.sims.forEach((g, s) => {
      for (let k = 0; k < P; k++) for (let c = 0; c < 3; c++) out[(s * P + k) * 3 + c] = this.rootPos[g * 3 + c]! + this.guides.offset[(g * P + k) * 3 + c]!
    })
    return out
  }

  private start(init: SimInit): void {
    const reply = (m: SimReply): void => {
      if (m.type === 'ready') {
        this.ready = true
        this.moving = true
      } else {
        this.busy = false
        this.moving = m.moving
        const data = this.texture.image.data as Float32Array
        for (let i = 0; i < this.S * this.P; i++) {
          data[i * 4] = m.disp[i * 3]!
          data[i * 4 + 1] = m.disp[i * 3 + 1]!
          data[i * 4 + 2] = m.disp[i * 3 + 2]!
        }
        this.texture.needsUpdate = true
        this.onUpdate()
      }
    }
    if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./dynamicsWorker.ts', import.meta.url), { type: 'module' })
        this.worker.onmessage = (ev: MessageEvent<SimReply>) => reply(ev.data)
        this.worker.postMessage({ type: 'init', init } satisfies SimRequest)
        return
      } catch {
        this.worker = null
      }
    }
    // 没有工作线程（测试环境）：在主线程算 / no worker (tests): compute on the main thread
    this.local = new HairSim(init)
    this.local.warm()
    this.ready = true
    this.reply = reply
  }

  private reply: ((m: SimReply) => void) | null = null

  /** 皮肤的静止位置变了 / the skin's rest positions changed */
  setRest(skinPos: ArrayLike<number>): void {
    this.placeRoots(skinPos)
    const rest = this.restPositions()
    if (this.worker) this.worker.postMessage({ type: 'rest', rest } satisfies SimRequest, [rest.buffer])
    else this.local?.setRest(rest)
    this.moving = true
  }

  /**
   * 每帧调一次：头动了或发丝还没停，就推进与这一帧经过的时间相当的步数（1–3 步）。
   * Called once per frame: if the head moved or the strands have not stopped, advance as many steps as the elapsed time
   * amounts to (1–3).
   */
  tick(t: number, joints: Float32Array | null, mode: SkinMode): void {
    // 用到的关节行没变，就当头没动 / unchanged joint rows in use count as a still head
    let headKey = mode
    if (joints && mode !== 'off') for (const r of this.keyRows) for (let j = 0; j < 8; j++) headKey += `${(joints[r * JOINT_STRIDE + j] ?? 0).toFixed(4)},`
    const elapsed = this.lastT ? t - this.lastT : DT * 1000
    this.lastT = t
    if (!this.ready || this.busy) return
    if (headKey !== this.lastKey) {
      this.lastKey = headKey
      this.moving = true
    }
    if (!this.moving) return
    const steps = Math.min(3, Math.max(1, Math.round(elapsed / (DT * 1000))))
    const j = joints ? joints.slice() : null
    if (this.worker) {
      this.busy = true
      this.worker.postMessage({ type: 'step', joints: j, mode, steps } satisfies SimRequest, j ? [j.buffer] : [])
    } else if (this.local) {
      const moving = this.local.step(j, mode, steps)
      this.reply?.({ type: 'disp', disp: this.local.displacement, moving })
    }
  }

  private lastKey = ''
  private keyRows: number[] = []

  /** 着色器节点：按 `simIndex`（模拟发丝下标）和 `along`（0 根 … 1 梢）取位移 / shader node: the displacement by `simIndex` (simulated strand index) and `along` (0 root … 1 tip) */
  node(along: N, simIndex: N): N {
    const sim: N = int(simIndex)
    const x: N = along.clamp(0, 1).mul(this.P - 1)
    const c0: N = int(x)
    const c1: N = (min as N)(c0.add(1), int(this.P - 1))
    const a: N = textureLoad(this.texture, (ivec2 as N)(c0, sim)).xyz
    const b: N = textureLoad(this.texture, (ivec2 as N)(c1, sim)).xyz
    return mix(a, b, fract(x as N))
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    this.texture.dispose()
  }
}
