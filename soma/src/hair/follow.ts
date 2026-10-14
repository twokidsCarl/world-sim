// 贴着皮肤的毛（阴毛、腋毛）在大幅姿势下跟着皮肤走：
//   1. 每个发片顶点照抄最近皮肤顶点的蒙皮影响，在 CPU 上按关节数据蒙皮 → 顶点贴着皮肤，但皮肤拉伸时发片也被拉长（腋窝外展 90° 时约 3 倍）；
//   2. 沿锚定后贴着皮肤的中心折线，按静止时的累计长度重新放每一环、恢复宽度 → 发片不再被拉长，仍贴着皮肤；
//   3. 用这个顶点自己的蒙皮的逆变换换回静止空间，写进几何。着色器照常蒙皮，结果就是第 2 步的位置。
// 只在关节数据变了时算一次（姿势过渡期间每帧一次）。蒙皮公式与 src/viewer/skinning.ts 的对偶四元数混合相同。
// Hair lying on the skin (pubic, axillary) follows the skin in large poses:
//   1. each card vertex copies the nearest skin vertex's influences and is skinned on the CPU from the joint data → the
//      vertices lie on the skin, but the cards stretch with it (about 3× in the axilla at 90° abduction);
//   2. each ring is re-placed along the anchored centre polyline (which lies on the skin) at its rest cumulative length,
//      with its rest width → the cards no longer stretch and still lie on the skin;
//   3. the vertex's own skinning is inverted to bring it back to rest space, and that goes into the geometry. The
//      shader skins as usual and the result is step 2's position.
// Computed once whenever the joint data change (once per frame during a pose transition). The skinning formula is the
// dual-quaternion blend of src/viewer/skinning.ts.

import { JOINT_STRIDE, type SkinMode } from './dynamics.ts'

/** 一个顶点的混合变换：体型仿射（3×4，按行）和归一化的对偶四元数 / a vertex's blended transform: the shape affine (3×4, by rows) and the normalised dual quaternion */
interface Blend {
  a: Float64Array | null
  q: [number, number, number, number]
  t: [number, number, number]
}

export function blend(joints: Float32Array, mode: SkinMode, idx: ArrayLike<number>, w: ArrayLike<number>, o: number): Blend {
  let a: Float64Array | null = null
  if (mode === 'pose+shape') {
    a = new Float64Array(12)
    for (let k = 0; k < 4; k++) {
      const wk = w[o + k]! / 255
      if (!wk) continue
      const r = idx[o + k]! * JOINT_STRIDE + 8
      for (let j = 0; j < 12; j++) a[j] = a[j]! + wk * joints[r + j]!
    }
  }
  const r0 = idx[o]! * JOINT_STRIDE
  const real = [0, 0, 0, 0], dual = [0, 0, 0, 0]
  for (let k = 0; k < 4; k++) {
    const wk = w[o + k]! / 255
    if (!wk) continue
    const r = idx[o + k]! * JOINT_STRIDE
    const sgn = joints[r]! * joints[r0]! + joints[r + 1]! * joints[r0 + 1]! + joints[r + 2]! * joints[r0 + 2]! + joints[r + 3]! * joints[r0 + 3]! < 0 ? -wk : wk
    for (let c = 0; c < 4; c++) {
      real[c] = real[c]! + sgn * joints[r + c]!
      dual[c] = dual[c]! + sgn * joints[r + 4 + c]!
    }
  }
  const n = Math.hypot(real[0]!, real[1]!, real[2]!, real[3]!) || 1
  const q: [number, number, number, number] = [real[0]! / n, real[1]! / n, real[2]! / n, real[3]! / n]
  const d = dual.map((x) => x / n)
  // t = 2(w·d.xyz − d.w·q.xyz + q.xyz × d.xyz)
  const t: [number, number, number] = [
    2 * (q[3] * d[0]! - d[3]! * q[0] + (q[1] * d[2]! - q[2] * d[1]!)),
    2 * (q[3] * d[1]! - d[3]! * q[1] + (q[2] * d[0]! - q[0] * d[2]!)),
    2 * (q[3] * d[2]! - d[3]! * q[2] + (q[0] * d[1]! - q[1] * d[0]!)),
  ]
  return { a, q, t }
}

