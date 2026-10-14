// 按压工具的接口：在一个部位用一个压头压到给定的深度或给定的力，返回深度、力、接触压强和沿深度的应变。
// The interface of the pressing tool: press a probe at a site to a given depth or a given force and get depth, force,
// contact pressure and the strain along the depth.
//
//     press(domain, probe, { depthMm } | { forceN }) → { depthMm, forceN, meanPressureKPa, peakPressureKPa,
//                                                        contactAreaMm2, strainAtDepth(zMm), valid, flags, … }
//
// 两级求解 / Two levels
//   全身的粗笼子（27 mm）分辨不了一个压头：这里在压入点周围另建一块细笼子（单元 ≈ 压头半径的三分之一），
//   它的切口结点跟随粗笼子的位移（`couple`：把细笼子算出的反力加到粗笼子上，粗笼子给出远场位移，再回到细笼子，
//   交替一两次）。细笼子由 tools/softbody/site.ts 按需建（需要部件的网格）。
//   The coarse whole-body cage (27 mm) cannot resolve a probe: a fine cage (cell ≈ a third of the probe radius) is
//   built round the site, whose cut nodes follow the displacement of the coarse cage (`couple`: the reaction found on
//   the fine cage is applied to the coarse one, the coarse one returns the far-field displacement, and back, once or
//   twice). The fine cage is built on demand by tools/softbody/site.ts (it needs the part meshes).
//
// 准静态 / Quasi-static
//   这里只要平衡态，与质量无关，所以把密度放大到体积约束的刚度比不超过上限（"质量缩放"），用很少的子步走到平衡。
//   Only the equilibrium is wanted and it does not depend on mass, so density is scaled up until the stiffness ratio
//   of the volume constraints is within its bound ("mass scaling") and equilibrium is reached with few substeps.
//
// 平头压头的边缘补偿 / Edge compensation of a flat punch
//   线性单元表示不了压头边缘处的折角：边缘外侧的结点也被压下去，等效半径变大，力偏大，而且是单元尺寸的一阶误差
//   （tools/softbody/numerics.ts 的解析算例：单元 = a/2 时偏大约 30%）。这里把参与接触的半径缩小
//   EDGE_COMPENSATION × 单元边长；这个系数是在半空间解析解上标定的，不是推导出来的，结果里有标记。
//   Linear elements cannot represent the kink at the edge of a punch: nodes just outside it are pushed down too, the
//   effective radius grows and the force is too large, with an error of first order in the cell (analytic case in
//   tools/softbody/numerics.ts: about 30 % too much at cell = a/2). The radius that takes part in contact is reduced
//   by EDGE_COMPENSATION × cell; the coefficient is calibrated on the half-space solution, not derived, and the result
//   says so.

import { type PointSet, type SoftSolver, type Vec3 } from './solver.ts'

export const EDGE_COMPENSATION = 0.25

export interface PressProbe {
  /**
   * 'flat' = 平头圆柱；'sphere' = 球；'hemisphere' = 半球头的圆杆（压入超过半径时杆身也接触）；'plate' = 平板：半径为 radiusMm 的圆板，
   * 比接触区大，没有边缘补偿（板的边不压到组织上）。
   * 'flat' = flat-ended cylinder; 'sphere' = a ball; 'hemisphere' = a rod with a hemispherical tip (its shaft touches
   * too once the depth exceeds the radius); 'plate' = a flat plate: a disc of radius radiusMm larger than the contact,
   * without edge compensation (the plate's edge does not bear on the tissue).
   */
  kind: 'flat' | 'sphere' | 'hemisphere' | 'plate'
  radiusMm: number
}

export type PressRequest = { depthMm: number } | { forceN: number }

