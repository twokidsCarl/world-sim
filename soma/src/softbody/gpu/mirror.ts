// GPU 内核的 CPU 镜像：每个函数对应 kernels.ts 里的一个 WGSL 入口（一个线程做的事），同样的数组布局、同样的分支、
// 同样的求和顺序；颜色按顺序走，同一颜色里的约束互不相干，所以 CPU 上逐个走与 GPU 上同时走结果相同。
// 没有 GPU 的地方（Bun 里的单元测试）用它检查内核的数学；浏览器里 GPU 的结果再与它对照（tools/softbody/gpu-check.ts）。
// 存储可以选 f32（与 GPU 的缓冲区一样舍入）或 f64。
// The CPU mirror of the GPU kernels: each function matches one WGSL entry point of kernels.ts (what one thread does),
// with the same array layout, the same branches and the same order of sums; colours run in order, and constraints of
// one colour do not interact, so running them one by one on the CPU gives what running them at once on the GPU gives. Where there is no GPU (unit tests in Bun) it checks the
// kernels' mathematics; in the browser the GPU's results are compared against it (tools/softbody/gpu-check.ts).
// Storage may be f32 (rounded like the GPU's buffers) or f64.

import type { Plane, PointSet, Probe, Vec3 } from '../solver.ts'
import { CAP_STRIDE, type ContactPlan, type GpuPlan, J_MIN, MAX_RING_NODES } from './plan.ts'

type Arr = Float32Array | Float64Array

/** 一组点约束的形状（与 WGSL 的 shape.kind 相同）/ The shape of a point-constraint set (as shape.kind in WGSL) */
export const SHAPE = { anchor: 0, sphere: 1, flat: 2, rod: 3, plane: 4 } as const

export interface ShapeParams {
  kind: number
  /** 中心（局部坐标）或法线 / centre (local coordinates) or normal */
  c: Vec3
  /** 轴 / axis */
  a: Vec3
  radius: number
}

/** 压头 / 支撑面 → 内核的形状参数 / probe or plane → the kernel's shape parameters */
export function shapeOf(probe: Probe | null, plane: Plane | null, origin: Vec3): ShapeParams {
  if (plane) return { kind: SHAPE.plane, c: [...plane.n], a: [0, 0, 0], radius: 0 }
  const s = probe!.shape
  const c: Vec3 = [s.center[0] - origin[0], s.center[1] - origin[1], s.center[2] - origin[2]]
  if (s.kind === 'sphere') return { kind: SHAPE.sphere, c, a: [0, 0, 0], radius: s.radius }
  return { kind: s.kind === 'flat' ? SHAPE.flat : SHAPE.rod, c, a: [...s.axis], radius: s.radius }
}

/**
 * 四面体的运动学：E = E₀ + ΔU·B（F = I + E），δ = J − 1，H = cof F，都按 E 展开写（见 plan.ts 文件头）。
 * 结果写进 k（长度 ≥ 28）：E[0..9]、H[9..18]、δ = k[18]、c2D = ‖F‖² + J² − 4J = k[19]。
 * The kinematics of a tetrahedron: E = E₀ + ΔU·B (F = I + E), δ = J − 1, H = cof F, all written as expansions in E
 * (see the header of plan.ts). Results go to k (length ≥ 28): E[0..9], H[9..18], δ = k[18], c2D = ‖F‖² + J² − 4J = k[19].
 */