function rot(q: Blend['q'], x: number, y: number, z: number, out: Float64Array): void {
  const [qx, qy, qz, qw] = q
  const cx = qy * z - qz * y + qw * x, cy = qz * x - qx * z + qw * y, cz = qx * y - qy * x + qw * z
  out[0] = x + 2 * (qy * cz - qz * cy)
  out[1] = y + 2 * (qz * cx - qx * cz)
  out[2] = z + 2 * (qx * cy - qy * cx)
}

const tmp = new Float64Array(3)

/** 静止 → 姿势 / rest → posed */
export function forward(b: Blend, x: number, y: number, z: number, out: Float64Array): void {
  if (b.a) {
    const a = b.a
    const ax = a[0]! * x + a[1]! * y + a[2]! * z + a[3]!, ay = a[4]! * x + a[5]! * y + a[6]! * z + a[7]!, az = a[8]! * x + a[9]! * y + a[10]! * z + a[11]!
    x = ax, y = ay, z = az
  }
  rot(b.q, x, y, z, out)
  out[0] = out[0]! + b.t[0]
  out[1] = out[1]! + b.t[1]
  out[2] = out[2]! + b.t[2]
}

/** 姿势 → 静止 / posed → rest */
function inverse(b: Blend, x: number, y: number, z: number, out: Float64Array): void {
  rot([-b.q[0], -b.q[1], -b.q[2], b.q[3]], x - b.t[0], y - b.t[1], z - b.t[2], out)
  if (b.a) {
    const a = b.a
    const [m00, m01, m02, t0, m10, m11, m12, t1, m20, m21, m22, t2] = a as unknown as number[] as [number, number, number, number, number, number, number, number, number, number, number, number]
    const c00 = m11 * m22 - m12 * m21, c01 = m02 * m21 - m01 * m22, c02 = m01 * m12 - m02 * m11
    const c10 = m12 * m20 - m10 * m22, c11 = m00 * m22 - m02 * m20, c12 = m02 * m10 - m00 * m12
    const c20 = m10 * m21 - m11 * m20, c21 = m01 * m20 - m00 * m21, c22 = m00 * m11 - m01 * m10
    const det = m00 * c00 + m01 * c10 + m02 * c20 || 1e-12
    const x0 = out[0]! - t0, y0 = out[1]! - t1, z0 = out[2]! - t2
    out[0] = (c00 * x0 + c01 * y0 + c02 * z0) / det
    out[1] = (c10 * x0 + c11 * y0 + c12 * z0) / det
    out[2] = (c20 * x0 + c21 * y0 + c22 * z0) / det
  }
}

/**
 * 按姿势重排一层发片的静止位置。`rest`：静止位置（根 + 位移）；`anchors`：每个顶点的锚皮肤顶点；`index`/`weight`：皮肤的影响；
 * 输出写进 `out`（同样是静止空间）。`rings`：每张发片的环数（每环左右两个顶点）。
 * Re-lay one level's rest positions for a pose. `rest`: rest positions (root + offset); `anchors`: each vertex's anchor
 * skin vertex; `index`/`weight`: the skin's influences; the output goes into `out` (also rest space). `rings`: rings per
 * card (two vertices, left and right, per ring).
 */
