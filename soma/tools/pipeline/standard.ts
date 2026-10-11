// 骨架标准化：把一副（供体的）骨架按肢段缩放到参考人群的比例。
// 每块骨保持自身形状，沿所在肢段的轴向缩放、以关节中心为不动点；中轴骨（脊柱、胸廓、骨盆、
// 头颅）走一个连续的分段映射；肩带下移到参考的肩峰高度。标志点的定义照 tools/bodyshape/measure.py
// （ANSUR II 的骨性标志），目标值由 data/curated/bodyshape/anthro-model.json 的回归式给出。
// Skeleton standardisation: scales a (donor's) skeleton segment by segment to the proportions of
// a reference population. Each bone keeps its own shape and is scaled along its segment's axis
// about the joint centres; the axial skeleton (spine, rib cage, pelvis, head) goes through one
// continuous piecewise map; the shoulder girdle is lowered to the reference acromial height.
// Landmark definitions follow tools/bodyshape/measure.py (ANSUR II bony landmarks); the targets
// come from the regressions in data/curated/bodyshape/anthro-model.json.

export type Vec3 = [number, number, number]
export type PointMap = (p: Vec3) => Vec3

// ── 人体测量模型 / the anthropometric model ─────────────────────────────────────────────────

export interface AnthroOutput { a: number; bStature: number; cBmi: number; residualSdLog: number; factorLoadings?: number[] }
export interface AnthroModel { S0: number; B0: number; sexes: Record<string, { outputs: Record<string, AnthroOutput> }>; nhanes?: { sexes: Record<string, { outputs: Record<string, AnthroOutput> }> } }

/**
 * 某项测量在给定身高、BMI 下的预测值（毫米）；`factors` 为腿长比例和体型分布两个因子（默认 0）。
 * Predicted value (mm) of a measurement at a stature and BMI; `factors` are the leg-length and mass-distribution factors (0 by default).
 */
export function anthro(model: AnthroModel, sex: 'F' | 'M', id: string, statureMm: number, bmi: number, factors: [number, number] = [0, 0]): number {
  const o = model.sexes[sex]!.outputs[id]
  if (!o) throw new Error(`anthro model has no output ${id}`)
  const l = o.factorLoadings ?? [0, 0]
  return Math.exp(o.a + o.bStature * Math.log(statureMm / model.S0) + o.cBmi * Math.log(bmi / model.B0) + l[0]! * factors[0] + l[1]! * factors[1])
}

/**
 * 同上，但取 NHANES（平民、BMI 范围完整）拟合的围度：waist、hip、thigh、calf、armcirc。
 * As above, from the NHANES fits (civilians, full BMI range) of the girths: waist, hip, thigh, calf, armcirc.
 */
export function anthroNhanes(model: AnthroModel, sex: 'F' | 'M', id: string, statureMm: number, bmi: number): number {
  const o = model.nhanes?.sexes[sex]?.outputs[id]
  if (!o) throw new Error(`anthro model has no NHANES output ${id}`)
  return Math.exp(o.a + o.bStature * Math.log(statureMm / model.S0) + o.cBmi * Math.log(bmi / model.B0))
}

/** 该项测量的人群残差标准差（毫米），在预测值附近 / population residual SD (mm) of the measurement, about the predicted value */
export function anthroSd(model: AnthroModel, sex: 'F' | 'M', id: string, statureMm: number, bmi: number): number {
  return anthro(model, sex, id, statureMm, bmi) * model.sexes[sex]!.outputs[id]!.residualSdLog
}

