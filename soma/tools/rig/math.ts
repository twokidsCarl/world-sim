// 绑定构建和姿态参考所用的小型线性代数。无任何依赖，
// 因此前端可以原样导入 pose.ts（并经由它导入本文件）。
// Small linear algebra used by the rig build and the pose reference. No dependencies, so the
// frontend can import pose.ts (and through it this file) unchanged.

export type V3 = [number, number, number]
/** 行主序 3×3。 Row-major 3×3. */
export type M3 = [number, number, number, number, number, number, number, number, number]
/** x ↦ r·x + t */
export interface Xf {
  r: M3
  t: V3
}
/** [w, x, y, z] */
export type Quat = [number, number, number, number]
/** 先实部（旋转）后对偶部，各为 [w, x, y, z]。 Real part (rotation) then dual part, each [w, x, y, z]. */
export type DualQuat = [number, number, number, number, number, number, number, number]

export const v3 = (a: ArrayLike<number>, i = 0): V3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!]
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2])
export const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
export const norm = (a: V3): V3 => {
  const l = len(a)
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]
}
export const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
/** `a` 垂直于单位向量 `n` 的分量，已归一化。 Component of `a` perpendicular to unit `n`, normalised. */
export const reject = (a: V3, n: V3): V3 => norm(sub(a, mul(n, dot(a, n))))
export const mean = (pts: V3[]): V3 => {
  const s: V3 = [0, 0, 0]
  for (const p of pts) (s[0] += p[0]), (s[1] += p[1]), (s[2] += p[2])
  return pts.length ? mul(s, 1 / pts.length) : s
}

export const M3_ID: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]
export const XF_ID: Xf = { r: M3_ID, t: [0, 0, 0] }

export function m3mul(a: M3, b: M3): M3 {
  const o = new Array<number>(9) as M3
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!
  return o
}
export const m3apply = (m: M3, v: V3): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
export const m3t = (m: M3): M3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]

/** 绕单位轴 `axis` 旋转 `angle`（右手定则）。 Rotation by `angle` (right-hand rule) about the unit `axis`. */
export function axisAngle(axis: V3, angle: number): M3 {
  const [x, y, z] = axis
  const c = Math.cos(angle), s = Math.sin(angle), k = 1 - c
  return [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k]
}

export const xfApply = (m: Xf, p: V3): V3 => add(m3apply(m.r, p), m.t)
/** a ∘ b：先作用 b。 a ∘ b: apply b first. */
export const xfMul = (a: Xf, b: Xf): Xf => ({ r: m3mul(a.r, b.r), t: add(m3apply(a.r, b.t), a.t) })
export const xfInv = (a: Xf): Xf => {
  const r = m3t(a.r)
  return { r, t: mul(m3apply(r, a.t), -1) }
}
/** 绕固定点 `c` 的旋转 `r`。 Rotation `r` about the fixed point `c`. */
export const rotateAbout = (r: M3, c: V3): Xf => ({ r, t: sub(c, m3apply(r, c)) })

export function quatFromM3(m: M3): Quat {
  const tr = m[0] + m[4] + m[8]
  let q: Quat
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    q = [s / 4, (m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s]
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2
    q = [(m[7] - m[5]) / s, s / 4, (m[1] + m[3]) / s, (m[2] + m[6]) / s]
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2
    q = [(m[2] - m[6]) / s, (m[1] + m[3]) / s, s / 4, (m[5] + m[7]) / s]
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2
    q = [(m[3] - m[1]) / s, (m[2] + m[6]) / s, (m[5] + m[7]) / s, s / 4]
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3])
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}

export function m3FromQuat(q: Quat): M3 {
  const [w, x, y, z] = q
  return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]
}

export const quatMul = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
]

/** 刚体变换的单位对偶四元数：实部 = 旋转 q，对偶部 = ½·t·q。 Unit dual quaternion of a rigid transform: real = rotation q, dual = ½·t·q. */
export function dqFromXf(m: Xf): DualQuat {
  const q = quatFromM3(m.r)
  const d = quatMul([0, m.t[0], m.t[1], m.t[2]], q)
  return [q[0], q[1], q[2], q[3], d[0] / 2, d[1] / 2, d[2] / 2, d[3] / 2]
}