export function followSkin(rest: Float32Array, anchors: Uint32Array, rings: number, index: Uint16Array, weight: Uint8Array, joints: Float32Array, mode: SkinMode, out: Float32Array): void {
  const V = rest.length / 3, per = rings * 2, cards = V / per
  const posed = new Float64Array(V * 3)
  const blends: Blend[] = new Array(V)
  for (let v = 0; v < V; v++) {
    const b = blend(joints, mode, index, weight, anchors[v]! * 4)
    blends[v] = b
    forward(b, rest[v * 3]!, rest[v * 3 + 1]!, rest[v * 3 + 2]!, tmp)
    posed.set(tmp, v * 3)
  }
  const P = (v: number, k: number): number => posed[v * 3 + k]!
  const R = (v: number, k: number): number => rest[v * 3 + k]!
  for (let c = 0; c < cards; c++) {
    const base = c * per
    // 锚定后各环的中点连成一条贴着皮肤的折线；第 r 环放在这条折线上弧长等于静止时累计长度的地方
    // the anchored ring centres form a polyline lying on the skin; ring r goes where the arc length along it equals the rest cumulative length
    const mx: number[] = [], my: number[] = [], mz: number[] = []
    for (let r = 0; r < rings; r++) {
      const L = base + r * 2
      mx.push((P(L, 0) + P(L + 1, 0)) / 2)
      my.push((P(L, 1) + P(L + 1, 1)) / 2)
      mz.push((P(L, 2) + P(L + 1, 2)) / 2)
    }
    let seg = 0, segStart = 0, target = 0
    let prevX = mx[0]!, prevY = my[0]!, prevZ = mz[0]!
    for (let r = 1; r < rings; r++) {
      const L = base + r * 2, Rr = L + 1, L0 = L - 2, R0 = L - 1
      const len = Math.hypot((R(L, 0) + R(Rr, 0) - R(L0, 0) - R(R0, 0)) / 2, (R(L, 1) + R(Rr, 1) - R(L0, 1) - R(R0, 1)) / 2, (R(L, 2) + R(Rr, 2) - R(L0, 2) - R(R0, 2)) / 2)
      const half = Math.hypot(R(Rr, 0) - R(L, 0), R(Rr, 1) - R(L, 1), R(Rr, 2) - R(L, 2)) / 2
      target += len
      // 沿折线找弧长 target 处；超过末端就沿最后一段延长 / find arc length `target` along the polyline; beyond the end, extend along the last segment
      let segLen = Math.hypot(mx[seg + 1]! - mx[seg]!, my[seg + 1]! - my[seg]!, mz[seg + 1]! - mz[seg]!)
      while (seg < rings - 2 && segStart + segLen < target) {
        segStart += segLen
        seg++
        segLen = Math.hypot(mx[seg + 1]! - mx[seg]!, my[seg + 1]! - my[seg]!, mz[seg + 1]! - mz[seg]!)
      }
      const u = segLen > 1e-9 ? (target - segStart) / segLen : 0
      const nx = mx[seg]! + (mx[seg + 1]! - mx[seg]!) * u, ny = my[seg]! + (my[seg + 1]! - my[seg]!) * u, nz = mz[seg]! + (mz[seg + 1]! - mz[seg]!) * u
      let dx = nx - prevX, dy = ny - prevY, dz = nz - prevZ
      const dl = Math.hypot(dx, dy, dz) || 1
      dx /= dl, dy /= dl, dz /= dl
      // 侧向：静止时的侧向按根环的旋转转过来，再去掉沿这一段的分量（左右两个锚点可能在皱襞两侧，直接相减会乱转）
      // sideways: the rest side vector turned by the root ring's rotation, minus its component along this segment (the two anchors can sit either side of a fold, so their difference would spin about)
      rot(blends[base]!.q, R(Rr, 0) - R(L, 0), R(Rr, 1) - R(L, 1), R(Rr, 2) - R(L, 2), tmp)
      let sx = tmp[0]!, sy = tmp[1]!, sz = tmp[2]!
      const along = sx * dx + sy * dy + sz * dz
      sx -= along * dx, sy -= along * dy, sz -= along * dz
      const sl = Math.hypot(sx, sy, sz) || 1
      sx = (sx / sl) * half, sy = (sy / sl) * half, sz = (sz / sl) * half
      posed[L * 3] = nx - sx, posed[L * 3 + 1] = ny - sy, posed[L * 3 + 2] = nz - sz
      posed[Rr * 3] = nx + sx, posed[Rr * 3 + 1] = ny + sy, posed[Rr * 3 + 2] = nz + sz
      prevX = nx, prevY = ny, prevZ = nz
    }
  }
  for (let v = 0; v < V; v++) {
    inverse(blends[v]!, posed[v * 3]!, posed[v * 3 + 1]!, posed[v * 3 + 2]!, tmp)
    out[v * 3] = tmp[0]!
    out[v * 3 + 1] = tmp[1]!
    out[v * 3 + 2] = tmp[2]!
  }
}