export function kinematics(p: GpuPlan, u: Arr, t: number, k: Float64Array): void {
  const nd = p.tetNodes, B = p.tetB, E0 = p.tetE0
  const a = nd[t * 4]! * 4, b = nd[t * 4 + 1]! * 4, c = nd[t * 4 + 2]! * 4, d = nd[t * 4 + 3]! * 4
  // ΔU 的列 = u_k − u_0 / the columns of ΔU = u_k − u_0
  const d00 = u[b]! - u[a]!, d01 = u[c]! - u[a]!, d02 = u[d]! - u[a]!
  const d10 = u[b + 1]! - u[a + 1]!, d11 = u[c + 1]! - u[a + 1]!, d12 = u[d + 1]! - u[a + 1]!
  const d20 = u[b + 2]! - u[a + 2]!, d21 = u[c + 2]! - u[a + 2]!, d22 = u[d + 2]! - u[a + 2]!
  const o = t * 9
  const b00 = B[o]!, b01 = B[o + 1]!, b02 = B[o + 2]!, b10 = B[o + 3]!, b11 = B[o + 4]!, b12 = B[o + 5]!, b20 = B[o + 6]!, b21 = B[o + 7]!, b22 = B[o + 8]!
  const e00 = E0[o]! + d00 * b00 + d01 * b10 + d02 * b20, e01 = E0[o + 1]! + d00 * b01 + d01 * b11 + d02 * b21, e02 = E0[o + 2]! + d00 * b02 + d01 * b12 + d02 * b22
  const e10 = E0[o + 3]! + d10 * b00 + d11 * b10 + d12 * b20, e11 = E0[o + 4]! + d10 * b01 + d11 * b11 + d12 * b21, e12 = E0[o + 5]! + d10 * b02 + d11 * b12 + d12 * b22
  const e20 = E0[o + 6]! + d20 * b00 + d21 * b10 + d22 * b20, e21 = E0[o + 7]! + d20 * b01 + d21 * b11 + d22 * b21, e22 = E0[o + 8]! + d20 * b02 + d21 * b12 + d22 * b22
  // cof E / cof E
  const c00 = e11 * e22 - e12 * e21, c01 = e12 * e20 - e10 * e22, c02 = e10 * e21 - e11 * e20
  const c10 = e02 * e21 - e01 * e22, c11 = e00 * e22 - e02 * e20, c12 = e01 * e20 - e00 * e21
  const c20 = e01 * e12 - e02 * e11, c21 = e02 * e10 - e00 * e12, c22 = e00 * e11 - e01 * e10
  const t1 = e00 + e11 + e22
  const t2 = c00 + c11 + c22
  const t3 = e00 * c00 + e01 * c01 + e02 * c02
  const dl = t1 + t2 + t3
  // H = cof(I + E) = I + t1·I − Eᵀ + cof E / H = cof(I + E) = I + t1·I − Eᵀ + cof E
  k[0] = e00; k[1] = e01; k[2] = e02; k[3] = e10; k[4] = e11; k[5] = e12; k[6] = e20; k[7] = e21; k[8] = e22
  k[9] = 1 + t1 - e00 + c00; k[10] = -e10 + c01; k[11] = -e20 + c02
  k[12] = -e01 + c10; k[13] = 1 + t1 - e11 + c11; k[14] = -e21 + c12
  k[15] = -e02 + c20; k[16] = -e12 + c21; k[17] = 1 + t1 - e22 + c22
  k[18] = dl
  // ‖F‖² + J² − 4J = ‖E‖² − 2·t2 − 2·t3 + δ²（2·t1 和常数相消）/ (2·t1 and the constants cancel)
  k[19] = e00 * e00 + e01 * e01 + e02 * e02 + e10 * e10 + e11 * e11 + e12 * e12 + e20 * e20 + e21 * e21 + e22 * e22 - 2 * t2 - 2 * t3 + dl * dl
}

/** 角 c 的梯度 = M·(B 的第 c−1 行)ᵀ，角 0 = −其余之和；写进 g[0..12] / gradient of corner c = M·(row c−1 of B)ᵀ, corner 0 = −the others; into g[0..12] */
export function cornerGrads(p: GpuPlan, t: number, M: ArrayLike<number>, mo: number, g: Float64Array): void {
  const B = p.tetB, o = t * 9
  for (let r = 0; r < 3; r++) {
    const m0 = M[mo + r * 3]!, m1 = M[mo + r * 3 + 1]!, m2 = M[mo + r * 3 + 2]!
    const g1 = m0 * B[o]! + m1 * B[o + 1]! + m2 * B[o + 2]!
    const g2 = m0 * B[o + 3]! + m1 * B[o + 4]! + m2 * B[o + 5]!
    const g3 = m0 * B[o + 6]! + m1 * B[o + 7]! + m2 * B[o + 8]!
    g[3 + r] = g1
    g[6 + r] = g2
    g[9 + r] = g3
    g[r] = -g1 - g2 - g3
  }
}

