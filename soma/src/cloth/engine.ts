// 运行时的布料模拟（不碰 DOM，worker 和测试共用）：几件穿着的衣服、按姿势摆好的皮肤、逐帧推进。
// 一帧 = 1/60 秒、10 个子步；皮肤在帧内从上一个姿势线性过渡到这一个，衣服被它推着、带着走。下装先算，
// 上衣把下装占去的厚度当作皮肤外多出来的距离（叠穿）。同样的输入序列得到逐位相同的结果。
// The runtime cloth simulation (no DOM; shared by the worker and the tests): the garments worn, the skin posed by the
// rig, advanced frame by frame. One frame = 1/60 s in 10 substeps; within a frame the skin moves linearly from the
// previous pose to this one and pushes and carries the cloth. Bottoms are solved first, and a top treats the
// thickness a bottom takes up as extra distance outside the skin (layering). The same input sequence gives
// bit-identical results.

import { Poser, type Pose, type Scales } from '../../tools/rig/pose.ts'
import { xfFromDq } from '../../tools/rig/math.ts'
import type { Joint, Rig } from '../anatomy/types.ts'
import { bindingPosition, geodesicToAnchors } from './attach.ts'
import type { GarmentId } from './garments.ts'
import type { LoadedCloth } from './load.ts'
import { ClothSolver } from './solver.ts'
import { LayerCollider, SkinFrame, TrackingCollider } from './tracking.ts'
import { KdopCollider, SkinVertexCollider } from './collider.ts'

/** 三维长度（比 Math.hypot 快得多，热循环里用）/ A 3-D length (much faster than Math.hypot; used in hot loops). */
function len3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z)
}

export const FRAME_DT = 1 / 60
export const SUBSTEPS = 8
/** 一段里皮肤最多走多远（米），以及一帧最多分几段 / How far the skin may move within one piece (metres), and the most pieces in a frame. */
const PIECE_REACH = 0.015
const MAX_PIECES = 4
/** 与皮肤保持的距离（米）/ Distance kept from the skin (metres). */
const MARGIN = 0.002
/** 上衣：穿在下装外面 / Tops: worn over the bottoms. */
const TOPS: ReadonlySet<GarmentId> = new Set(['tee', 'compression-top', 'sports-bra'])

export interface EngineBody {
  joints: Joint[]
  /** 皮肤顶点的蒙皮影响（rig.bin 里皮肤那一段，每顶点 12 字节）/ The skin vertices' influences (the skin's slice of rig.bin, 12 bytes a vertex). */
  skinBin: Uint8Array
  /** 皮肤的全部三角形 / All of the skin's triangles. */
  index: Uint32Array
  /** 皮肤的静止位置（含体型、表情）/ The skin's rest positions (shape and expression included). */
  rest: Float32Array
  /**
   * 要做反向检查的皮肤顶点（外生殖器这样细小的突起：顶点碰撞拦不住它们从布的顶点之间钻出来）；可省略。
   * Skin vertices given the reverse check (small protrusions such as the external genitalia, which vertex collisions
   * cannot stop from slipping out between cloth vertices); optional.
   */
  guard?: Uint32Array
}

export interface FrameResult {
  /** 衣服顶点这一帧的最大速度（m/s）/ The largest speed of any garment vertex this frame (m/s). */
  maxSpeed: number
  /** 速度超过 2 cm/s 的顶点占的比例 / The share of vertices moving faster than 2 cm/s. */
  movingShare: number
  /** 计算用时（毫秒）：摆皮肤、解算 / Compute time (ms): posing the skin, solving. */
  poseMs: number
  solveMs: number
  /**
   * 姿势一帧跳得太远，这一帧只走了一部分，还没到要的姿势（下一帧接着走，不带姿势也会继续）
   * The pose jumped too far for one frame: this frame went part of the way and has not reached the pose asked for yet
   * (the next frame carries on, with or without a pose).
   */
  behind: boolean
}