/** 归一化一个（混合后的）对偶四元数，并返回它所表示的刚体变换。 Normalises a (blended) dual quaternion and returns the rigid transform it represents. */
export function xfFromDq(dq: ArrayLike<number>): Xf {
  const n = Math.hypot(dq[0]!, dq[1]!, dq[2]!, dq[3]!)
  const q: Quat = [dq[0]! / n, dq[1]! / n, dq[2]! / n, dq[3]! / n]
  const d: Quat = [dq[4]! / n, dq[5]! / n, dq[6]! / n, dq[7]! / n]
  // t = 2 · d · conj(q)（向量部分） / t = 2 · d · conj(q)   (vector part)
  const t = quatMul(d, [q[0], -q[1], -q[2], -q[3]])
  return { r: m3FromQuat(q), t: [2 * t[1], 2 * t[2], 2 * t[3]] }
}

/**
 * 用循环 Jacobi 旋转对对称 n×n 矩阵（行主序）做特征分解。
 * 返回升序排列的特征值及对应的单位特征向量（vectors[k] 为第 k 个）。
 * Eigen-decomposition of a symmetric n×n matrix (row-major) by cyclic Jacobi rotations.
 * Returns eigenvalues ascending and the matching unit eigenvectors (vectors[k] is the k-th).
 */
export function eigSym(a: ArrayLike<number>, n: number): { values: number[]; vectors: number[][] } {
  const m = Float64Array.from(a)
  const v = new Float64Array(n * n)
  for (let i = 0; i < n; i++) v[i * n + i] = 1
  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += m[i * n + j]! ** 2
    if (off < 1e-30) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = m[p * n + q]!
        if (Math.abs(apq) < 1e-300) continue
        const theta = (m[q * n + q]! - m[p * n + p]!) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1), s = t * c
        for (let k = 0; k < n; k++) {
          const akp = m[k * n + p]!, akq = m[k * n + q]!
          m[k * n + p] = c * akp - s * akq
          m[k * n + q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = m[p * n + k]!, aqk = m[q * n + k]!
          m[p * n + k] = c * apk - s * aqk
          m[q * n + k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p]!, vkq = v[k * n + q]!
          v[k * n + p] = c * vkp - s * vkq
          v[k * n + q] = s * vkp + c * vkq
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => m[i * n + i]! - m[j * n + j]!)
  return { values: order.map((i) => m[i * n + i]!), vectors: order.map((i) => Array.from({ length: n }, (_, k) => v[k * n + i]!)) }
}

/** 用列主元高斯消元法求解 A·x = b（n×n，行主序）。矩阵奇异时返回 null。 Solves A·x = b (n×n, row-major) by Gaussian elimination with partial pivoting. Null when singular. */
export function solve(a: ArrayLike<number>, b: ArrayLike<number>, n: number): number[] | null {
  const m = Float64Array.from(a)
  const x = Float64Array.from(b)
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r * n + c]!) > Math.abs(m[p * n + c]!)) p = r
    if (Math.abs(m[p * n + c]!) < 1e-14) return null
    if (p !== c) {
      for (let k = 0; k < n; k++) [m[c * n + k], m[p * n + k]] = [m[p * n + k]!, m[c * n + k]!]
      ;[x[c], x[p]] = [x[p]!, x[c]!]
    }
    for (let r = c + 1; r < n; r++) {
      const f = m[r * n + c]! / m[c * n + c]!
      if (f === 0) continue
      for (let k = c; k < n; k++) m[r * n + k] = m[r * n + k]! - f * m[c * n + k]!
      x[r] = x[r]! - f * x[c]!
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r]!
    for (let k = r + 1; k < n; k++) s -= m[r * n + k]! * x[k]!
    x[r] = s / m[r * n + r]!
  }
  return Array.from(x)
}

export const deg = (r: number): number => (r * 180) / Math.PI
export const rad = (d: number): number => (d * Math.PI) / 180
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)
export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}