export interface MirrorState {
  u: Arr
  v: Arr
  uprev: Arr
  pin: Arr
  acc: Arr
  P: Arr
  ev: Arr
  /** 四面体角上的压强力：Ta × 4 角 × 4（xyz、w 不用）/ the pressure force per tetrahedron corner: Ta × 4 corners × 4 (xyz, w unused) */
  tc: Arr
}

export function newState(p: GpuPlan, f32: boolean): MirrorState {
  const A = (n: number): Arr => (f32 ? new Float32Array(n) : new Float64Array(n))
  const N = p.nodeCount, T = p.tetCount
  return { u: A(N * 4), v: A(N * 4), uprev: A(N * 4), pin: A(N * 4), acc: A(N * 4), P: A(N), ev: A(T * 6), tc: A(T * 16) }
}

export interface Step {
  h: number
  keep: number
}

/** 内核 1（每个四面体）：上一步的结点压强作为力，分到四个角 / kernel 1 (per tetrahedron): the previous nodal pressures as forces, per corner */
export function kPressure(p: GpuPlan, s: MirrorState, t: number, k: Float64Array, g: Float64Array): void {
  const o = t * 16
  const qv = p.tetPar[t * 8 + 6]!
  let ks = 0
  for (let c = 0; c < 4; c++) {
    const n = p.tetNodes[t * 4 + c]!
    if (p.V[n]! > 1e-15) ks += s.P[n]! / p.V[n]!
  }
  const kk = ks * qv
  if (kk === 0) {
    for (let c = 0; c < 4; c++) s.tc[o + c * 4] = s.tc[o + c * 4 + 1] = s.tc[o + c * 4 + 2] = 0
    return
  }
  kinematics(p, s.u, t, k)
  cornerGrads(p, t, k, 9, g)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) s.tc[o + c * 4 + r] = kk * g[c * 3 + r]!
}

/** 内核 2（每个结点）：收压强力，预测位置 / kernel 2 (per node): gathers the pressure forces, predicts the position */
export function kPredict(p: GpuPlan, s: MirrorState, i: number, st: Step): void {
  let fx = 0, fy = 0, fz = 0
  if (p.nodal) for (let r = p.ringStart[i]!; r < p.ringStart[i + 1]!; r++) {
    const e = p.ringEntry[r]! * 4
    fx += s.tc[e]!
    fy += s.tc[e + 1]!
    fz += s.tc[e + 2]!
  }
  const o = i * 4, w = p.w[i]!
  s.uprev[o] = s.u[o]!
  s.uprev[o + 1] = s.u[o + 1]!
  s.uprev[o + 2] = s.u[o + 2]!
  if (w === 0) {
    s.u[o] = s.pin[o]!
    s.u[o + 1] = s.pin[o + 1]!
    s.u[o + 2] = s.pin[o + 2]!
    return
  }
  const vx = s.v[o]! * st.keep + st.h * (s.acc[o]! + fx * w)
  const vy = s.v[o + 1]! * st.keep + st.h * (s.acc[o + 1]! + fy * w)
  const vz = s.v[o + 2]! * st.keep + st.h * (s.acc[o + 2]! + fz * w)
  s.u[o] = s.u[o]! + st.h * vx
  s.u[o + 1] = s.u[o + 1]! + st.h * vy
  s.u[o + 2] = s.u[o + 2]! + st.h * vz
}

/**
 * 内核 3（每个四面体，一种颜色）：偏量、体积下限（或逐单元体积）、Maxwell 支路、纤维约束，逐条 Gauss–Seidel，
 * 每条都重新算形变（与 SoftSolver.solveTets 相同的顺序），直接改四个结点的位置。
 * Kernel 3 (per tetrahedron, one colour): the deviatoric, volume-floor (or per-tetrahedron volume), Maxwell and fibre
 * constraints, one Gauss–Seidel solve each, the deformation recomputed for each (the order of SoftSolver.solveTets),
 * moving the four nodes directly.
 */
