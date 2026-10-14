// 长发的动力学：一部分引导发丝（"模拟发丝"）做位置动力学（PBD），由头的运动带动；发片和真发丝按最近的模拟发丝跟着走。
// 在世界坐标里积分：根和第一段钉在头上；相邻点距离不变（跟随前导，只移动后一个点）、隔点距离保持一点弯曲刚度、
// 向静止形状的弱吸引（靠近头皮处强、向梢减弱，相当于发型的"定型"和远程附着）、与身体碰撞（皮肤上的一串球，
// 各随其所在皮肤顶点的主关节运动）。输出是"静止空间"里的位移，交给着色器在蒙皮之前加上。
// 固定步长 1/60 秒；同样的关节序列得到同样的结果。头静止、发丝停下来以后不再推进（不连续重画）。
// Long-hair dynamics: a subset of the guide strands ("simulated strands") runs position-based dynamics (PBD), driven by
// the head's motion; cards and real strands follow their nearest simulated strand.
// Integration is in world space: root and first segment are pinned to the head; neighbouring points keep their distance
// (follow-the-leader: only the later point moves), points two apart keep a little bending stiffness, a weak pull towards
// the rest shape (strong near the scalp, fading towards the tip — the style's "hold" and a long-range attachment), and
// collisions with the body (a set of spheres on the skin, each moving with its skin vertex's main joint). The output is
// a displacement in rest space, which the shaders add before skinning.
// Fixed step 1/60 s; the same sequence of joints gives the same result. Once the head is still and the strands have
// stopped, nothing is advanced (no continuous redraw).

/** 关节纹理每行的纹素数（与 src/anatomy/rig.ts 的 JOINT_TEXELS 一致）/ texels per joint row (as JOINT_TEXELS in src/anatomy/rig.ts) */
export const JOINT_STRIDE = 8 * 4

export const DT = 1 / 60
const GRAVITY = -9.81
const DAMPING = 0.975
const ITERATIONS = 4

export interface SimInit {
  /** 每根模拟发丝的点数 / points per simulated strand */
  points: number
  /** 静止位置（静止空间），S × P × 3 / rest positions (rest space), S × P × 3 */
  rest: Float32Array
  /** 每根模拟发丝跟随的关节行 / the joint row each simulated strand follows */
  rows: Int32Array
  /** 碰撞球：中心（静止空间）、半径、关节行 / collision spheres: centre (rest space), radius, joint row */
  sphereCentre: Float32Array
  sphereRadius: Float32Array
  sphereRow: Int32Array
}

export type SkinMode = 'off' | 'pose' | 'pose+shape'

/** 一个关节的变换：可选的体型仿射 + 对偶四元数 / one joint's transform: an optional shape affine + a dual quaternion */
interface Xf {
  q: [number, number, number, number]
  t: [number, number, number]
  a: number[] | null
  ainv: number[] | null
}

function readXf(joints: Float32Array | null, row: number, mode: SkinMode): Xf {
  if (!joints || mode === 'off' || (row + 1) * JOINT_STRIDE > joints.length) return { q: [0, 0, 0, 1], t: [0, 0, 0], a: null, ainv: null }
  const o = row * JOINT_STRIDE
  const qx = joints[o]!, qy = joints[o + 1]!, qz = joints[o + 2]!, qw = joints[o + 3]!
  const dx = joints[o + 4]!, dy = joints[o + 5]!, dz = joints[o + 6]!, dw = joints[o + 7]!
  const n = Math.hypot(qx, qy, qz, qw) || 1
  const q: [number, number, number, number] = [qx / n, qy / n, qz / n, qw / n]
  const d = [dx / n, dy / n, dz / n, dw / n]
  // t = 2(w·d.xyz − d.w·q.xyz + q.xyz × d.xyz)
  const t: [number, number, number] = [
    2 * (q[3] * d[0]! - d[3]! * q[0] + (q[1] * d[2]! - q[2] * d[1]!)),
    2 * (q[3] * d[1]! - d[3]! * q[1] + (q[2] * d[0]! - q[0] * d[2]!)),
    2 * (q[3] * d[2]! - d[3]! * q[2] + (q[0] * d[1]! - q[1] * d[0]!)),
  ]
  let a: number[] | null = null, ainv: number[] | null = null
  if (mode === 'pose+shape') {
    a = Array.from(joints.subarray(o + 8, o + 20))
    ainv = invertAffine(a)
  }
  return { q, t, a, ainv }
}