// ── 小工具 / helpers ───────────────────────────────────────────────────────────────────────

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const unit = (a: Vec3): Vec3 => {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
const at = (v: Float32Array, i: number): Vec3 => [v[3 * i]!, v[3 * i + 1]!, v[3 * i + 2]!]
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 使 f(i) 最大的顶点 / the vertex maximising f */
function argmax(v: Float32Array, f: (p: Vec3) => number, keep?: (p: Vec3, i: number) => boolean): Vec3 {
  let best = -Infinity
  let out: Vec3 = [NaN, NaN, NaN]
  for (let i = 0; i < v.length / 3; i++) {
    const p = at(v, i)
    if (keep && !keep(p, i)) continue
    const s = f(p)
    if (s > best) {
      best = s
      out = p
    }
  }
  return out
}

/**
 * 主轴（朝上）及每个顶点沿主轴的归一化位置 t ∈ [0, 1]。同 measure.py 的 _axis_param。
 * Principal axis (pointing up) and each vertex's normalised position t ∈ [0, 1] along it. As _axis_param in measure.py.
 */
export function axisParam(v: Float32Array): { c: Vec3; axis: Vec3; t: Float32Array } {
  const n = v.length / 3
  const c: Vec3 = [0, 0, 0]
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] = c[k]! + v[3 * i + k]! / n
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < n; i++) {
    const d = [v[3 * i]! - c[0], v[3 * i + 1]! - c[1], v[3 * i + 2]! - c[2]]
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) m[3 * a + b] = m[3 * a + b]! + d[a]! * d[b]!
  }
  // 幂迭代求最大特征向量 / power iteration for the leading eigenvector
  let ax: Vec3 = [0.3, 0.9, 0.3]
  for (let it = 0; it < 100; it++) ax = unit([m[0]! * ax[0] + m[1]! * ax[1] + m[2]! * ax[2], m[3]! * ax[0] + m[4]! * ax[1] + m[5]! * ax[2], m[6]! * ax[0] + m[7]! * ax[1] + m[8]! * ax[2]])
  if (ax[1] < 0) ax = [-ax[0], -ax[1], -ax[2]]
  const t = new Float32Array(n)
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < n; i++) {
    t[i] = (v[3 * i]! - c[0]) * ax[0] + (v[3 * i + 1]! - c[1]) * ax[1] + (v[3 * i + 2]! - c[2]) * ax[2]
    lo = Math.min(lo, t[i]!)
    hi = Math.max(hi, t[i]!)
  }
  for (let i = 0; i < n; i++) t[i] = (t[i]! - lo) / (hi - lo || 1)
  return { c, axis: ax, t }
}

/** 对点集做最小二乘球拟合，返回球心 / least-squares sphere fit, returns the centre */
function sphereCentre(points: Vec3[]): Vec3 {
  // 解 [2x 2y 2z 1]·[cx cy cz d] = x²+y²+z² 的正规方程 / normal equations of [2x 2y 2z 1]·[cx cy cz d] = x²+y²+z²
  const A = Array.from({ length: 4 }, () => [0, 0, 0, 0, 0])
  const o = points.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3).map((x) => x / points.length) as Vec3
  for (const q of points) {
    const p = sub(q, o)
    const row = [2 * p[0], 2 * p[1], 2 * p[2], 1]
    const rhs = dot(p, p)
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) A[a]![b] = A[a]![b]! + row[a]! * row[b]!
      A[a]![4] = A[a]![4]! + row[a]! * rhs
    }
  }
  for (let i = 0; i < 4; i++) {
    let piv = i
    for (let r = i + 1; r < 4; r++) if (Math.abs(A[r]![i]!) > Math.abs(A[piv]![i]!)) piv = r
    ;[A[i], A[piv]] = [A[piv]!, A[i]!]
    const d = A[i]![i]! || 1e-30
    for (let r = 0; r < 4; r++) {
      if (r === i) continue
      const f = A[r]![i]! / d
      for (let k = i; k < 5; k++) A[r]![k] = A[r]![k]! - f * A[i]![k]!
    }
  }
  return add(o, [A[0]![4]! / A[0]![0]!, A[1]![4]! / A[1]![1]!, A[2]![4]! / A[2]![2]!])
}

// ── 标志点 / landmarks ─────────────────────────────────────────────────────────────────────

export type Landmarks = Record<string, Vec3>
export const SIDES = [['L', 1, 'Left'], ['R', -1, 'Right']] as const

/**
 * 由骨网格取骨性标志点（米）。`verts(name)` 返回该名称骨的全部顶点（可为多块骨的并集）。
 * `floorY`、`vertexY` 取自皮肤（最低点、最高点），与 measure.py 一致。
 * Bony landmarks (metres) from the bone meshes. `verts(name)` returns all vertices of the bone of
 * that name. `floorY` and `vertexY` come from the skin (lowest and highest point), as in measure.py.
 */