interface Sim {
  id: GarmentId
  cloth: LoadedCloth
  top: boolean
  solver: ClothSolver
  collider: TrackingCollider
  attached: Uint32Array
  last: Float64Array
  normals: Float32Array
  /** 每个布顶点借用蒙皮影响的那个皮肤顶点 / The skin vertex whose skinning influences each cloth vertex borrows. */
  dominant: Uint32Array
  /** 上衣：挡在下装外面 / tops: kept outside the bottoms */
  layer: LayerCollider | null
  /** 外生殖器这类细小突起的反向检查（每帧一次，只看它附近的布）/ the reverse check for small protrusions such as the external genitalia (once a frame, nearby cloth only) */
  guard: SkinVertexCollider | null
  /** 原顶点 → 焊好的顶点；焊好的顶点 → 一个原顶点（取它的绑定）；焊好的三角形 / original vertex → welded vertex; welded vertex → one original vertex (whose binding it takes); the welded triangles */
  map: Int32Array
  rep: Int32Array
  triangles: Uint32Array
  /** 到绑在皮肤上的顶点（腰头、肩缝）的裁片测地距离（米）/ Pattern geodesic distance to the bound vertices (waistband, shoulder seams), metres. */
  anchorDist: Float64Array
}

/** 一件衣服送回主线程的一帧 / One garment's frame for the main thread. */
export interface GarmentOut {
  id: GarmentId
  /**
   * 静止空间里的位置和法线：用借来的那个皮肤顶点在这一帧姿势下的蒙皮变换的逆变换回去。GPU 再用当前显示的姿势蒙皮，
   * 两者相同时得到模拟结果本身；模拟落后于显示时，衣服先被身体带着走。
   * Positions and normals in rest space: taken back by the inverse of the borrowed skin vertex's skinning transform at
   * this frame's pose. The GPU then skins them with the pose on display; when the two agree the result is the
   * simulation itself, and while the simulation lags the display the garment is first carried along by the body.
   */
  positions: Float32Array
  normals: Float32Array
}

export class ClothEngine {
  private readonly rig: Rig
  private rest: Float32Array
  private pose: Pose = {}
  private scales: Scales | undefined
  /** 还没走到的姿势（见 FrameResult.behind）/ the pose not reached yet (see FrameResult.behind) */
  private target: { pose: Pose; scales: Scales | undefined } | null = null
  private poser!: Poser
  private posed: Float32Array
  readonly skin: SkinFrame
  private sims: Sim[] = []
  private readonly lerp: Float64Array

  constructor(private readonly body: EngineBody) {
    this.rig = { joints: body.joints, bindings: [{ part: 'skin', offset: 0, vertexCount: body.rest.length / 3 }], muscles: [], cautions: [] }
    this.rest = Float32Array.from(body.rest)
    this.posed = this.poseSkin()
    this.skin = new SkinFrame(this.posed, canonicalTriangles(body.index))
    this.lerp = new Float64Array(this.posed.length)
  }

  private poseSkin(): Float32Array {
    this.poser = new Poser(this.rig, this.body.skinBin, this.pose, this.scales)
    return this.poser.part('skin', this.rest, 'dqs', false)
  }

  /** 静止的皮肤变了（体型）：重摆皮肤，衣服按绑定重新放好 / The rest skin changed (shape): re-pose it and put the garments back by their binding. */
  setRest(rest: Float32Array): void {
    this.rest = Float32Array.from(rest)
    this.posed = this.poseSkin()
    this.skin.moveTo(this.posed)
    this.skin.moveTo(this.posed)
    this.skin.computeNormals()
    for (const s of this.sims) this.place(s)
  }

  /** 换衣服：新穿上的按绑定放到当前姿势的皮肤上；顺序为下装在前 / Change garments: new ones are put on the current posed skin by their binding; bottoms first. */
  setGarments(cloths: LoadedCloth[]): void {
    const keep = new Map(this.sims.map((s) => [s.cloth, s]))
    const next: Sim[] = []
    for (const c of cloths) next.push(keep.get(c) ?? this.create(c))
    next.sort((a, b) => Number(a.top) - Number(b.top))
    this.sims = next
  }