function invertAffine(a: number[]): number[] {
  // a 按行：[r00 r01 r02 t0, r10 r11 r12 t1, r20 r21 r22 t2] / rows as listed
  const [m00, m01, m02, t0, m10, m11, m12, t1, m20, m21, m22, t2] = a as [number, number, number, number, number, number, number, number, number, number, number, number]
  const c00 = m11 * m22 - m12 * m21, c01 = m02 * m21 - m01 * m22, c02 = m01 * m12 - m02 * m11
  const c10 = m12 * m20 - m10 * m22, c11 = m00 * m22 - m02 * m20, c12 = m02 * m10 - m00 * m12
  const c20 = m10 * m21 - m11 * m20, c21 = m01 * m20 - m00 * m21, c22 = m00 * m11 - m01 * m10
  const det = m00 * c00 + m01 * c10 + m02 * c20 || 1e-12
  const r = [c00 / det, c01 / det, c02 / det, c10 / det, c11 / det, c12 / det, c20 / det, c21 / det, c22 / det]
  return [r[0]!, r[1]!, r[2]!, -(r[0]! * t0 + r[1]! * t1 + r[2]! * t2), r[3]!, r[4]!, r[5]!, -(r[3]! * t0 + r[4]! * t1 + r[5]! * t2), r[6]!, r[7]!, r[8]!, -(r[6]! * t0 + r[7]! * t1 + r[8]! * t2)]
}

function rotate(q: Xf['q'], x: number, y: number, z: number, out: Float64Array): void {
  // v + 2·q.xyz × (q.xyz × v + w·v)
  const [qx, qy, qz, qw] = q
  const cx = qy * z - qz * y + qw * x, cy = qz * x - qx * z + qw * y, cz = qx * y - qy * x + qw * z
  out[0] = x + 2 * (qy * cz - qz * cy)
  out[1] = y + 2 * (qz * cx - qx * cz)
  out[2] = z + 2 * (qx * cy - qy * cx)
}

const tmp = new Float64Array(3)

/** 静止空间 → 世界 / rest space → world */
function apply(xf: Xf, x: number, y: number, z: number, out: Float64Array): void {
  if (xf.a) {
    const a = xf.a
    const ax = a[0]! * x + a[1]! * y + a[2]! * z + a[3]!, ay = a[4]! * x + a[5]! * y + a[6]! * z + a[7]!, az = a[8]! * x + a[9]! * y + a[10]! * z + a[11]!
    x = ax, y = ay, z = az
  }
  rotate(xf.q, x, y, z, out)
  out[0] = out[0]! + xf.t[0]
  out[1] = out[1]! + xf.t[1]
  out[2] = out[2]! + xf.t[2]
}