export function boneLandmarks(verts: (name: string) => Float32Array, floorY: number, vertexY: number): Landmarks {
  const L: Landmarks = { floor: [0, floorY, 0], vertex: [0, vertexY, 0] }
  const c7 = verts('Seventh cervical vertebra')
  L.cervicale = argmax(c7, (p) => -p[2])
  const atlas = verts('Atlas')
  L.skullBase = argmax(atlas, (p) => p[1])
  for (const [S, sgn, Name] of SIDES) {
    const sc = verts(`${Name} scapula`)
    L[`acromion_${S}`] = argmax(sc, (p) => sgn * p[0])
    const cl = verts(`${Name} clavicle`)
    L[`sternoclavicular_${S}`] = argmax(cl, (p) => -sgn * p[0])
    L[`clavicleLateral_${S}`] = argmax(cl, (p) => sgn * p[0])
    const hip = verts(`${Name} hip bone`)
    L[`iliocristale_${S}`] = argmax(hip, (p) => p[1])
    L[`iliacLateral_${S}`] = argmax(hip, (p) => sgn * p[0])
    const fe = verts(`${Name} femur`)
    const fa = axisParam(fe)
    const trochLat = argmax(fe, (p) => sgn * p[0], (_, i) => fa.t[i]! > 0.8)
    L[`trochanterion_${S}`] = argmax(fe, (p) => p[1], (p, i) => fa.t[i]! > 0.8 && sgn * (p[0] - trochLat[0]) > -0.025)
    const medial: Vec3[] = []
    for (let i = 0; i < fe.length / 3; i++) if (fa.t[i]! > 0.8 && sgn * (fe[3 * i]! - trochLat[0]) < -0.045) medial.push(at(fe, i))
    L[`hip_${S}`] = medial.length >= 5 ? sphereCentre(medial) : trochLat
    const epLat = argmax(fe, (p) => sgn * p[0], (_, i) => fa.t[i]! < 0.1)
    const epMed = argmax(fe, (p) => -sgn * p[0], (_, i) => fa.t[i]! < 0.1)
    L[`femoralEpicondyleLateral_${S}`] = epLat
    L[`knee_${S}`] = mid(epLat, epMed)
    const ti = verts(`${Name} tibia`)
    const medMal = argmax(ti, (p) => -p[1])
    const fi = verts(`${Name} fibula`)
    const fia = axisParam(fi)
    const latMal = argmax(fi, (p) => sgn * p[0], (_, i) => fia.t[i]! < 0.12)
    L[`lateralMalleolus_${S}`] = latMal
    L[`ankle_${S}`] = mid(latMal, medMal)
    const hu = verts(`${Name} humerus`)
    const ha = axisParam(hu)
    const head: Vec3[] = []
    for (let i = 0; i < hu.length / 3; i++) if (ha.t[i]! > 0.86) head.push(at(hu, i))
    const headMean = head.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3).map((x) => x / head.length) as Vec3
    const sph = sphereCentre(head)
    L[`shoulder_${S}`] = len(sub(sph, headMean)) > 0.03 ? headMean : sph
    // 肱骨内外上髁：远端在垂直于骨轴的最宽方向上的两个极点。这里用 X 方向近似最宽方向
    // humeral epicondyles: the extremes of the distal end across its widest direction perpendicular to the axis; X approximates it here
    const dLat = argmax(hu, (p) => sgn * p[0], (_, i) => ha.t[i]! < 0.08)
    const dMed = argmax(hu, (p) => -sgn * p[0], (_, i) => ha.t[i]! < 0.08)
    L[`elbow_${S}`] = mid(dLat, dMed)
    const ra = verts(`${Name} radius`)
    const raa = axisParam(ra)
    const ul = verts(`${Name} ulna`)
    const ula = axisParam(ul)
    // 桡骨点：桡骨头背离尺骨一侧的最高点 / radiale: highest point of the radial head on the side away from the ulna
    const headPts: Vec3[] = []
    for (let i = 0; i < ra.length / 3; i++) if (raa.t[i]! > 0.93) headPts.push(at(ra, i))
    const hc = headPts.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3).map((x) => x / headPts.length) as Vec3
    const nearUlna: { d: number; p: Vec3 }[] = []
    for (let i = 0; i < ul.length / 3; i++) nearUlna.push({ d: len(sub(at(ul, i), hc)), p: at(ul, i) })
    nearUlna.sort((a, b) => a.d - b.d)
    const un = nearUlna.slice(0, 20).reduce((s, q) => add(s, q.p), [0, 0, 0] as Vec3).map((x) => x / Math.min(20, nearUlna.length)) as Vec3
    const away = unit(sub(hc, un))
    const proj = headPts.map((p) => dot(sub(p, hc), away)).sort((a, b) => a - b)
    const median = proj[Math.floor(proj.length / 2)]!
    let radiale: Vec3 = hc
    let bestT = -Infinity
    for (const p of headPts) {
      if (dot(sub(p, hc), away) <= median) continue
      const t = dot(sub(p, raa.c), raa.axis)
      if (t > bestT) {
        bestT = t
        radiale = p
      }
    }
    L[`radiale_${S}`] = radiale
    let stylion: Vec3 = at(ra, 0)
    let lo = Infinity
    for (let i = 0; i < ra.length / 3; i++) if (raa.t[i]! < lo) {
      lo = raa.t[i]!
      stylion = at(ra, i)
    }
    L[`stylion_${S}`] = stylion
    let ulnarStyloid: Vec3 = at(ul, 0)
    lo = Infinity
    for (let i = 0; i < ul.length / 3; i++) if (ula.t[i]! < lo) {
      lo = ula.t[i]!
      ulnarStyloid = at(ul, i)
    }
    L[`wrist_${S}`] = mid(stylion, ulnarStyloid)
    // 中指远节指骨尖；骨架只有成组的手骨时没有这一点
    // tip of the distal phalanx of the middle finger; absent when the skeleton has the hand bones only as groups
    let dp: Float32Array | null = null
    try {
      dp = verts(`Distal phalanx of ${Name.toLowerCase()} middle finger`)
    } catch {
      dp = null
    }
    if (dp && dp.length) {
      const dpMean = axisParam(dp).c
      const handAxis = unit(sub(dpMean, L[`wrist_${S}`]!))
      L[`dactylion_${S}`] = argmax(dp, (p) => dot(sub(p, L[`wrist_${S}`]!), handAxis))
    }
  }
  return L
}