export interface PressDomain {
  solver: SoftSolver
  /** 单元边长，米 / cell edge, metres */
  cell: number
  /** 压入点（静止空间，皮肤上）和压入方向（单位向量，指向体内）/ the site (rest space, on the skin) and the pressing direction (unit, into the body) */
  site: Vec3
  inward: Vec3
  /** 压入点周围皮肤上的采样点：嵌入、各自的面积（m²）和静止位置 / samples on the skin round the site: embedding, area (m²) and rest position of each */
  samples: { points: PointSet; area: Float32Array; positions: Float32Array }
  /** 任意静止空间点的嵌入 / embedding of arbitrary rest-space points */
  embed(positions: ArrayLike<number>): PointSet & { inside: Uint8Array }
  /** 压入点下方软组织的厚度（到骨），米；不知道就省略 / thickness of soft tissue under the site (down to bone), metres; omitted when unknown */
  thickness?: number
}

export interface PressOptions {
  /** 每一级最多多少帧 / frame cap per stage */
  maxFrames?: number
  /** 力的相对变化低于它算稳定 / the force is steady once its relative change is below this */
  tolerance?: number
  /** false = 不做平头压头的边缘补偿 / false = no edge compensation of a flat punch */
  edgeCompensation?: boolean
  /** 已验证的平均接触压强上限，千帕（超过则结果带标记）/ the largest mean contact pressure covered by validation, kPa (beyond it the result is flagged) */
  validatedPressureKPa?: number
  /** 模型可信的最大压应变 / the largest compressive strain the model is credible for */
  validatedStrain?: number
}

export interface PressResult {
  depthMm: number
  forceN: number
  /** 力 ÷ 接触面积 / force ÷ contact area */
  meanPressureKPa: number
  /** 结点上接触压强的最大值（分辨率一个单元）/ the largest contact pressure at a node (resolution: one cell) */
  peakPressureKPa: number
  contactAreaMm2: number
  /** 压头轴线上、原表面以下 z 毫米处沿轴向的压应变（正 = 压缩）/ compressive strain along the axis at z mm below the original surface (positive = compression) */
  strainAtDepth(zMm: number): number
  /** 轴线上的最大压应变 / the largest compressive strain on the axis */
  peakStrain: number
  /** 压强沿半径的分布（按结点），千帕 / the radial pressure profile (by node), kPa */
  pressureProfile: { rMm: number; kPa: number }[]
  /** false = 结果在验证过的范围之外或数值上不可靠；原因在 flags 里 / false = outside the validated range or numerically unreliable; the reasons are in `flags` */
  valid: boolean
  flags: string[]
  cellMm: number
  /** 平头压头参与接触的半径被缩小了多少，毫米 / by how much the contact radius of a flat punch was reduced, mm */
  edgeCompensationMm: number
  frames: number
  converged: boolean
}

/** 皮肤三角形细分出的接触采样点（重心，带面积）。 Contact samples from subdivided skin triangles (centroids with their areas). */
export function surfaceSamples(positions: ArrayLike<number>, indices: ArrayLike<number>, centre: Vec3, radius: number, spacing: number): { positions: Float32Array; area: Float32Array } {
  const p = positions, idx = indices
  const pos: number[] = [], area: number[] = []
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, d = idx[t + 2]! * 3
    const cx = (p[a]! + p[b]! + p[d]!) / 3, cy = (p[a + 1]! + p[b + 1]! + p[d + 1]!) / 3, cz = (p[a + 2]! + p[b + 2]! + p[d + 2]!) / 3
    const e = Math.max(Math.hypot(p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!), Math.hypot(p[d]! - p[a]!, p[d + 1]! - p[a + 1]!, p[d + 2]! - p[a + 2]!), Math.hypot(p[d]! - p[b]!, p[d + 1]! - p[b + 1]!, p[d + 2]! - p[b + 2]!))
    if (Math.hypot(cx - centre[0], cy - centre[1], cz - centre[2]) > radius + e) continue
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!, vx = p[d]! - p[a]!, vy = p[d + 1]! - p[a + 1]!, vz = p[d + 2]! - p[a + 2]!
    const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
    const k = Math.max(1, Math.ceil(e / spacing))
    // k² 个小三角形的重心 / the centroids of the k² pieces
    for (let i = 0; i < k; i++) for (let j = 0; j < k - i; j++) for (let up = 0; up < 2; up++) {
      if (up && j >= k - i - 1) continue
      const s = (i + (up ? 2 : 1) / 3) / k, r = (j + (up ? 2 : 1) / 3) / k
      const x = p[a]! + ux * s + vx * r, y = p[a + 1]! + uy * s + vy * r, z = p[a + 2]! + uz * s + vz * r
      if (Math.hypot(x - centre[0], y - centre[1], z - centre[2]) > radius) continue
      pos.push(x, y, z)
      area.push(ar / (k * k))
    }
  }
  return { positions: Float32Array.from(pos), area: Float32Array.from(area) }
}