/** 世界 → 静止空间 / world → rest space */
function unapply(xf: Xf, x: number, y: number, z: number, out: Float64Array): void {
  const inv: Xf['q'] = [-xf.q[0], -xf.q[1], -xf.q[2], xf.q[3]]
  rotate(inv, x - xf.t[0], y - xf.t[1], z - xf.t[2], out)
  if (xf.ainv) {
    const a = xf.ainv
    const x0 = out[0]!, y0 = out[1]!, z0 = out[2]!
    out[0] = a[0]! * x0 + a[1]! * y0 + a[2]! * z0 + a[3]!
    out[1] = a[4]! * x0 + a[5]! * y0 + a[6]! * z0 + a[7]!
    out[2] = a[8]! * x0 + a[9]! * y0 + a[10]! * z0 + a[11]!
  }
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export class HairSim {
  readonly S: number
  readonly P: number
  private rest: Float32Array
  private readonly p: Float64Array
  private readonly prev: Float64Array
  private readonly target: Float64Array
  private readonly seg: Float64Array
  private readonly seg2: Float64Array
  /** 每个点向静止形状的吸引（每次迭代的比例）/ per point, the pull towards the rest shape (fraction per iteration) */
  private readonly attach: Float64Array
  private readonly disp: Float32Array
  /** 静止时自己沉下去的那一点（预热后记下，从输出里减掉：静止时发型不变）/ the sag at rest (recorded after the warm-up and subtracted from the output, so the style is unchanged at rest) */
  private restSag: Float32Array | null = null
  private readonly sphereWorld: Float64Array
  private lastKey = ''
  private still = 0
  private sinceHead = 0
  steps = 0

  constructor(private readonly init: SimInit) {
    this.S = init.rows.length
    this.P = init.points
    const n = this.S * this.P
    this.rest = init.rest
    this.p = new Float64Array(n * 3)
    this.prev = new Float64Array(n * 3)
    this.target = new Float64Array(n * 3)
    this.seg = new Float64Array(n)
    this.seg2 = new Float64Array(n)
    this.attach = new Float64Array(this.P)
    for (let k = 0; k < this.P; k++) {
      const s = k / (this.P - 1)
      // 头皮上的一段几乎不动，向梢减到 0.025 / the stretch on the scalp barely moves; towards the tip it drops to 0.025
      this.attach[k] = 0.025 + 0.6 * (1 - smooth(0.08, 0.5, s))
    }
    this.disp = new Float32Array(n * 3)
    this.sphereWorld = new Float64Array(init.sphereRadius.length * 3)
    this.setRest(init.rest, true)
  }

  /** 静止形状变了（体型、表情）/ the rest shape changed (shape, expression) */
  setRest(rest: Float32Array, reset = false): void {
    this.rest = rest
    const { S, P } = this
    for (let s = 0; s < S; s++) {
      for (let k = 1; k < P; k++) {
        const i = s * P + k
        this.seg[i] = Math.hypot(rest[i * 3]! - rest[i * 3 - 3]!, rest[i * 3 + 1]! - rest[i * 3 - 2]!, rest[i * 3 + 2]! - rest[i * 3 - 1]!)
        if (k >= 2) this.seg2[i] = Math.hypot(rest[i * 3]! - rest[i * 3 - 6]!, rest[i * 3 + 1]! - rest[i * 3 - 5]!, rest[i * 3 + 2]! - rest[i * 3 - 4]!)
      }
    }
    if (reset) {
      this.p.set(rest)
      this.prev.set(rest)
    }
    this.still = 0
  }

  /**
   * 预热：在静止姿势下推进到停下，记下这时的下沉量，以后输出都减去它。
   * Warm-up: advance at the rest pose until it stops, record the sag, and subtract it from all later output.
   */
  warm(maxSteps = 2000): number {
    let n = 0
    while (this.step(null, 'off', 1) && n < maxSteps) n++
    this.restSag = Float32Array.from(this.disp)
    this.disp.fill(0)
    return n
  }

  /** 位移（静止空间），S × P × 3 / displacement (rest space), S × P × 3 */
  get displacement(): Float32Array {
    return this.disp
  }

  /** 是否已经停下（头没动、发丝也不动了）/ whether it has come to rest (the head still and the strands stopped) */
  get settled(): boolean {
    return this.still > 30
  }

  /**
   * 推进 `steps` 步。`joints` 为关节纹理的数据（姿势不在用时传 null）。返回发丝是否还在动。
   * Advance `steps` steps. `joints` is the joint texture's data (null when no pose is in use). Returns whether the
   * strands are still moving.
   */
  step(joints: Float32Array | null, mode: SkinMode, steps: number): boolean {
    const { S, P, init } = this
    // 关节没变、发丝停了：不推进 / joints unchanged and strands stopped: nothing to advance
    const key = joints && mode !== 'off' ? this.jointKey(joints) : 'rest'
    const headMoved = key !== this.lastKey
    this.lastKey = key
    if (!headMoved && this.settled) return false
    const xfs = new Map<number, Xf>()
    const xf = (row: number): Xf => {
      let x = xfs.get(row)
      if (!x) xfs.set(row, (x = readXf(joints, row, mode)))
      return x
    }
    // 目标形状和碰撞球随关节走 / the target shape and the spheres follow the joints
    for (let s = 0; s < S; s++) {
      const x = xf(init.rows[s]!)
      for (let k = 0; k < P; k++) {
        const i = (s * P + k) * 3
        apply(x, this.rest[i]!, this.rest[i + 1]!, this.rest[i + 2]!, tmp)
        this.target[i] = tmp[0]!
        this.target[i + 1] = tmp[1]!
        this.target[i + 2] = tmp[2]!
      }
    }
    const nS = init.sphereRadius.length
    for (let c = 0; c < nS; c++) {
      apply(xf(init.sphereRow[c]!), init.sphereCentre[c * 3]!, init.sphereCentre[c * 3 + 1]!, init.sphereCentre[c * 3 + 2]!, tmp)
      this.sphereWorld.set(tmp, c * 3)
    }
    const grid = this.buildGrid()
    let maxMove = 0
    for (let n = 0; n < steps; n++) {
      this.steps++
      const p = this.p, prev = this.prev, t = this.target
      for (let s = 0; s < S; s++) {
        for (let k = 0; k < P; k++) {
          const i = (s * P + k) * 3
          if (k < 2) {
            prev[i] = p[i]!, prev[i + 1] = p[i + 1]!, prev[i + 2] = p[i + 2]!
            p[i] = t[i]!, p[i + 1] = t[i + 1]!, p[i + 2] = t[i + 2]!
            continue
          }
          const vx = (p[i]! - prev[i]!) * DAMPING, vy = (p[i + 1]! - prev[i + 1]!) * DAMPING, vz = (p[i + 2]! - prev[i + 2]!) * DAMPING
          prev[i] = p[i]!, prev[i + 1] = p[i + 1]!, prev[i + 2] = p[i + 2]!
          p[i] = p[i]! + vx
          p[i + 1] = p[i + 1]! + vy + GRAVITY * DT * DT
          p[i + 2] = p[i + 2]! + vz
        }
      }
      for (let it = 0; it < ITERATIONS; it++) {
        for (let s = 0; s < S; s++) {
          for (let k = 2; k < P; k++) {
            const i = s * P + k, a = i * 3
            // 向静止形状的吸引 / pull towards the rest shape
            const w = this.attach[k]!
            p[a] = p[a]! + (t[a]! - p[a]!) * w
            p[a + 1] = p[a + 1]! + (t[a + 1]! - p[a + 1]!) * w
            p[a + 2] = p[a + 2]! + (t[a + 2]! - p[a + 2]!) * w
            // 弯曲：与隔一个点的距离 / bending: the distance to the point two back
            const b2 = a - 6
            let dx = p[a]! - p[b2]!, dy = p[a + 1]! - p[b2 + 1]!, dz = p[a + 2]! - p[b2 + 2]!
            let l = Math.hypot(dx, dy, dz) || 1e-9
            let c = ((l - this.seg2[i]!) / l) * 0.15
            p[a] = p[a]! - dx * c
            p[a + 1] = p[a + 1]! - dy * c
            p[a + 2] = p[a + 2]! - dz * c
            // 长度：跟随前导，只动后一个点 / length: follow the leader, only the later point moves
            const b = a - 3
            dx = p[a]! - p[b]!, dy = p[a + 1]! - p[b + 1]!, dz = p[a + 2]! - p[b + 2]!
            l = Math.hypot(dx, dy, dz) || 1e-9
            c = (l - this.seg[i]!) / l
            p[a] = p[a]! - dx * c
            p[a + 1] = p[a + 1]! - dy * c
            p[a + 2] = p[a + 2]! - dz * c
          }
        }
      }
      // 碰撞 / collisions
      for (let s = 0; s < S; s++) for (let k = 2; k < P; k++) this.collide((s * P + k) * 3, grid)
      for (let i = 0; i < p.length; i += 3) maxMove = Math.max(maxMove, Math.abs(p[i]! - prev[i]!) + Math.abs(p[i + 1]! - prev[i + 1]!) + Math.abs(p[i + 2]! - prev[i + 2]!))
    }
    // 位移：世界 → 静止空间，减去静止位置 / displacement: world → rest space, minus the rest position
    for (let s = 0; s < S; s++) {
      const x = xf(init.rows[s]!)
      for (let k = 0; k < P; k++) {
        const i = (s * P + k) * 3
        unapply(x, this.p[i]!, this.p[i + 1]!, this.p[i + 2]!, tmp)
        const sag = this.restSag
        this.disp[i] = tmp[0]! - this.rest[i]! - (sag ? sag[i]! : 0)
        this.disp[i + 1] = tmp[1]! - this.rest[i + 1]! - (sag ? sag[i + 1]! : 0)
        this.disp[i + 2] = tmp[2]! - this.rest[i + 2]! - (sag ? sag[i + 2]! : 0)
      }
    }
    // 每步不到 0.1 毫米算停；头停下 6 秒以后无论如何都停（贴着身体的发丝可能一直有极小的抖动）
    // under 0.1 mm per step counts as stopped; 6 s after the head stopped it stops regardless (strands resting on the body can keep a tiny jitter)
    if (headMoved) this.sinceHead = 0
    else this.sinceHead += steps
    if (!headMoved && (maxMove < 1e-4 * steps || this.sinceHead > 360)) this.still += steps
    else this.still = 0
    return !this.settled
  }

  private jointKey(joints: Float32Array): string {
    // 用到的关节行的数据拼成键（四位小数）/ the data of the rows in use, joined into a key (4 decimals)
    const rows = new Set<number>([...this.init.rows, ...this.init.sphereRow])
    let k = ''
    for (const r of rows) for (let j = 0; j < 8; j++) k += `${joints[r * JOINT_STRIDE + j]!.toFixed(4)},`
    return k
  }

  private buildGrid(): Map<number, number[]> {
    const g = new Map<number, number[]>()
    const n = this.init.sphereRadius.length
    for (let c = 0; c < n; c++) {
      const key = this.cell(this.sphereWorld[c * 3]!, this.sphereWorld[c * 3 + 1]!, this.sphereWorld[c * 3 + 2]!)
      const l = g.get(key)
      if (l) l.push(c)
      else g.set(key, [c])
    }
    return g
  }

  private cell(x: number, y: number, z: number): number {
    const C = 0.04
    return ((Math.floor(x / C) + 512) * 1024 + (Math.floor(y / C) + 512)) * 1024 + (Math.floor(z / C) + 512)
  }

  private collide(i: number, grid: Map<number, number[]>): void {
    const p = this.p
    const C = 0.04
    const cx = Math.floor(p[i]! / C), cy = Math.floor(p[i + 1]! / C), cz = Math.floor(p[i + 2]! / C)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const l = grid.get(((cx + dx + 512) * 1024 + (cy + dy + 512)) * 1024 + (cz + dz + 512))
          if (!l) continue
          for (const c of l) {
            const ox = p[i]! - this.sphereWorld[c * 3]!, oy = p[i + 1]! - this.sphereWorld[c * 3 + 1]!, oz = p[i + 2]! - this.sphereWorld[c * 3 + 2]!
            const r = this.init.sphereRadius[c]!
            const d2 = ox * ox + oy * oy + oz * oz
            if (d2 >= r * r) continue
            const d = Math.sqrt(d2) || 1e-9
            const f = r / d
            p[i] = this.sphereWorld[c * 3]! + ox * f
            p[i + 1] = this.sphereWorld[c * 3 + 1]! + oy * f
            p[i + 2] = this.sphereWorld[c * 3 + 2]! + oz * f
          }
        }
      }
    }
  }
}