/**
 * 由标志点算 ANSUR 式的高度和长度（毫米），左右取平均。同 measure.py 的 skeletal_measures。
 * ANSUR-style heights and lengths (mm) from the landmarks, left and right averaged. As skeletal_measures in measure.py.
 */
export function skeletalMeasures(L: Landmarks): Record<string, number> {
  const f = L.floor![1]
  const h = (k: string) => (L[k]![1] - f) * 1000
  const avg = (k: string) => (h(`${k}_L`) + h(`${k}_R`)) / 2
  const d = (a: string, b: string) => len(sub(L[a]!, L[b]!)) * 1000
  return {
    stature: h('vertex'),
    cervicaleheight: h('cervicale'),
    acromialheight: avg('acromion'),
    iliocristaleheight: avg('iliocristale'),
    trochanterionheight: avg('trochanterion'),
    lateralfemoralepicondyleheight: avg('femoralEpicondyleLateral'),
    lateralmalleolusheight: avg('lateralMalleolus'),
    acromionradialelength: (d('acromion_L', 'radiale_L') + d('acromion_R', 'radiale_R')) / 2,
    radialestylionlength: (d('radiale_L', 'stylion_L') + d('radiale_R', 'stylion_R')) / 2,
    biacromialbreadth: d('acromion_L', 'acromion_R'),
    bicristalbreadth: (L.iliacLateral_L![0] - L.iliacLateral_R![0]) * 1000,
    ...(L.dactylion_L && L.dactylion_R ? { handlengthBone: (d('wrist_L', 'dactylion_L') + d('wrist_R', 'dactylion_R')) / 2 } : {}),
  }
}

// ── 标准化方案 / the standardisation plan ──────────────────────────────────────────────────

export interface StandardTargets {
  /** 全部为毫米 / all in mm */
  stature: number
  cervicaleheight: number
  acromialheight: number
  trochanterionheight: number
  lateralfemoralepicondyleheight: number
  lateralmalleolusheight: number
  acromionradialelength: number
  radialestylionlength: number
  biacromialbreadth: number
  bicristalbreadth: number
  /** 没有指尖标志点时不用 / unused without the fingertip landmark */
  handlengthBone?: number
}

export interface StandardPlan {
  /** 各肢段的缩放系数（供“供体比例”预设取倒数还原） / scale factors per segment (a "donor proportions" preset inverts them) */
  scales: Record<string, number>
  /** 说明：哪些系数被限幅 / notes: which factors were clamped */
  clamped: string[]
  /** 骨名 → 该骨的点映射；不属于任何肢段的名称返回 null / bone name → the bone's point map; null for a name that belongs to no segment */
  boneMap(name: string): PointMap | null
  /** 中轴映射（脊柱、胸廓、骨盆、头颅以及没有归属的骨） / the axial map (spine, rib cage, pelvis, head, and bones without a segment) */
  axial: PointMap
  /** 关节中心的新位置 / new positions of the joint centres */
  joints: Record<string, Vec3>
}