/**
 * 质量缩放：返回密度应乘的倍数，使 h²·λ·(4/3)/(ρ·cell²) 不超过 `ratio`。
 * Mass scaling: the factor on density that keeps h²·λ·(4/3)/(ρ·cell²) within `ratio`.
 */
export function massScale(lambdaMax: number, density: number, cell: number, h: number, ratio = 1): number {
  return Math.max(1, (h * h * lambdaMax * (4 / 3)) / (density * cell * cell * ratio))
}

export function press(d: PressDomain, probe: PressProbe, request: PressRequest, o: PressOptions = {}): PressResult {
  const s = d.solver, a = probe.radiusMm * 1e-3
  const n = d.inward, site = d.site
  const flat = probe.kind === 'flat' || probe.kind === 'plate'
  const comp = probe.kind === 'flat' && o.edgeCompensation !== false ? Math.min(EDGE_COMPENSATION * d.cell, 0.4 * a) : 0
  const centre = (depth: number): Vec3 => {
    const off = flat ? depth : depth - a
    return [site[0] + n[0] * off, site[1] + n[1] * off, site[2] + n[2] * off]
  }
  s.probe = { shape: flat ? { kind: 'flat', center: centre(0), axis: [...n], radius: a - comp } : probe.kind === 'hemisphere' ? { kind: 'rod', center: centre(0), axis: [...n], radius: a } : { kind: 'sphere', center: centre(0), radius: a }, points: d.samples.points }
  const DT = 1 / 60, tol = o.tolerance ?? 1e-3, cap = o.maxFrames ?? 400
  let frames = 0, converged = true, bottomed = false
  const force = (): number => -(s.probeForce[0] * n[0] + s.probeForce[1] * n[1] + s.probeForce[2] * n[2])
  // 压头每帧最多前进 0.15 个单元：一步跨过一整个单元会把表层单元直接压翻
  // the probe advances at most 0.15 of a cell per frame: crossing a whole cell at one blow would turn the surface elements inside out
  let at = 0
  const settle = (depth: number): number => {
    let prev = -1, f = 0, ok = false
    const pace = 0.15 * d.cell
    const ramp = Math.ceil(Math.abs(depth - at) / pace)
    for (let i = 1; i <= cap + ramp; i++) {
      at += Math.max(-pace, Math.min(pace, depth - at))
      const c = centre(at)
      for (let k = 0; k < 3; k++) s.probe!.shape.center[k] = c[k]!
      s.step(DT)
      frames++
      f = force()
      if (i > ramp && (i - ramp) % 10 === 0) {
        if (Math.abs(f - prev) <= tol * Math.max(1e-4, Math.abs(f))) {
          ok = true
          break
        }
        prev = f
      }
    }
    if (!ok) converged = false
    return f
  }
  // ── 轴线上的位移和应变：应变 = −du/dz（u 是沿压入方向的位移，表面最大，向深处减小）
  // displacement and strain on the axis: strain = −du/dz (u is the displacement along the pressing direction, largest at the surface)
  const step = d.cell / 2, reach = Math.min(d.thickness ?? Infinity, Math.max(8 * a, 12 * d.cell))
  const count = Math.max(2, Math.floor(reach / step))
  const line = new Float32Array(count * 3)
  for (let k = 0; k < count; k++) for (let r = 0; r < 3; r++) line[k * 3 + r] = site[r]! + n[r]! * (k + 0.5) * step
  const em = d.embed(line)
  const axis = (): Float64Array => {
    const u = new Float64Array(count)
    let last = 0
    for (let k = 0; k < count; k++) {
      if (!em.inside[k]) {
        u[k] = last
        continue
      }
      let v = 0
      for (let j = 0; j < 4; j++) {
        const node = s.tets[em.tet[k]! * 4 + j]! * 3, w = em.bary[k * 4 + j]!
        v += w * ((s.x[node]! - s.ref[node]!) * n[0] + (s.x[node + 1]! - s.ref[node + 1]!) * n[1] + (s.x[node + 2]! - s.ref[node + 2]!) * n[2])
      }
      u[k] = last = v
    }
    return u
  }
  const axisPeak = (u: Float64Array): number => {
    let m = 0
    for (let k = 0; k < count - 1; k++) m = Math.max(m, -(u[k + 1]! - u[k]!) / step)
    return m
  }
  // 压应变超过这个值就不再加深：再往下单元会失稳翻转，力没有意义 / no deeper once the compressive strain passes this: beyond it elements buckle and invert and the force means nothing
  const CRUSH = 0.6
  let depth: number, f: number
  if ('depthMm' in request) {
    depth = request.depthMm * 1e-3
    f = settle(depth)
    if (!Number.isFinite(f)) {
      // 求解发散（压应变远超模型范围时会发生）：状态清零，结果带 not-finite 标记，后面的调用不受影响
      // the solve diverged (it can, far beyond the strain range of the model): the state is cleared, the result carries `not-finite`, and later calls are unaffected
      s.reset()
      at = 0
    }
  } else {
    // 力控：先压到一个小深度量出刚度，再按割线法调整深度 / force control: a small first depth gives the stiffness, then the depth follows the secant
    const target = request.forceN
    // 最深压到组织厚度的 85%：再深就是把组织压穿到骨面，模型没有意义 / never deeper than 85 % of the tissue thickness: beyond that the tissue is crushed onto bone and the model means nothing
    const limit = (d.thickness ?? Infinity) * 0.85
    let d0 = 0, f0 = 0
    depth = Math.min(0.25 * a, 0.002)
    f = settle(depth)
    for (let it = 0; it < 12 && Math.abs(f - target) > 0.01 * target; it++) {
      const slope = Math.max(1e-6, (f - f0) / (depth - d0))
      d0 = depth
      f0 = f
      // 步长有限制：深度一次最多增加 60%，也不超过厚度的 95% / the step is limited: at most 60 % deeper at once and never beyond 95 % of the thickness
      let next = depth + (target - f) / slope
      next = Math.min(next, depth * 1.6 + 1e-4, limit)
      next = Math.max(next, depth * 0.5)
      if (Math.abs(next - depth) < 1e-6) break
      depth = next
      f = settle(depth)
      if (!Number.isFinite(f) || axisPeak(axis()) > CRUSH || (depth > d0 && f < 0.7 * f0)) {
        // 压溃：退回上一个深度，报告那里的力 / crushed: back to the previous depth, whose force is reported
        s.reset()
        at = 0
        depth = d0
        f = settle(depth)
        bottomed = true
        break
      }
    }
    if (Math.abs(f - target) > 0.03 * target) {
      if (depth >= limit * 0.999) bottomed = true
      else if (!bottomed) converged = false
    }
  }

  // ── 接触面积和接触压强 / contact area and contact pressure ──
  const m = d.samples.area.length, pf = s.probePointForce
  let area = 0
  const q = [0, 0, 0], c = s.probe.shape.center
  const touching = new Uint8Array(m), radial = new Float32Array(m)
  for (let i = 0; i < m; i++) {
    s.pointPosition(d.samples.points, i, q)
    const rx = q[0]! - c[0], ry = q[1]! - c[1], rz = q[2]! - c[2]
    const along = rx * n[0] + ry * n[1] + rz * n[2]
    const off = Math.hypot(rx - along * n[0], ry - along * n[1], rz - along * n[2])
    radial[i] = off
    // 贴在压头表面上的采样点（半径的 1.5% 以内，至少 0.1 mm）/ samples lying on the probe surface (within 1.5 % of the radius, at least 0.1 mm)
    const gap = flat ? (off < a ? along : Infinity) : probe.kind === 'hemisphere' && along < 0 ? off - a : Math.hypot(rx, ry, rz) - a
    if (gap < Math.max(1e-4, 0.015 * a)) (touching[i] = 1), (area += d.samples.area[i]!)
  }
  // 各采样点的力不唯一（一个四面体里有许多采样点，约束是冗余的，Gauss–Seidel 的顺序决定力落在哪个点上），但分到结点上的
  // 合力唯一（等于结点处的弹性力）：压强按结点算 = Σ bₖ·fᵢ / Σ bₖ·Aᵢ，分辨率就是一个单元。
  // The force of an individual sample is not unique (many samples share a tetrahedron, the constraints are redundant and
  // the Gauss–Seidel order decides which sample carries it), but the force gathered on a node is (it equals the elastic
  // force there): pressure is computed per node, Σ bₖ·fᵢ / Σ bₖ·Aᵢ, at the resolution of one cell.
  const pts = d.samples.points, nodeF = new Map<number, number>(), nodeA = new Map<number, number>(), nodeT = new Map<number, number>(), nodeR = new Map<number, number>()
  for (let i = 0; i < m; i++) {
    const ai = d.samples.area[i]!
    for (let k = 0; k < 4; k++) {
      const b = pts.bary[i * 4 + k]!
      if (!(b > 0)) continue
      const node = s.tets[pts.tet[i]! * 4 + k]!
      nodeF.set(node, (nodeF.get(node) ?? 0) + b * pf[i]!)
      nodeA.set(node, (nodeA.get(node) ?? 0) + b * ai)
      nodeT.set(node, (nodeT.get(node) ?? 0) + (touching[i] ? b * ai : 0))
      nodeR.set(node, (nodeR.get(node) ?? 0) + b * ai * radial[i]!)
    }
  }
  let aMax = 0
  for (const v of nodeA.values()) aMax = Math.max(aMax, v)
  let peak = 0
  const bins = 8, sum = new Float64Array(bins), cnt = new Float64Array(bins)
  for (const [node, an] of nodeA) {
    // 只看采样面积够大的结点（至少最大者的四分之一），免得只沾到一点皮肤的结点给出离谱的比值
    // only nodes with enough sampled area (a quarter of the largest at least), so that a node grazing the skin gives no absurd ratio
    if (an < 0.25 * aMax) continue
    const pr = nodeF.get(node)! / an, r = nodeR.get(node)! / an
    if (nodeT.get(node)! > 0.5 * an) peak = Math.max(peak, pr)
    const b = Math.min(bins - 1, Math.floor((r / a) * bins))
    if (r < a) (sum[b] = sum[b]! + pr * an), (cnt[b] = cnt[b]! + an)
  }
  const pressureProfile = Array.from({ length: bins }, (_, b) => ({ rMm: Math.round(((b + 0.5) / bins) * a * 1e5) / 100, kPa: cnt[b]! > 0 ? Math.round(sum[b]! / cnt[b]! / 10) / 100 : 0 }))

  const u = axis()
  const strainAt = (z: number): number => {
    const t = z / step - 0.5
    const k = Math.min(count - 2, Math.max(0, Math.floor(t)))
    return -(u[k + 1]! - u[k]!) / step
  }
  const peakStrain = axisPeak(u)

  const meanP = area > 0 ? f / area : 0
  const flags: string[] = []
  if (!converged) flags.push('not-converged')
  if (bottomed) flags.push('force-not-reached:tissue-crushed-or-bottomed-out')
  if (!Number.isFinite(f)) flags.push('not-finite')
  if (probe.kind !== 'plate' && a / d.cell < 2.5) flags.push('probe-under-resolved')
  if (peakStrain > (o.validatedStrain ?? 0.4)) flags.push('strain-beyond-model-range')
  if (meanP / 1000 > (o.validatedPressureKPa ?? 45)) flags.push('pressure-beyond-validated-range')
  if (d.thickness !== undefined && depth > 0.6 * d.thickness) flags.push('depth-beyond-60%-of-tissue-thickness')
  s.probe = null
  const r2 = (x: number): number => Math.round(x * 100) / 100
  return {
    depthMm: r2(depth * 1000), forceN: Math.round(f * 1000) / 1000, meanPressureKPa: r2(meanP / 1000), peakPressureKPa: r2(peak / 1000), contactAreaMm2: Math.round(area * 1e7) / 10,
    strainAtDepth: (zMm: number) => strainAt(zMm * 1e-3), peakStrain: Math.round(peakStrain * 1000) / 1000, pressureProfile,
    valid: flags.length === 0, flags, cellMm: r2(d.cell * 1000), edgeCompensationMm: r2(comp * 1000), frames, converged,
  }
}