export function kTet(p: GpuPlan, s: MirrorState, t: number, st: Step, k: Float64Array, g: Float64Array): void {
  const par = p.tetPar, po = t * 8
  const mu = par[po]!, la = par[po + 1]!, kap = par[po + 2]!, g1m = par[po + 3]!, tau = par[po + 4]!, fk = par[po + 5]!, qv = par[po + 6]!, vol = par[po + 7]!
  // q = 0 的四面体不参与（与 CPU 的 `if (qe === 0) continue` 相同；q·V_ref = 0 当且仅当 q = 0）
  // tetrahedra with q = 0 take no part (as `if (qe === 0) continue` on the CPU; q·V_ref = 0 exactly when q = 0)
  if (qv === 0) return
  const ih2 = 1 / (st.h * st.h), P = TP
  // 偏量 C_D：P = F + (J − 2)·H = E − (H − I) + δ·H / deviatoric C_D: P = F + (J − 2)·H = E − (H − I) + δ·H
  kinematics(p, s.u, t, k)
  let J = 1 + k[18]!
  if (mu > 0) {
    const c2 = k[19]!, dl = k[18]!
    if (c2 > 0) {
      for (let j = 0; j < 9; j++) P[j] = k[j]! - (k[9 + j]! - (j % 4 === 0 ? 1 : 0)) + dl * k[9 + j]!
      applyTet(p, s, t, P, c2, (c2 * ih2) / (mu * (1 + kap * c2) * vol), g)
    }
  }
  // 体积下限 / 逐单元体积 C_H：只在 λ·份额 > 0 或上一遍的 J ≤ 0.5 时 / the volume floor / per-tetrahedron C_H: only with λ·share > 0 or J ≤ 0.5 in the previous pass
  if (la > 0 || J <= 0.5) {
    kinematics(p, s.u, t, k)
    J = 1 + k[18]!
    let cc = 0, comp = 0, use = true
    if (J < J_MIN) cc = J - J_MIN
    else if (la > 0) {
      cc = k[18]!
      comp = ih2 / (la * vol)
      if (cc === 0) use = false
    } else use = false
    if (use) {
      for (let j = 0; j < 9; j++) P[j] = k[9 + j]!
      applyTet(p, s, t, P, cc, comp, g)
    }
  }
  // Maxwell 支路：Q = dev E_G − E_v，E_G = (E + Eᵀ + EᵀE)/2 / the Maxwell branch: Q = dev E_G − E_v, E_G = (E + Eᵀ + EᵀE)/2
  if (g1m > 0) {
    kinematics(p, s.u, t, k)
    const e = k
    const s00 = e[0]! + 0.5 * (e[0]! * e[0]! + e[3]! * e[3]! + e[6]! * e[6]!)
    const s11 = e[4]! + 0.5 * (e[1]! * e[1]! + e[4]! * e[4]! + e[7]! * e[7]!)
    const s22 = e[8]! + 0.5 * (e[2]! * e[2]! + e[5]! * e[5]! + e[8]! * e[8]!)
    const s01 = 0.5 * (e[1]! + e[3]! + e[0]! * e[1]! + e[3]! * e[4]! + e[6]! * e[7]!)
    const s02 = 0.5 * (e[2]! + e[6]! + e[0]! * e[2]! + e[3]! * e[5]! + e[6]! * e[8]!)
    const s12 = 0.5 * (e[5]! + e[7]! + e[1]! * e[2]! + e[4]! * e[5]! + e[7]! * e[8]!)
    const tr = (s00 + s11 + s22) / 3, o6 = t * 6, Ev = s.ev
    const q00 = s00 - tr - Ev[o6]!, q11 = s11 - tr - Ev[o6 + 1]!, q22 = s22 - tr - Ev[o6 + 2]!, q01 = s01 - Ev[o6 + 3]!, q02 = s02 - Ev[o6 + 4]!, q12 = s12 - Ev[o6 + 5]!
    const kr = 1 - Math.exp(-st.h / tau)
    Ev[o6] = Ev[o6]! + kr * q00; Ev[o6 + 1] = Ev[o6 + 1]! + kr * q11; Ev[o6 + 2] = Ev[o6 + 2]! + kr * q22
    Ev[o6 + 3] = Ev[o6 + 3]! + kr * q01; Ev[o6 + 4] = Ev[o6 + 4]! + kr * q02; Ev[o6 + 5] = Ev[o6 + 5]! + kr * q12
    const cq = q00 * q00 + q11 * q11 + q22 * q22 + 2 * (q01 * q01 + q02 * q02 + q12 * q12)
    if (cq > 1e-24) {
      // P = F·Q = Q + E·Q / P = F·Q = Q + E·Q
      P[0] = q00 + e[0]! * q00 + e[1]! * q01 + e[2]! * q02; P[1] = q01 + e[0]! * q01 + e[1]! * q11 + e[2]! * q12; P[2] = q02 + e[0]! * q02 + e[1]! * q12 + e[2]! * q22
      P[3] = q01 + e[3]! * q00 + e[4]! * q01 + e[5]! * q02; P[4] = q11 + e[3]! * q01 + e[4]! * q11 + e[5]! * q12; P[5] = q12 + e[3]! * q02 + e[4]! * q12 + e[5]! * q22
      P[6] = q02 + e[6]! * q00 + e[7]! * q01 + e[8]! * q02; P[7] = q12 + e[6]! * q01 + e[7]! * q11 + e[8]! * q12; P[8] = q22 + e[6]! * q02 + e[7]! * q12 + e[8]! * q22
      applyTet(p, s, t, P, cq, (cq * ih2) / (2 * g1m * vol), g)
    }
  }
  // 纤维 C_f = ‖F·d‖ − 1，F·d = d + E·d / the fibre: C_f = ‖F·d‖ − 1, F·d = d + E·d
  if (fk > 0) {
    const f = p.tetFib, fo = t * 4
    const ddx = f[fo]!, ddy = f[fo + 1]!, ddz = f[fo + 2]!
    if (ddx !== 0 || ddy !== 0 || ddz !== 0) {
      kinematics(p, s.u, t, k)
      const B = p.tetB, bo = t * 9
      const s1 = B[bo]! * ddx + B[bo + 1]! * ddy + B[bo + 2]! * ddz, s2 = B[bo + 3]! * ddx + B[bo + 4]! * ddy + B[bo + 5]! * ddz, s3 = B[bo + 6]! * ddx + B[bo + 7]! * ddy + B[bo + 8]! * ddz
      const ex = k[0]! * ddx + k[1]! * ddy + k[2]! * ddz, ey = k[3]! * ddx + k[4]! * ddy + k[5]! * ddz, ez = k[6]! * ddx + k[7]! * ddy + k[8]! * ddz
      let ux = ddx + ex, uy = ddy + ey, uz = ddz + ez
      const len = Math.sqrt(ux * ux + uy * uy + uz * uz)
      if (len > 1e-12) {
        // ‖F·d‖ − 1 = (2·d·Ed + ‖Ed‖² + ‖d‖² − 1)/(‖F·d‖ + 1)：没有 1 − 1 的相消 / without the 1 − 1 cancellation
        const cf = (2 * (ddx * ex + ddy * ey + ddz * ez) + ex * ex + ey * ey + ez * ez + (ddx * ddx + ddy * ddy + ddz * ddz - 1)) / (len + 1)
        ux /= len
        uy /= len
        uz /= len
        const nd = p.tetNodes, w = p.w, u = s.u
        const n0 = nd[t * 4]!, n1 = nd[t * 4 + 1]!, n2 = nd[t * 4 + 2]!, n3 = nd[t * 4 + 3]!
        const w0 = w[n0]!, w1 = w[n1]!, w2 = w[n2]!, w3 = w[n3]!
        const s0 = -s1 - s2 - s3
        const ws = w0 * s0 * s0 + w1 * s1 * s1 + w2 * s2 * s2 + w3 * s3 * s3
        const l = -cf / (ws + ih2 / (fk * vol))
        const add = (n: number, c: number): void => {
          u[n * 4] = u[n * 4]! + c * ux
          u[n * 4 + 1] = u[n * 4 + 1]! + c * uy
          u[n * 4 + 2] = u[n * 4 + 2]! + c * uz
        }
        add(n0, w0 * s0 * l)
        add(n1, w1 * s1 * l)
        add(n2, w2 * s2 * l)
        add(n3, w3 * s3 * l)
      }
    }
  }
}