/**
 * 各系数的限幅范围：超出即说明目标不能只靠缩放达到。
 * 头：头的尺寸几乎不随身高变化（ANSUR 头长、头宽对身高的指数约 0.1–0.2），只允许 ±3 %。
 * 颈：颈椎是她的真实骨，最多压缩 8 %。足高：高踝是供体特征，最多压低 10 %，余下的差距保留并在说明中注明。
 * Clamp ranges: beyond them the target cannot be reached by scaling alone.
 * Head: head dimensions hardly vary with stature (ANSUR head length and breadth go with stature to the
 * power 0.1–0.2), so only ±3 % is allowed. Neck: her cervical vertebrae are real bones, compressed by at
 * most 8 %. Foot height: the high ankle is a trait of the donor, lowered by at most 10 %; the rest of
 * the gap stays and is stated in the cautions.
 */
export const SCALE_LIMITS: Record<string, [number, number]> = {
  trunk: [0.85, 1.15], neck: [0.92, 1.1], head: [0.97, 1.03], pelvisWidth: [0.88, 1.08], thoraxWidth: [0.92, 1.08],
  thigh: [0.85, 1.2], shank: [0.85, 1.2], footHeight: [0.9, 1.1], footLength: [0.9, 1.1],
  upperArm: [0.85, 1.2], forearm: [0.85, 1.2], hand: [0.8, 1.1], clavicle: [0.9, 1.15],
}

const FOOT = /calcane|talus|cuboid|cuneiform|navicular|tarsal|toe|sesamoid bone of (left|right) foot/i
const HAND = /scaphoid|lunate|triquetr|pisiform|trapezi|trapezoid|capitate|hamate|carpal|finger|thumb/i

/**
 * 由当前标志点和目标值定出各肢段的变换。
 * 约定：+X 为身体左侧，+Y 向上，中线 x = 两髋关节中心的中点；地面不动。
 * Fixes every segment's transform from the current landmarks and the targets.
 * Conventions: +X is the body's left, +Y up, the midline x is midway between the hip joint centres; the floor stays.
 */