/** 细笼子的切口结点嵌在粗笼子里的位置，`couple` 用。 Where the cut nodes of the fine cage sit in the coarse cage, for `couple`. */
export interface Coupling {
  /** 细笼子里跟随粗笼子的结点 / the nodes of the fine cage that follow the coarse one */
  nodes: Uint32Array
  /** 它们在粗笼子里的嵌入 / their embedding in the coarse cage */
  inCoarse: PointSet
  /** 压入点在粗笼子里的嵌入（反力加在这里）/ the embedding of the site in the coarse cage (the reaction is applied here) */
  siteInCoarse: PointSet
}

/**
 * 两级耦合的一次交替：把细笼子上的反力（牛，沿 inward）加到粗笼子的压入点上，粗笼子走到平衡，然后把它在细笼子切口
 * 结点处的位移作为这些结点的给定位移（弹性参考不变）。调用之后重新 press()。返回切口结点位移的最大值（米）。
 * One alternation of the two-level coupling: the reaction found on the fine cage (newtons, along `inward`) is applied
 * to the coarse cage at the site, the coarse cage is run to equilibrium, and its displacement at the cut nodes of the
 * fine cage becomes the prescribed displacement of those nodes (the elastic reference stays). Call press() again afterwards. Returns the largest
 * displacement of a cut node (metres).
 */