  /** 每件衣服这一帧的结果（静止空间，见 GarmentOut）/ Every garment's result for this frame (rest space, see GarmentOut). */
  garments(): GarmentOut[] {
    const bin = this.body.skinBin
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
    const dqs = this.poser.dqs, shape = this.poser.shape
    const b = [0, 0, 0, 0, 0, 0, 0, 0]
    return this.sims.map((s) => {
      const n = s.solver.n, x = s.solver.x, N = s.normals
      const P = new Float32Array(n * 3), Q = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        const o = s.dominant[i]! * 12
        // 对偶四元数混合（与 tools/rig/pose.ts 的 skin 相同）/ dual-quaternion blend (as skin in tools/rig/pose.ts)
        b.fill(0)
        let first: number[] | null = null
        for (let k = 0; k < 4; k++) {
          const w = bin[o + 8 + k]!
          if (w === 0) continue
          const q = dqs[dv.getUint16(o + k * 2, true)]!
          if (!first) first = q
          const sg = (q[0] * first[0]! + q[1] * first[1]! + q[2] * first[2]! + q[3] * first[3]! < 0 ? -w : w) / 255
          for (let c = 0; c < 8; c++) b[c] = b[c]! + sg * q[c]!
        }
        const m = xfFromDq(b)
        const r = m.r
        // 刚体部分的逆：Rᵀ(p − t) / the rigid part's inverse: Rᵀ(p − t)
        const px = x[i * 3]! - m.t[0], py = x[i * 3 + 1]! - m.t[1], pz = x[i * 3 + 2]! - m.t[2]
        let qx = r[0] * px + r[3] * py + r[6] * pz, qy = r[1] * px + r[4] * py + r[7] * pz, qz = r[2] * px + r[5] * py + r[8] * pz
        const nx = N[i * 3]!, ny = N[i * 3 + 1]!, nz = N[i * 3 + 2]!
        let mx = r[0] * nx + r[3] * ny + r[6] * nz, my = r[1] * nx + r[4] * ny + r[7] * nz, mz = r[2] * nx + r[5] * ny + r[8] * nz
        if (shape) {
          // 体型部分：静止空间里按权重混合的仿射变换 A·p + a，求逆 / the shape part: the weight-blended affine A·p + a in rest space, inverted
          const A = [0, 0, 0, 0, 0, 0, 0, 0, 0], a = [0, 0, 0]
          for (let k = 0; k < 4; k++) {
            const w = bin[o + 8 + k]!
            if (w === 0) continue
            const sm = shape[dv.getUint16(o + k * 2, true)]!
            for (let c = 0; c < 9; c++) A[c] = A[c]! + (w / 255) * sm.r[c]!
            for (let c = 0; c < 3; c++) a[c] = a[c]! + (w / 255) * sm.t[c]!
          }
          const inv = invert3(A)
          const ux = qx - a[0]!, uy = qy - a[1]!, uz = qz - a[2]!
          qx = inv[0]! * ux + inv[1]! * uy + inv[2]! * uz
          qy = inv[3]! * ux + inv[4]! * uy + inv[5]! * uz
          qz = inv[6]! * ux + inv[7]! * uy + inv[8]! * uz
          // 法线按 A 的转置变换（逆变换的逆转置）/ normals transform by Aᵀ (the inverse transpose of the inverse)
          const tx = A[0]! * mx + A[3]! * my + A[6]! * mz, ty = A[1]! * mx + A[4]! * my + A[7]! * mz, tz = A[2]! * mx + A[5]! * my + A[8]! * mz
          const l = len3(tx, ty, tz) || 1
          mx = tx / l
          my = ty / l
          mz = tz / l
        }
        P[i * 3] = qx
        P[i * 3 + 1] = qy
        P[i * 3 + 2] = qz
        Q[i * 3] = mx
        Q[i * 3 + 1] = my
        Q[i * 3 + 2] = mz
      }
      // 展开回原来的顶点（缝线两边各一份）/ expanded back to the original vertices (one copy on each side of a seam)
      const n0 = s.map.length
      const P0 = new Float32Array(n0 * 3), Q0 = new Float32Array(n0 * 3)
      for (let v = 0; v < n0; v++) {
        const i = s.map[v]! * 3
        P0[v * 3] = P[i]!
        P0[v * 3 + 1] = P[i + 1]!
        P0[v * 3 + 2] = P[i + 2]!
        Q0[v * 3] = Q[i]!
        Q0[v * 3 + 1] = Q[i + 1]!
        Q0[v * 3 + 2] = Q[i + 2]!
      }
      return { id: s.id, positions: P0, normals: Q0 }
    })
  }

  /** 检查用：世界坐标里的位置 / For checks: positions in world space. */
  worldPositions(id: GarmentId): Float64Array | null {
    return this.sims.find((s) => s.id === id)?.solver.x ?? null
  }

  private create(cloth: LoadedCloth): Sim {
    const n0 = cloth.data.vertexCount
    // 缝线两边焊成一个顶点：缝在一起的本来就是同一点，焊起来以后缝上没有缝隙可钻，弯曲也跨过缝线
    // the two sides of every seam are welded into one vertex: stitched vertices are one point anyway, and once welded the
    // seam has no gap to slip through and bending carries across it
    const parent = Int32Array.from({ length: n0 }, (_, i) => i)
    const find = (v: number): number => {
      while (parent[v] !== v) v = parent[v] = parent[parent[v]!]!
      return v
    }
    for (let k = 0; k < cloth.stitch.length; k += 2) {
      const p = find(cloth.stitch[k]!), q = find(cloth.stitch[k + 1]!)
      if (p !== q) parent[Math.max(p, q)] = Math.min(p, q)
    }
    const map = new Int32Array(n0)
    const reps: number[] = []
    for (let v = 0; v < n0; v++) {
      const r = find(v)
      if (r === v) {
        map[v] = reps.length
        reps.push(v)
      } else map[v] = map[r]!
    }
    const rep = Int32Array.from(reps)
    const n = rep.length
    const tris: number[] = [], cuv: number[] = []
    const T0 = cloth.index
    for (let t = 0; t < T0.length; t += 3) {
      const a = map[T0[t]!]!, b = map[T0[t + 1]!]!, c = map[T0[t + 2]!]!
      if (a === b || b === c || a === c) continue
      tris.push(a, b, c)
      for (let k = 0; k < 3; k++) cuv.push(cloth.uv[T0[t + k]! * 2]!, cloth.uv[T0[t + k]! * 2 + 1]!)
    }
    const pos = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) pos[i * 3 + k] = cloth.position[rep[i]! * 3 + k]!
    const triangles = Uint32Array.from(tris)
    const solver = new ClothSolver({ positions: pos, uv: new Float64Array(n * 2), cornerUv: cuv, triangles, fabric: cloth.data.fabric })
    solver.collisionMargin = MARGIN
    const attachedOrig: number[] = []
    for (let i = 0; i < cloth.attach.length; i++) if (cloth.attach[i]) attachedOrig.push(i)
    // 有袖的上衣在数据里没绑：运行时把肩缝（前后躯干片之间、离最高点 10 cm 以内的缝）绑到皮肤上，衣服挂在肩上，
    // 少几个子步也不会滑下去
    // a top with sleeves is not bound in the data: at run time its shoulder seams (the seams between front and back
    // torso panels within 10 cm of its highest point) are bound to the skin, so it hangs from the shoulders and does
    // not slide off with fewer substeps
    if (!attachedOrig.length && TOPS.has(cloth.data.garment)) {
      let top = -Infinity
      for (let i = 1; i < cloth.position.length; i += 3) top = Math.max(top, cloth.position[i]!)
      const panels = cloth.data.panels
      const torso = (v: number): boolean => panels[cloth.panel[v]!]!.name.includes('torso')
      for (let k = 0; k < cloth.stitch.length; k += 2) {
        const a = cloth.stitch[k]!, b = cloth.stitch[k + 1]!
        if (!torso(a) || !torso(b) || panels[cloth.panel[a]!]!.front === panels[cloth.panel[b]!]!.front) continue
        if (cloth.position[a * 3 + 1]! < top - 0.1 || cloth.position[b * 3 + 1]! < top - 0.1) continue
        attachedOrig.push(a, b)
      }
    }
    const attached = [...new Set(attachedOrig.map((v) => map[v]!))].sort((p, q) => p - q)
    for (const v of attached) solver.w[v] = 0
    const anchorDist = new Float64Array(n).fill(Infinity)
    // 长程附着留的余量：机织布几乎不伸长；弹力针织要能绷过弯起来的膝、肘，余量大得多
    // the slack left in the long-range attachments: woven cloth hardly stretches; an elastane knit must stretch over a
    // bent knee or elbow, so it gets far more
    const slack = Math.min(cloth.data.fabric.stretchWarp, cloth.data.fabric.stretchWeft) < 1000 ? 1.6 : 1.1
    if (attached.length) {
      const g = geodesicToAnchors(n, triangles, pos, [], attached, 3)
      anchorDist.set(g.dist)
      const tv: number[] = [], ta: number[] = [], tl: number[] = []
      for (let i = 0; i < n; i++) {
        if (solver.w[i] === 0 || g.anchor[i]! < 0) continue
        tv.push(i)
        ta.push(g.anchor[i]!)
        tl.push(g.dist[i]! * slack)
      }
      solver.setTethers(tv, ta, tl)
    }
    const collider = new TrackingCollider(this.skin, n)
    solver.colliders.push(collider)
    const dominant = new Uint32Array(n)
    for (let i = 0; i < n; i++) {
      const o = rep[i]!
      const b1 = cloth.bindBary[o * 2]!, b2 = cloth.bindBary[o * 2 + 1]!, b0 = 1 - b1 - b2
      dominant[i] = cloth.bindVert[o * 3 + (b0 >= b1 && b0 >= b2 ? 0 : b1 >= b2 ? 1 : 2)]!
    }
    const s: Sim = { id: cloth.data.garment, cloth, top: TOPS.has(cloth.data.garment), solver, collider, attached: Uint32Array.from(attached), last: new Float64Array(n * 3), normals: new Float32Array(n * 3), dominant, anchorDist, layer: null, map, rep, triangles, guard: null }
    if (this.body.guard?.length) {
      s.guard = new SkinVertexCollider(triangles, this.skin, solver.x)
      s.guard.only = Int32Array.from(this.body.guard, (v) => v * 3)
      s.guard.every = 1
      s.guard.carry = solver.prev
      s.guard.maxShift = 0.01
      if (!this.bulgeVerts) this.bulgeVerts = this.frontOf(this.body.guard)
      solver.colliders.push(this.bulge)
      // 外生殖器上布要离得远一些（多 6 mm）：两个布顶点之间的三角形才不会切进这块小而凸的皮肤
      // cloth keeps further off the external genitalia (6 mm more), so the triangles between two cloth vertices do not
      // cut into this small, convex stretch of skin
      collider.extra = this.guardExtra()
    }
    if (s.top) {
      s.layer = new LayerCollider()
      solver.colliders.push(s.layer)
    }
    this.place(s)
    return s
  }

  /** 按绑定把衣服放到当前姿势的皮肤上，速度清零 / Put a garment on the current posed skin by its binding, velocities zeroed. */
  private place(s: Sim): void {
    const c = s.cloth, x = s.solver.x
    for (let i = 0; i < s.solver.n; i++) {
      const o = s.rep[i]!
      bindingPosition(this.posed, c.bindVert, o, c.bindBary[o * 2]!, c.bindBary[o * 2 + 1]!, c.bindOffset[o]!, x, i * 3)
      s.collider.tri[i] = this.skin.triangleOf(c.bindVert[o * 3]!, c.bindVert[o * 3 + 1]!, c.bindVert[o * 3 + 2]!)
    }
    s.solver.prev.set(x)
    s.solver.v.fill(0)
    s.last.set(x)
    this.normalsOf(s)
  }

  /**
   * 推进一帧；`pose` 给了就是这一帧要到达的姿势（含体型缩放），没给就是姿势不变。
   * Advance one frame; `pose`, when given, is the pose (with shape scales) this frame reaches; absent, the pose is unchanged.
   */
  step(pose?: { pose: Pose; scales: Scales | null }): FrameResult {
    const t0 = performance.now()
    const fromPose = this.pose
    let from = this.posed
    if (pose) this.target = { pose: pose.pose, scales: pose.scales ?? undefined }
    let behind = false
    if (this.target) {
      const tgt = this.target
      this.pose = tgt.pose
      this.scales = tgt.scales
      this.posed = this.poseSkin()
      // 一帧最多走 MAX_PIECES 段；更远的（worker 慢的那一帧里显示已经走完了大半个动作）分几帧走完，
      // 否则每段走得太远，膝盖会从裤管里穿出去。输出在静止空间，按显示的姿势蒙皮，所以落后的几帧看上去仍贴着身体
      // at most MAX_PIECES pieces a frame; a longer jump (the display has done most of a motion during one slow worker
      // frame) is spread over several frames, or each piece would go too far and knees would come out through the
      // trouser legs. The output is in rest space and skinned with the displayed pose, so the frames behind still look
      // fitted to the body
      let d2 = 0
      for (let i = 0; i < from.length; i += 3) {
        const dx = this.posed[i]! - from[i]!, dy = this.posed[i + 1]! - from[i + 1]!, dz = this.posed[i + 2]! - from[i + 2]!
        d2 = Math.max(d2, dx * dx + dy * dy + dz * dz)
      }
      const need = Math.ceil(Math.sqrt(d2) / PIECE_REACH)
      if (need > MAX_PIECES) {
        this.pose = lerpPose(fromPose, tgt.pose, MAX_PIECES / need)
        this.posed = this.poseSkin()
        behind = true
      } else this.target = null
    }
    const to = this.posed
    const moving = from !== to
    // 姿势跳得远（worker 赶不上显示时，两帧之间隔着好几帧的动作）：按关节角分成几段，每段重摆一次皮肤
    // （位置直接线性插值会让转动的肢体在中途塌进身体，腿就从裤管里穿过去了）；每段 SUBSTEPS 个子步，相当于这段动作用了更长的时间
    // when the pose jumps far (the worker cannot keep up with the display, so several display frames of motion lie
    // between two of its frames) the motion is split into pieces by joint angle and the skin re-posed for each (linear
    // interpolation of positions would fold a turning limb into the body halfway and legs would pass through trouser
    // legs); each piece gets SUBSTEPS substeps, as if the motion took longer
    const ends: Float32Array[] = []
    if (moving) {
      let d2 = 0
      for (let i = 0; i < to.length; i += 3) {
        const dx = to[i]! - from[i]!, dy = to[i + 1]! - from[i + 1]!, dz = to[i + 2]! - from[i + 2]!
        const e = dx * dx + dy * dy + dz * dz
        if (e > d2) d2 = e
      }
      const pieces = Math.min(MAX_PIECES, Math.max(1, Math.ceil(Math.sqrt(d2) / PIECE_REACH)))
      for (let m = 1; m < pieces; m++) {
        this.poser = new Poser(this.rig, this.body.skinBin, lerpPose(fromPose, this.pose, m / pieces), this.scales)
        ends.push(this.poser.part('skin', this.rest, 'dqs', false))
      }
      if (pieces > 1) this.poser = new Poser(this.rig, this.body.skinBin, this.pose, this.scales)
      ends.push(to)
    } else ends.push(to)
    const t1 = performance.now()
    this.layerBottoms()
    this.guardBox(to)
    const h = FRAME_DT / SUBSTEPS
    const opt = { gravity: [0, -9.81, 0] as [number, number, number], substeps: 1, damping: 3, maxSpeed: 2 }
    for (const end of ends) {
      if (moving) {
        this.skin.computeNormals(end)
        // 顶点哈希按这一段的终点建（只用来重新找最近三角形）/ the vertex hash is built at this piece's end pose (only used to re-acquire nearest triangles)
        const keep = Float64Array.from(this.skin.pos)
        this.skin.pos.set(end)
        this.skin.buildHash()
        this.skin.pos.set(keep)
      }
      for (let k = 1; k <= SUBSTEPS; k++) {
        if (moving) {
          const f = k / SUBSTEPS
          for (let i = 0; i < end.length; i++) this.lerp[i] = from[i]! + (end[i]! - from[i]!) * f
          this.skin.moveTo(this.lerp)
        } else if (k === 1) this.skin.moveTo(this.skin.pos)
        for (const s of this.sims) {
          const c = s.cloth
          for (const v of s.attached) {
            const o = s.rep[v]!
            bindingPosition(this.skin.pos, c.bindVert, o, c.bindBary[o * 2]!, c.bindBary[o * 2 + 1]!, c.bindOffset[o]!, s.solver.x, v * 3)
          }
          // 远离皮肤的顶点每 4 个子步才全部检查一次 / vertices far from the skin are all checked only every 4th substep
          s.collider.lazy = (k - 1) % 4 !== 0
          if (k === 1) s.collider.round++
          s.solver.step(h, opt)
        }
      }
      from = end
    }
    // 反向检查：外生殖器的皮肤顶点不能从布的三角形中间钻出来（每帧一次，只看它附近的布；布的外侧取上一帧朝外的法线；
    // 每个顶点每帧最多推 1 cm，夹在腿和外生殖器之间时不会来回弹）
    // the reverse check: the skin vertices of the external genitalia must not come out between cloth vertices (once a
    // frame, nearby cloth only; the cloth's outer side from last frame's outward normals; at most 1 cm per vertex a frame,
    // so cloth caught between legs and genitalia does not bounce about)
    for (const s of this.sims) {
      if (!s.guard) continue
      s.guard.box = s.collider.reacquire
      s.guard.orient(s.solver.x, s.normals)
      s.guard.resetShift()
      s.guard.resolve(s.solver.x, s.solver.prev, s.solver.w, MARGIN)
    }
    let maxSpeed = 0, moved = 0, total = 0
    const still = 0.02 * FRAME_DT
    for (const s of this.sims) {
      const x = s.solver.x
      for (let i = 0; i < x.length; i += 3) {
        const d = len3(x[i]! - s.last[i]!, x[i + 1]! - s.last[i + 1]!, x[i + 2]! - s.last[i + 2]!)
        if (d > maxSpeed) maxSpeed = d
        if (d > still) moved++
        total++
      }
      s.last.set(x)
      this.normalsOf(s)
    }
    return { maxSpeed: maxSpeed / FRAME_DT, movingShare: total ? moved / total : 0, poseMs: t1 - t0, solveMs: performance.now() - t1, behind }
  }

  /** 上衣的叠穿碰撞：这一帧下装的位置和法线 / Layering for the tops: this frame's bottom positions and normals. */
  private layerBottoms(): void {
    // 只用下装腰头往下 25 cm 以内的那一段：上衣的下摆只会落在那里；裤腿在深蹲时贴到肚子上，算进来会让上衣在褶里来回跳
    // only the part of a bottom within 25 cm below its waistband: that is where a top's hem falls; trouser legs that
    // come up against the belly in a squat would make the top jump about in the fold
    const bottoms = this.sims.filter((s) => !s.top)
    const pick: number[] = []
    for (const [k, b] of bottoms.entries()) for (let i = 0; i < b.solver.n; i++) if (b.anchorDist[i]! <= 0.25) pick.push(k, i)
    const pos = new Float64Array((pick.length / 2) * 3), nor = new Float32Array((pick.length / 2) * 3)
    for (let j = 0; j < pick.length; j += 2) {
      const b = bottoms[pick[j]!]!, i = pick[j + 1]!
      for (let c = 0; c < 3; c++) {
        pos[(j / 2) * 3 + c] = b.solver.x[i * 3 + c]!
        nor[(j / 2) * 3 + c] = b.normals[i * 3 + c]!
      }
    }
    for (const s of this.sims) if (s.layer) s.layer.setBottom(pos, nor)
  }

  private extraCache: Float64Array | null = null
  /** 外生殖器前部的凸包络（k-DOP），所有衣服共用，每帧按姿势重算 / the convex envelope (k-DOP) of the front of the genitalia, shared by all garments, refitted to the pose every frame */
  private readonly bulge = new KdopCollider()
  private bulgeVerts: Uint32Array | null = null
  /**
   * 突起前面的那部分顶点（静止时在最前面 60 % 的深度里）：外生殖器移植片还带着会阴缝，往后伸到两腿之间，那一段不该包进鼓包
   * the front part of the protrusion's vertices (the front 60 % of its depth at rest): the genital graft carries the
   * perineal raphe back between the legs, and that stretch must not be wrapped into the bulge
   */
  private frontOf(verts: Uint32Array): Uint32Array {
    let lo = Infinity, hi = -Infinity
    for (const v of verts) {
      lo = Math.min(lo, this.rest[v * 3 + 2]!)
      hi = Math.max(hi, this.rest[v * 3 + 2]!)
    }
    const cut = hi - 0.6 * (hi - lo)
    return Uint32Array.from([...verts].filter((v) => this.rest[v * 3 + 2]! >= cut))
  }

  private guardExtra(): Float64Array {
    if (!this.extraCache) {
      const e = new Float64Array(this.rest.length / 3)
      for (const v of this.body.guard ?? []) e[v] = 0.006
      this.extraCache = e
    }
    return this.extraCache
  }

  /** 细小突起附近（外扩 3 cm）的布顶点每帧重新找最近的三角形 / Cloth vertices near the small protrusions (box grown by 3 cm) re-acquire their nearest triangle every frame. */
  private guardBox(pos: ArrayLike<number>): void {
    const g = this.body.guard
    if (!g?.length) return
    if (this.bulgeVerts) this.bulge.fit(pos, this.bulgeVerts)
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (const v of g) for (let k = 0; k < 3; k++) {
      box[k] = Math.min(box[k]!, pos[v * 3 + k]! - 0.03)
      box[k + 3] = Math.max(box[k + 3]!, pos[v * 3 + k]! + 0.03)
    }
    for (const s of this.sims) s.collider.reacquire = box
  }

  /** 顶点法线：面法线累加，翻到皮肤外侧，缝在一起的顶点取平均（缝线处不见明暗断层）/ Vertex normals: face normals summed, turned to the skin's outer side, stitched vertices averaged (no shading break at seams). */
  private normalsOf(s: Sim): void {
    const x = s.solver.x, T = s.triangles, N = s.normals
    const sn = this.skin.normal, SI = this.skin.index
    N.fill(0)
    for (let t = 0; t < T.length; t += 3) {
      const a = T[t]! * 3, b = T[t + 1]! * 3, c = T[t + 2]! * 3
      const ux = x[b]! - x[a]!, uy = x[b + 1]! - x[a + 1]!, uz = x[b + 2]! - x[a + 2]!
      const vx = x[c]! - x[a]!, vy = x[c + 1]! - x[a + 1]!, vz = x[c + 2]! - x[a + 2]!
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
      // 外侧：第一个角跟踪的皮肤三角形的法线 / the outer side: the normal of the skin triangle the first corner tracks
      const st = s.collider.tri[T[t]!]!
      let ox = 0, oy = 0, oz = 1
      if (st >= 0) {
        const p = SI[st * 3]! * 3
        ox = sn[p]!
        oy = sn[p + 1]!
        oz = sn[p + 2]!
      }
      const sg = fx * ox + fy * oy + fz * oz >= 0 ? 1 : -1
      for (const q of [a, b, c]) {
        N[q] = N[q]! + sg * fx
        N[q + 1] = N[q + 1]! + sg * fy
        N[q + 2] = N[q + 2]! + sg * fz
      }
    }
    for (let i = 0; i < N.length; i += 3) {
      const l = len3(N[i]!, N[i + 1]!, N[i + 2]!) || 1
      N[i] = N[i]! / l
      N[i + 1] = N[i + 1]! / l
      N[i + 2] = N[i + 2]! / l
    }
  }

  /** 检查用：每件衣服进入皮肤最深的顶点（米）/ For checks: each garment's deepest vertex inside the skin (metres). */
  penetration(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const s of this.sims) {
      let m = 0
      for (let i = 0; i < s.solver.n; i++) if (s.solver.w[i] !== 0) m = Math.max(m, -s.collider.signed[i]!)
      out[s.id] = m
    }
    return out
  }
}