const TP = new Float64Array(9)

/** 一条四面体约束的 Gauss–Seidel 解：Δλ = −C / (Σ w·‖g‖² + α̃)，Δx_k = w_k·Δλ·g_k / the Gauss–Seidel solve of one tetrahedron constraint */
function applyTet(p: GpuPlan, s: MirrorState, t: number, P: Float64Array, c2: number, comp: number, g: Float64Array): void {
  cornerGrads(p, t, P, 0, g)
  const nd = p.tetNodes, u = s.u
  let den = comp
  for (let c = 0; c < 4; c++) den += p.w[nd[t * 4 + c]!]! * (g[c * 3]! * g[c * 3]! + g[c * 3 + 1]! * g[c * 3 + 1]! + g[c * 3 + 2]! * g[c * 3 + 2]!)
  if (!(den > 0)) return
  const l = -c2 / den
  for (let c = 0; c < 4; c++) {
    const n = nd[t * 4 + c]!, wl = p.w[n]! * l
    u[n * 4] = u[n * 4]! + wl * g[c * 3]!
    u[n * 4 + 1] = u[n * 4 + 1]! + wl * g[c * 3 + 1]!
    u[n * 4 + 2] = u[n * 4 + 2]! + wl * g[c * 3 + 2]!
  }
}