export function couple(fine: PressDomain, coarse: SoftSolver, link: Coupling, forceN: number, frames = 120): number {
  const n = fine.inward
  const e = link.siteInCoarse.tet[0]! * 4
  for (let k = 0; k < 4; k++) {
    const node = coarse.tets[e + k]! * 3, w = link.siteInCoarse.bary[k]! * forceN
    coarse.force[node] = w * n[0]
    coarse.force[node + 1] = w * n[1]
    coarse.force[node + 2] = w * n[2]
  }
  for (let f = 0; f < frames; f++) coarse.step(1 / 60)
  const off = (fine.solver.pinOffset ??= new Float64Array(fine.solver.nodeCount * 3))
  const p = [0, 0, 0], r = [0, 0, 0]
  let worst = 0
  for (let i = 0; i < link.nodes.length; i++) {
    const node = link.nodes[i]! * 3
    coarse.pointPosition(link.inCoarse, i, p)
    // 粗笼子的参考位置 = 嵌入点在 ref 里的位置 / the coarse reference position = the embedded point in `ref`
    const t = link.inCoarse.tet[i]! * 4
    r[0] = r[1] = r[2] = 0
    for (let k = 0; k < 4; k++) for (let c = 0; c < 3; c++) r[c] = r[c]! + link.inCoarse.bary[i * 4 + k]! * coarse.ref[coarse.tets[t + k]! * 3 + c]!
    const ux = p[0]! - r[0]!, uy = p[1]! - r[1]!, uz = p[2]! - r[2]!
    worst = Math.max(worst, Math.hypot(ux, uy, uz))
    off[node] = ux
    off[node + 1] = uy
    off[node + 2] = uz
  }
  for (let k = 0; k < 4; k++) coarse.force.fill(0, coarse.tets[e + k]! * 3, coarse.tets[e + k]! * 3 + 3)
  return worst
}