/** 3×3 矩阵求逆（行主序）/ Inverse of a 3×3 matrix (row-major). */
function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number]
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C || 1
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
}

/** 两个姿势之间按关节角线性插值 / Linear interpolation of joint angles between two poses. */
function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const out: Pose = {}
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k] ?? [], y = b[k] ?? []
    const n = Math.max(x.length, y.length)
    out[k] = Array.from({ length: n }, (_, i) => (x[i] ?? 0) + ((y[i] ?? 0) - (x[i] ?? 0)) * t)
  }
  return out
}

/**
 * 三角形按规范顺序排列（每个三角形从最小的顶点号起转一圈，再按顶点号排序）：主线程给的下标顺序因来源而异
 * （查看器把口腔袋的三角形挪到最后），结果不该跟着变。
 * Triangles in a canonical order (each rotated to start at its lowest vertex, then sorted by vertex): the index order
 * the main thread sends depends on where it came from (the viewer moves the oral pouch's triangles to the end), and the
 * results should not depend on that.
 */
function canonicalTriangles(index: ArrayLike<number>): Uint32Array {
  const nt = index.length / 3
  const rot = new Uint32Array(index.length)
  for (let t = 0; t < nt; t++) {
    const a = index[t * 3]!, b = index[t * 3 + 1]!, c = index[t * 3 + 2]!
    const k = a <= b && a <= c ? 0 : b <= c ? 1 : 2
    const v = [a, b, c]
    for (let q = 0; q < 3; q++) rot[t * 3 + q] = v[(k + q) % 3]!
  }
  const order = Array.from({ length: nt }, (_, i) => i)
  order.sort((p, q) => rot[p * 3]! - rot[q * 3]! || rot[p * 3 + 1]! - rot[q * 3 + 1]! || rot[p * 3 + 2]! - rot[q * 3 + 2]!)
  const out = new Uint32Array(index.length)
  order.forEach((t, i) => out.set(rot.subarray(t * 3, t * 3 + 3), i * 3))
  return out
}