/**
 * 内核 4（每个结点，一种颜色）：结点体积约束（solver.ts 文件头第 1、2 条），一次 Gauss–Seidel：由一环的四面体算出
 * C_n 和对一环各结点的梯度（g_j = Σ q·V_ref·H·b），更新压强乘子，直接改一环结点的位置。
 * Kernel 4 (per node, one colour): the nodal volume constraint (header items 1 and 2 of solver.ts), one Gauss–Seidel
 * solve: C_n and the gradient on each one-ring node (g_j = Σ q·V_ref·H·b) from the ring's tetrahedra, the pressure
 * multiplier updated, the one-ring nodes moved directly.
 */
export function kVolume(p: GpuPlan, s: MirrorState, n: number, st: Step, k: Float64Array, g: Float64Array, gacc: Float64Array): void {
  const from = p.ringStart[n]!, to = p.ringStart[n + 1]!
  const K = p.K[n]!, Vn = p.V[n]!
  if (!p.nodal || from === to || !(K > 0) || !(Vn > 1e-15)) return
  const nb0 = p.nbrStart[n]!, cnt = p.nbrStart[n + 1]! - nb0
  gacc.fill(0, 0, cnt * 3)
  let S = 0
  for (let r = from; r < to; r++) {
    const t = p.ringEntry[r]! >> 2, sl = p.ringSlots[r]!, qv = p.tetPar[t * 8 + 6]!
    kinematics(p, s.u, t, k)
    cornerGrads(p, t, k, 9, g)
    S += qv * k[18]!
    for (let c = 0; c < 4; c++) {
      const j = (sl >>> (8 * c)) & 255
      gacc[j * 3] = gacc[j * 3]! + qv * g[c * 3]!
      gacc[j * 3 + 1] = gacc[j * 3 + 1]! + qv * g[c * 3 + 1]!
      gacc[j * 3 + 2] = gacc[j * 3 + 2]! + qv * g[c * 3 + 2]!
    }
  }
  const iv = 1 / Vn
  let A = 0
  for (let j = 0; j < cnt; j++) {
    const m = p.w[p.nbr[nb0 + j]!]!
    A += m * (gacc[j * 3]! * gacc[j * 3]! + gacc[j * 3 + 1]! * gacc[j * 3 + 1]! + gacc[j * 3 + 2]! * gacc[j * 3 + 2]!)
  }
  A *= iv * iv
  if (!(A > 0)) return
  const h2 = st.h * st.h, ih2 = 1 / h2
  const alpha = Math.max(ih2 / K, A / p.volumeCap)
  const Pn = s.P[n]!
  const dl = -(S * iv + alpha * Pn * h2) / (A + alpha)
  const lim = 1.5 * K
  let pn = Pn + dl * ih2
  if (pn > lim) pn = lim
  else if (pn < -lim) pn = -lim
  const sc = (pn - Pn) * h2 * iv
  s.P[n] = pn
  for (let j = 0; j < cnt; j++) {
    const i = p.nbr[nb0 + j]!, f = p.w[i]! * sc
    s.u[i * 4] = s.u[i * 4]! + f * gacc[j * 3]!
    s.u[i * 4 + 1] = s.u[i * 4 + 1]! + f * gacc[j * 3 + 1]!
    s.u[i * 4 + 2] = s.u[i * 4 + 2]! + f * gacc[j * 3 + 2]!
  }
}