/**
 * 碰撞球：头发附近（离任一静止发丝点 3 厘米内）的皮肤顶点按 1.5 厘米网格取一个，球心放在皮肤里沿法线 1.5 厘米处；
 * 半径不超过 1.5 厘米、也不碰到任何静止的发丝点（静止时不会有碰撞，发型不会被球顶开）。
 * Collision spheres: skin vertices near the hair (within 3 cm of any rest strand point), one per 1.5 cm grid cell, with
 * the centre 1.5 cm inside the skin along the normal; the radius is at most 1.5 cm and touches no rest strand point (so
 * nothing collides at rest and the style is not pushed about by the spheres).
 */
export function collisionSpheres(skinPos: ArrayLike<number>, skinNormal: ArrayLike<number>, skinRow: (v: number) => number, rest: Float32Array): { centre: Float32Array; radius: Float32Array; row: Int32Array } {
  const C = 0.01
  const grid = new Map<string, number[]>()
  for (let i = 0; i < rest.length; i += 3) {
    const k = `${Math.floor(rest[i]! / C)},${Math.floor(rest[i + 1]! / C)},${Math.floor(rest[i + 2]! / C)}`
    const l = grid.get(k)
    if (l) l.push(i)
    else grid.set(k, [i])
  }
  const near = (x: number, y: number, z: number, r: number): number => {
    let best = Infinity
    const R = Math.ceil(r / C)
    const gx = Math.floor(x / C), gy = Math.floor(y / C), gz = Math.floor(z / C)
    for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) {
      for (const i of grid.get(`${gx + dx},${gy + dy},${gz + dz}`) ?? []) best = Math.min(best, Math.hypot(rest[i]! - x, rest[i + 1]! - y, rest[i + 2]! - z))
    }
    return best
  }
  const taken = new Set<string>()
  const centre: number[] = [], radius: number[] = [], row: number[] = []
  const n = skinPos.length / 3
  for (let v = 0; v < n; v++) {
    const x = skinPos[v * 3]!, y = skinPos[v * 3 + 1]!, z = skinPos[v * 3 + 2]!
    const key = `${Math.floor(x / 0.015)},${Math.floor(y / 0.015)},${Math.floor(z / 0.015)}`
    if (taken.has(key)) continue
    if (near(x, y, z, 0.03) > 0.03) continue
    taken.add(key)
    const R = 0.015
    const cx = x - skinNormal[v * 3]! * R, cy = y - skinNormal[v * 3 + 1]! * R, cz = z - skinNormal[v * 3 + 2]! * R
    const r = Math.min(R, near(cx, cy, cz, 0.03) - 0.001)
    if (r < 0.004) continue
    centre.push(cx, cy, cz)
    radius.push(r)
    row.push(skinRow(v))
  }
  return { centre: Float32Array.from(centre), radius: Float32Array.from(radius), row: Int32Array.from(row) }
}