export function planStandard(L: Landmarks, T: StandardTargets, opts: { thoraxWidth?: number; footLength?: number; footHeight?: number } = {}): StandardPlan {
  const clamped: string[] = []
  const lim = (key: string, v: number) => {
    const [lo, hi] = SCALE_LIMITS[key]!
    const c = clamp(v, lo, hi)
    if (c !== v) clamped.push(`${key}: wanted ${v.toFixed(3)}, limited to ${c.toFixed(3)}`)
    return c
  }
  const F = L.floor![1]
  const m = (v: number) => v / 1000
  const avgY = (k: string) => (L[`${k}_L`]![1] + L[`${k}_R`]![1]) / 2
  const xMid = (L.hip_L![0] + L.hip_R![0]) / 2
  const zAxis = (L.hip_L![2] + L.hip_R![2]) / 2

  // 下肢：自下而上定系数 / lower limb: factors from the floor up
  // 足高系数：默认按外踝高度；调用方可给出更稳健的估计（外踝点在倾斜的腓骨上不可靠）
  // foot-height factor: from the lateral malleolus height by default; the caller may pass a sturdier estimate (the malleolus point is unreliable on a leaning fibula)
  const footHeight = lim('footHeight', opts.footHeight ?? m(T.lateralmalleolusheight) / (avgY('lateralMalleolus') - F))
  const footLength = lim('footLength', opts.footLength ?? 1)
  // 踝中心的新高度由足高系数决定（该系数可能被限幅）；小腿和大腿依次补足，使外上髁和
  // 大转子点落在目标高度上（下肢近于竖直，按高度计算）
  // the ankle centre's new height follows from the foot factor (which may be limited); shank and
  // thigh then make up the rest in turn so that the lateral epicondyle and the trochanterion land
  // on their target heights (the lower limb is close to vertical: computed on heights)
  const ankleY1 = F + footHeight * (avgY('ankle') - F)
  const shank = lim('shank', (F + m(T.lateralfemoralepicondyleheight) - (avgY('femoralEpicondyleLateral') - avgY('knee')) - ankleY1) / (avgY('knee') - avgY('ankle')))
  const kneeY1 = ankleY1 + shank * (avgY('knee') - avgY('ankle'))
  const thigh = lim('thigh', (F + m(T.trochanterionheight) - kneeY1) / (avgY('trochanterion') - avgY('knee')))
  // 髋关节中心的新高度，左右平均 / new height of the hip joint centres, sides averaged
  const hipY0 = avgY('hip')
  const hipY1 = kneeY1 + thigh * (hipY0 - avgY('knee'))

  // 中轴：髋—颈椎点为躯干，颈椎点—颅底为颈，颅底以上为头
  // axial: hip to cervicale is the trunk, cervicale to skull base the neck, above the skull base the head
  const cervY0 = L.cervicale![1]
  const cervY1 = F + m(T.cervicaleheight)
  const trunk = lim('trunk', (cervY1 - hipY1) / (cervY0 - hipY0))
  const cervY1c = hipY1 + trunk * (cervY0 - hipY0)
  const baseY0 = L.skullBase![1]
  const vertexY0 = L.vertex![1]
  const vertexY1 = F + m(T.stature)
  const head = lim('head', (vertexY1 - cervY1c - trunk * (baseY0 - cervY0)) / (vertexY0 - baseY0))
  const neck = lim('neck', (vertexY1 - cervY1c - head * (vertexY0 - baseY0)) / (baseY0 - cervY0))
  const baseY1 = cervY1c + neck * (baseY0 - cervY0)
  const pelvisWidth = lim('pelvisWidth', T.bicristalbreadth / ((L.iliacLateral_L![0] - L.iliacLateral_R![0]) * 1000))
  const thoraxWidth = lim('thoraxWidth', opts.thoraxWidth ?? 1)
  const crestY0 = avgY('iliocristale')
  const yMap = (y: number) => (y <= cervY0 ? hipY1 + trunk * (y - hipY0) : y <= baseY0 ? cervY1c + neck * (y - cervY0) : baseY1 + head * (y - baseY0))
  const ramp = (y: number, a: number, b: number) => clamp((y - a) / (b - a), 0, 1)
  const smooth = (t: number) => t * t * (3 - 2 * t)
  // 横向系数：骨盆 → 胸廓（髂嵴以上 10 cm 内过渡）→ 头（颈部过渡）
  // transverse factor: pelvis → thorax (over 10 cm above the iliac crest) → head (over the neck)
  const wMap = (y: number) => {
    if (y <= cervY0) return pelvisWidth + (thoraxWidth - pelvisWidth) * smooth(ramp(y, crestY0, crestY0 + 0.1))
    return thoraxWidth + (head - thoraxWidth) * smooth(ramp(y, cervY0, baseY0))
  }
  const axial: PointMap = (p) => {
    const w = wMap(p[1])
    return [xMid + w * (p[0] - xMid), yMap(p[1]), zAxis + w * (p[2] - zAxis)]
  }
  // 肢段变换：以 o 为不动点（移到 o1），沿轴 a 缩放 sl，垂直方向缩放 sc
  // a segment's transform: fixed point o (moved to o1), scale sl along the axis a, sc across it
  const segment = (o: Vec3, o1: Vec3, a: Vec3, sl: number, sc = 1): PointMap => (p) => {
    const d = sub(p, o)
    const along = dot(d, a)
    return [o1[0] + sc * (d[0] - along * a[0]) + sl * along * a[0], o1[1] + sc * (d[1] - along * a[1]) + sl * along * a[1], o1[2] + sc * (d[2] - along * a[2]) + sl * along * a[2]]
  }
  const scales: Record<string, number> = { trunk, neck, head, pelvisWidth, thoraxWidth, thigh, shank, footHeight, footLength }
  const joints: Record<string, Vec3> = {}
  const sideMaps: Record<string, Record<string, PointMap>> = {}

  // 上肢长度系数：左右各解一次再平均 / upper-limb length factors: solved per side, then averaged
  const girdle: Record<string, { acr1: Vec3; mLocal: PointMap }> = {}
  for (const [S, sgn] of SIDES) {
    const acr = L[`acromion_${S}`]!
    const a = axial(acr)
    const acr1: Vec3 = [xMid + (sgn * m(T.biacromialbreadth)) / 2, F + m(T.acromialheight), a[2]]
    // 肩胛骨：随所在胸廓的局部缩放，整体平移到新的肩峰位置
    // scapula: the local scaling of the rib cage it lies on, translated as a whole to the new acromion
    const mLocal: PointMap = (p) => [acr1[0] + thoraxWidth * (p[0] - acr[0]), acr1[1] + trunk * (p[1] - acr[1]), acr1[2] + thoraxWidth * (p[2] - acr[2])]
    girdle[S] = { acr1, mLocal }
  }
  const solve = (f: (s: number) => number, target: number): number => {
    let lo = 0.5
    let hi = 1.6
    for (let i = 0; i < 50; i++) {
      const c = (lo + hi) / 2
      if (f(c) < target) lo = c
      else hi = c
    }
    return (lo + hi) / 2
  }
  const armAxis = (S: string) => unit(sub(L[`elbow_${S}`]!, L[`shoulder_${S}`]!))
  const foreAxis = (S: string) => unit(sub(L[`wrist_${S}`]!, L[`elbow_${S}`]!))
  const upperArm = lim('upperArm', SIDES.map(([S]) => {
    const g = girdle[S]!
    const sh = L[`shoulder_${S}`]!
    const sh1 = g.mLocal(sh)
    // 桡骨点随前臂、相对肘中心平移：其到新肩峰的距离随上臂系数变化
    // the radiale moves with the forearm, rigidly about the elbow centre: its distance to the new acromion varies with the upper-arm factor
    return solve((s) => {
      const el1 = segment(sh, sh1, armAxis(S), s)(L[`elbow_${S}`]!)
      return len(sub(add(el1, sub(L[`radiale_${S}`]!, L[`elbow_${S}`]!)), g.acr1))
    }, m(T.acromionradialelength))
  }).reduce((a, b) => a + b, 0) / 2)
  const forearm = lim('forearm', SIDES.map(([S]) => {
    const el = L[`elbow_${S}`]!
    return solve((s) => {
      const f = segment(el, el, foreAxis(S), s)
      return len(sub(f(L[`radiale_${S}`]!), f(L[`stylion_${S}`]!)))
    }, m(T.radialestylionlength))
  }).reduce((a, b) => a + b, 0) / 2)
  const hand = L.dactylion_L && L.dactylion_R && T.handlengthBone ? lim('hand', T.handlengthBone / ((len(sub(L.wrist_L!, L.dactylion_L)) + len(sub(L.wrist_R!, L.dactylion_R))) * 500)) : 1
  let clavicleScale = 0
  let clavicleTurn = 0
  for (const [S, , Name] of SIDES) {
    const g = girdle[S]!
    const maps1: Record<string, PointMap> = {}
    // 锁骨：胸锁端随中轴，肩峰端随肩胛骨；绕胸锁端做旋转 + 均匀缩放
    // clavicle: sternal end with the axial map, acromial end with the scapula; a rotation and uniform scale about the sternal end
    const sc = L[`sternoclavicular_${S}`]!
    const sc1 = axial(sc)
    const lat = L[`clavicleLateral_${S}`]!
    const lat1 = g.mLocal(lat)
    const u = sub(lat, sc)
    const u1 = sub(lat1, sc1)
    const k = len(u1) / len(u)
    const e0 = unit(u)
    const e1 = unit(u1)
    const cos = clamp(dot(e0, e1), -1, 1)
    const axisRaw: Vec3 = [e0[1] * e1[2] - e0[2] * e1[1], e0[2] * e1[0] - e0[0] * e1[2], e0[0] * e1[1] - e0[1] * e1[0]]
    const sin = len(axisRaw)
    const ax = sin > 1e-9 ? unit(axisRaw) : ([0, 0, 1] as Vec3)
    clavicleScale += k / 2
    clavicleTurn += (Math.atan2(sin, cos) * 180) / Math.PI / 2
    maps1.clavicle = (p) => {
      const d = sub(p, sc)
      // 罗德里格斯旋转 / Rodrigues rotation
      const cr: Vec3 = [ax[1] * d[2] - ax[2] * d[1], ax[2] * d[0] - ax[0] * d[2], ax[0] * d[1] - ax[1] * d[0]]
      const ad = dot(ax, d) * (1 - cos)
      return [sc1[0] + k * (d[0] * cos + cr[0] * sin + ax[0] * ad), sc1[1] + k * (d[1] * cos + cr[1] * sin + ax[1] * ad), sc1[2] + k * (d[2] * cos + cr[2] * sin + ax[2] * ad)]
    }
    maps1.scapula = g.mLocal
    const sh = L[`shoulder_${S}`]!
    const sh1 = g.mLocal(sh)
    maps1.humerus = segment(sh, sh1, armAxis(S), upperArm)
    const el = L[`elbow_${S}`]!
    const el1 = maps1.humerus(el)
    maps1.forearm = segment(el, el1, foreAxis(S), forearm)
    const wr = L[`wrist_${S}`]!
    const wr1 = maps1.forearm(wr)
    maps1.hand = (p) => [wr1[0] + hand * (p[0] - wr[0]), wr1[1] + hand * (p[1] - wr[1]), wr1[2] + hand * (p[2] - wr[2])]
    // 下肢：自上而下 / lower limb: from the top down
    const hip = L[`hip_${S}`]!
    const hip1 = axial(hip)
    const kn = L[`knee_${S}`]!
    maps1.femur = segment(hip, hip1, unit(sub(kn, hip)), thigh)
    const kn1 = maps1.femur(kn)
    maps1.patella = (p) => [kn1[0] + p[0] - kn[0], kn1[1] + p[1] - kn[1], kn1[2] + p[2] - kn[2]]
    const an = L[`ankle_${S}`]!
    maps1.shank = segment(kn, kn1, unit(sub(an, kn)), shank)
    const an1 = maps1.shank(an)
    // 足：以踝为不动点；竖向系数取使足底回到地面的值，前后和左右取足长系数
    // foot: fixed at the ankle; the vertical factor is whatever puts the sole back on the floor, length and width take the foot-length factor
    const fy = (an1[1] - F) / (an[1] - F)
    scales[`footHeight_${S}`] = fy
    maps1.foot = (p) => [an1[0] + footLength * (p[0] - an[0]), an1[1] + fy * (p[1] - an[1]), an1[2] + footLength * (p[2] - an[2])]
    sideMaps[Name] = maps1
    Object.assign(joints, { [`shoulder_${S}`]: sh1, [`elbow_${S}`]: el1, [`wrist_${S}`]: wr1, [`hip_${S}`]: hip1, [`knee_${S}`]: kn1, [`ankle_${S}`]: an1, [`acromion_${S}`]: g.acr1 })
  }
  Object.assign(scales, { upperArm, forearm, hand, clavicle: clavicleScale, clavicleTurnDeg: clavicleTurn })
  const boneMap = (name: string): PointMap | null => {
    const side = /\bleft\b/i.test(name) ? 'Left' : /\bright\b/i.test(name) ? 'Right' : null
    if (!side) return null
    const s = sideMaps[side]!
    if (/clavic/i.test(name)) return s.clavicle!
    if (/scapula/i.test(name)) return s.scapula!
    if (/humerus/i.test(name)) return s.humerus!
    if (/\b(radius|ulna)\b/i.test(name)) return s.forearm!
    if (/femur/i.test(name)) return s.femur!
    if (/patella/i.test(name)) return s.patella!
    if (/\b(tibia|fibula)\b/i.test(name)) return s.shank!
    if (FOOT.test(name)) return s.foot!
    if (HAND.test(name)) return s.hand!
    return null
  }
  return { scales, clamped, boneMap, axial, joints }
}