/** 一组点约束每个点的输出：一帧里累计的 Δλ/h²（法向力）和力向量 / per-point output of a point set: Δλ/h² (normal force) and force vector accumulated over a frame */
export interface PointOut {
  f: Arr
  fv: Arr
}

export function newPointOut(count: number, f32: boolean): PointOut {
  const A = (n: number): Arr => (f32 ? new Float32Array(n) : new Float64Array(n))
  return { f: A(count), fv: A(count * 4) }
}

/**
 * 内核 6（每组点，一种颜色）：组里的点（同一个四面体）按原来的顺序逐个 Gauss–Seidel（SoftSolver.pushPoint）。
 * Kernel 6 (per group of points, one colour): the points of the group (one tetrahedron) one by one in their original
 * order, Gauss–Seidel (SoftSolver.pushPoint).
 */
export function kPointGroup(p: GpuPlan, s: MirrorState, set: ContactPlan, out: PointOut, grp: number, shapes: ShapeParams[], st: Step): void {
  for (let q = set.groupStart[grp]!; q < set.groupStart[grp + 1]!; q++) {
    const i = set.order[q]!
    kPoint(p, s, set, out, i, set.kind[i]!, shapes[set.shape[i]!]!, st)
  }
}

function kPoint(p: GpuPlan, s: MirrorState, set: ContactPlan, out: PointOut, i: number, kind: number, shape: ShapeParams, st: Step): void {
  const nd = set.nodes, bw = set.bary, u = s.u
  let qx = 0, qy = 0, qz = 0
  for (let k = 0; k < 4; k++) {
    const n = nd[i * 4 + k]!, b = bw[i * 4 + k]!
    qx += b * u[n * 4]!
    qy += b * u[n * 4 + 1]!
    qz += b * u[n * 4 + 2]!
  }
  let c = 0, nx = 0, ny = 0, nz = 0, alpha = 0
  if (kind === 0) {
    // 锚点：目标是参考位置，所以 C = −Σ b·u / anchor: the target is the reference position, so C = −Σ b·u
    const ik = set.invK[i]!
    if (ik < 0) return
    const l = Math.sqrt(qx * qx + qy * qy + qz * qz)
    if (!(l > 0)) return
    c = l
    nx = -qx / l
    ny = -qy / l
    nz = -qz / l
    alpha = ik / (st.h * st.h)
  } else if (kind === 4) {
    // 支撑面：C = d − n·q = −(base + n·Σ b·u) / plane
    c = -(set.base[i * 4]! + shape.c[0] * qx + shape.c[1] * qy + shape.c[2] * qz)
    if (!(c > 0)) return
    nx = shape.c[0]
    ny = shape.c[1]
    nz = shape.c[2]
  } else {
    const rx = set.base[i * 4]! + qx - shape.c[0], ry = set.base[i * 4 + 1]! + qy - shape.c[1], rz = set.base[i * 4 + 2]! + qz - shape.c[2]
    const ax = shape.a[0], ay = shape.a[1], az = shape.a[2], R = shape.radius
    const along = rx * ax + ry * ay + rz * az
    if (kind === 3 && along < 0) {
      if (along < -6 * R) return
      const ox = rx - along * ax, oy = ry - along * ay, oz = rz - along * az
      const l = Math.sqrt(ox * ox + oy * oy + oz * oz)
      if (l >= R || l < 1e-12) return
      c = R - l
      nx = ox / l
      ny = oy / l
      nz = oz / l
    } else if (kind === 1 || kind === 3) {
      const l = Math.sqrt(rx * rx + ry * ry + rz * rz)
      if (l >= R || l < 1e-12) return
      c = R - l
      nx = rx / l
      ny = ry / l
      nz = rz / l
    } else {
      if (along >= 0 || along < -4 * R) return
      const ox = rx - along * ax, oy = ry - along * ay, oz = rz - along * az
      if (ox * ox + oy * oy + oz * oz >= R * R) return
      c = -along
      nx = ax
      ny = ay
      nz = az
    }
  }
  let ws = 0
  for (let k = 0; k < 4; k++) {
    const b = bw[i * 4 + k]!
    ws += p.w[nd[i * 4 + k]!]! * b * b
  }
  if (!(ws > 0)) return
  const dl = c / (ws + alpha)
  for (let k = 0; k < 4; k++) {
    const n = nd[i * 4 + k]!, f = p.w[n]! * bw[i * 4 + k]! * dl
    u[n * 4] = u[n * 4]! + f * nx
    u[n * 4 + 1] = u[n * 4 + 1]! + f * ny
    u[n * 4 + 2] = u[n * 4 + 2]! + f * nz
  }
  const f = dl / (st.h * st.h)
  out.f[i] = out.f[i]! + f
  out.fv[i * 4] = out.fv[i * 4]! - f * nx
  out.fv[i * 4 + 1] = out.fv[i * 4 + 1]! - f * ny
  out.fv[i * 4 + 2] = out.fv[i * 4 + 2]! - f * nz
}

/** 内核 8（每个结点）：骨的胶囊（按胶囊的顺序逐个投影，与 CPU 相同），然后速度 = (u − u_prev)/h / kernel 8 (per node): the bone capsules (projected one by one in capsule order, as on the CPU), then velocity = (u − u_prev)/h */
export function kFinish(p: GpuPlan, s: MirrorState, i: number, st: Step): void {
  const o = i * 4
  for (let r = p.capStart[i]!; r < p.capStart[i + 1]!; r++) {
    const c = p.capData, q = r * CAP_STRIDE
    const px = c[q]! + s.u[o]!, py = c[q + 1]! + s.u[o + 1]!, pz = c[q + 2]! + s.u[o + 2]!
    const abx = c[q + 3]!, aby = c[q + 4]!, abz = c[q + 5]!, l2 = c[q + 6]!, lim = c[q + 7]!
    const t = Math.min(1, Math.max(0, (px * abx + py * aby + pz * abz) / l2))
    const rx = px - t * abx, ry = py - t * aby, rz = pz - t * abz
    const dist = Math.sqrt(rx * rx + ry * ry + rz * rz)
    if (dist >= lim || dist < 1e-9) continue
    const k = (lim - dist) / dist
    s.u[o] = s.u[o]! + rx * k
    s.u[o + 1] = s.u[o + 1]! + ry * k
    s.u[o + 2] = s.u[o + 2]! + rz * k
  }
  const ih = 1 / st.h
  s.v[o] = (s.u[o]! - s.uprev[o]!) * ih
  s.v[o + 1] = (s.u[o + 1]! - s.uprev[o + 1]!) * ih
  s.v[o + 2] = (s.u[o + 2]! - s.uprev[o + 2]!) * ih
}

/** 一个子步：内核和颜色的顺序与 gpu.ts 的派发顺序相同 / One substep: kernels and colours in the order gpu.ts dispatches them */
export function substep(p: GpuPlan, s: MirrorState, st: Step, contacts: { set: ContactPlan; out: PointOut; shapes: ShapeParams[] } | null, work: { k: Float64Array; g: Float64Array; gacc: Float64Array }): void {
  const N = p.nodeCount, T = p.tetCount
  if (p.nodal) for (let t = 0; t < T; t++) kPressure(p, s, t, work.k, work.g)
  for (let i = 0; i < N; i++) kPredict(p, s, i, st)
  const ts = p.tetSched
  for (let c = 0; c + 1 < ts.colourStart.length; c++) for (let q = ts.colourStart[c]!; q < ts.colourStart[c + 1]!; q++) kTet(p, s, ts.order[q]!, st, work.k, work.g)
  if (p.nodal) {
    const vs = p.volSched
    for (let c = 0; c + 1 < vs.colourStart.length; c++) for (let q = vs.colourStart[c]!; q < vs.colourStart[c + 1]!; q++) kVolume(p, s, vs.order[q]!, st, work.k, work.g, work.gacc)
  }
  if (contacts) {
    const cs = contacts.set.colourStart
    for (let c = 0; c + 1 < cs.length; c++) for (let g = cs[c]!; g < cs[c + 1]!; g++) kPointGroup(p, s, contacts.set, contacts.out, g, contacts.shapes, st)
  }
  for (let i = 0; i < N; i++) kFinish(p, s, i, st)
}

export function work(): { k: Float64Array; g: Float64Array; gacc: Float64Array } {
  return { k: new Float64Array(28), g: new Float64Array(12), gacc: new Float64Array(MAX_RING_NODES * 3) }
}

export type { PointSet }