/** 把点映射作用于 xyz 数组 / applies a point map to an xyz array */
export function mapPoints(map: PointMap, points: Float32Array): Float32Array {
  const out = new Float32Array(points.length)
  for (let i = 0; i < points.length; i += 3) {
    const q = map([points[i]!, points[i + 1]!, points[i + 2]!])
    out[i] = q[0]
    out[i + 1] = q[1]
    out[i + 2] = q[2]
  }
  return out
}

/**
 * 形变在一组采样点处的雅可比行列式（中心差分，步长 h）的分位数；≤ 0 表示空间发生折叠。
 * Quantiles of the Jacobian determinant of a deformation at sample points (central differences, step h); ≤ 0 means space folds.
 */
export function jacobianStats(apply: (points: Float32Array) => Float32Array, samples: Float32Array, h = 0.004): { samples: number; min: number; p01: number; median: number; p99: number; max: number; folded: number } {
  const n = samples.length / 3
  const q = new Float32Array(n * 18)
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) for (const [k, sgn] of [[0, 1], [1, -1]] as const) {
    const o = 18 * i + 6 * a + 3 * k
    q[o] = samples[3 * i]!
    q[o + 1] = samples[3 * i + 1]!
    q[o + 2] = samples[3 * i + 2]!
    q[o + a] = q[o + a]! + sgn * h
  }
  const w = apply(q)
  const det: number[] = []
  for (let i = 0; i < n; i++) {
    const J: number[] = []
    for (let a = 0; a < 3; a++) for (let c = 0; c < 3; c++) J.push((w[18 * i + 6 * a + c]! - w[18 * i + 6 * a + 3 + c]!) / (2 * h))
    // J 的第 a 行是 ∂/∂x_a；行列式与转置无关 / row a of J is ∂/∂x_a; the determinant does not care about the transpose
    det.push(J[0]! * (J[4]! * J[8]! - J[5]! * J[7]!) - J[1]! * (J[3]! * J[8]! - J[5]! * J[6]!) + J[2]! * (J[3]! * J[7]! - J[4]! * J[6]!))
  }
  det.sort((a, b) => a - b)
  const at = (f: number) => (det.length ? Number(det[Math.min(det.length - 1, Math.floor(f * det.length))]!.toFixed(3)) : NaN)
  return { samples: n, min: at(0), p01: at(0.01), median: at(0.5), p99: at(0.99), max: at(1), folded: det.filter((d) => d <= 0).length }
}
