// 写实的眼的几何与注视：把构造的眼放到扫描的眼球上（球面拟合巩膜、角膜顶点定光轴），注视角的限幅与集合，
// 以及上睑跟随垂直注视的量。纯数据，不依赖 three.js；查看器（src/look/eyes.ts）和测试共用。
// The geometry and gaze of the lifelike eyes: placing the constructed eye on the scanned eyeball (a sphere fitted to the
// sclera, the optical axis through the cornea apex), clamping and converging the gaze, and how far the upper lid follows
// vertical gaze. Pure data, no three.js; shared by the viewer (src/look/eyes.ts) and the tests.
//
// 这只眼是为显示构造的（来源"构造物"），不是解剖数据；尺寸取自下面列出的文献平均值。
// This eye is built for display (provenance "construction"), not anatomical data; its dimensions are the literature
// means listed below.
//
// 来源 / Sources
//   · 眼球直径：Bekerman, Gottlieb & Vaiman (2014) Variations in eyeball diameters of the healthy adults. J Ophthalmol
//     2014:503645（CT，250 人；横径平均 24.2 mm，范围约 21–27 mm）。
//     Eyeball diameters: Bekerman, Gottlieb & Vaiman (2014), J Ophthalmol 2014:503645 (CT, 250 adults; transverse
//     diameter mean 24.2 mm, range about 21–27 mm).
//   · 角膜前表面曲率半径 7.8 mm、角膜厚 0.55 mm、前房深 3.05 mm：Le Grand 完整理论眼（见 Atchison & Smith,
//     Optics of the Human Eye, 2000）。角膜折射率 1.376（Wikipedia "Cornea"）。
//     Anterior corneal radius 7.8 mm, corneal thickness 0.55 mm, anterior chamber depth 3.05 mm: Le Grand's full theoretical
//     eye (see Atchison & Smith, Optics of the Human Eye, 2000). Corneal refractive index 1.376 (Wikipedia "Cornea").
//   · 角膜横径（白到白）11.71 ± 0.42 mm：Rüfer, Schröder & Erb (2005) Cornea 24:259–261。
//     Corneal diameter (white to white) 11.71 ± 0.42 mm: Rüfer, Schröder & Erb (2005), Cornea 24:259–261.
//   · 瞳孔直径：亮处 2–4 mm、暗处 4–8 mm（Wikipedia "Pupil"）；缺省 4 mm 是室内光下的假设。
//     Pupil diameter: 2–4 mm in bright light, 4–8 mm in the dark (Wikipedia "Pupil"); the 4 mm default is an assumption for room light.
//   · 眼球转动范围：Goldmann 视野计测 100 名正常成人的平均最大转动——上转 37.6°、下转 58.0°、内转 51.6°、外转 48.7°
//     （"Duction ranges in normal probands and patients with Graves' ophthalmopathy, determined using the Goldmann
//     perimeter"，PubMed 9700009）；上转随年龄减小，35–44 岁约 33°（Chamberlain 1971, Am J Ophthalmol 71:341）。
//     这里取它们之内的 ±45° 水平、+30° / −35° 垂直：这是限幅，不是测量值。
//     Range of eye rotation: mean maximal ductions of 100 normal adults on a Goldmann perimeter — elevation 37.6°,
//     depression 58.0°, adduction 51.6°, abduction 48.7° (PubMed 9700009); elevation falls with age, about 33° at 35–44
//     years (Chamberlain 1971, Am J Ophthalmol 71:341). The clamp used here, ±45° horizontal and +30° / −35° vertical,
//     sits inside those; it is a limit, not a measurement.
//   · 上下睑随垂直注视：Mastropietro, Alves & Velasco e Cruz (2009) Upper and lower eyelid position in different degrees
//     of downgaze and upgaze. Arq Bras Oftalmol 72(6):771–775（10 名正常人，−30° 到 +30°）。表中是文中给出的平均值，
//     中间按线性插值（插值是本项目的假设）。
//     Lids following vertical gaze: Mastropietro, Alves & Velasco e Cruz (2009), Arq Bras Oftalmol 72(6):771–775 (10 normal
//     subjects, −30° to +30°). The tables hold the means given in the text; values between are interpolated linearly (the
//     interpolation is this project's assumption).

export type V3 = [number, number, number]
/** 行主序的 3×3 矩阵 / a row-major 3×3 matrix */
export type M3 = [number, number, number, number, number, number, number, number, number]
export type EyeSide = 'L' | 'R'

const MM = 0.001

/** 构造这只眼用到的尺寸（米）/ The dimensions used to build the eye (metres). */
export const EYE = {
  /** 拟合半径的可信范围：横径 21–27 mm（Bekerman 2014）/ plausible range of the fitted radius: transverse diameter 21–27 mm (Bekerman 2014) */
  radiusRange: [10.5 * MM, 13.5 * MM] as const,
  /** 平均横径的一半 / half the mean transverse diameter */
  radiusMean: 12.1 * MM,
  corneaRadius: 7.8 * MM,
  corneaIor: 1.376,
  /** 角膜缘半径 = 白到白 / 2 / limbus radius = white to white / 2 */
  limbusRadius: 11.71 * 0.5 * MM,
  /** 角膜顶点到虹膜平面（≈ 晶状体前面）：0.55 + 3.05 mm / corneal apex to the iris plane (≈ the front of the lens): 0.55 + 3.05 mm */
  apexToIris: 3.6 * MM,
  /** 虹膜向前隆起（瞳孔缘比虹膜根靠前多少）；假设 / how far the iris bows forward (pupil margin ahead of the root); an assumption */
  irisCone: 0.4 * MM,
  pupilDefault: 4 * MM,
  pupilRange: [2 * MM, 8 * MM] as const,
}

/** 注视的限幅（度）/ The gaze clamp (degrees). */
export const GAZE_LIMITS = { yaw: 45, up: 30, down: 35 }
/** 固定角度时双眼集合到这么远的一点（米）；假设 / with fixed angles both eyes converge on a point this far away (metres); an assumption */
export const FIXED_GAZE_DISTANCE = 2

/**
 * 上睑缘到瞳孔中心（MRD1）和下睑缘到瞳孔中心（MRD2）的距离（mm）随垂直注视角（度，正 = 上）的变化：
 * Mastropietro 等 2009 文中给出的平均值。
 * Distance from the upper lid margin to the pupil centre (MRD1) and from the lower margin (MRD2), mm, against vertical gaze
 * (degrees, positive = up): the means given in the text of Mastropietro et al. 2009.
 */
export const LID_MRD1: readonly [number, number][] = [[-30, 3.1], [0, 4.1], [20, 3.13], [30, 2.55]]
export const LID_MRD2: readonly [number, number][] = [[-30, 4.8], [-20, 5.3], [0, 6.6], [20, 8.5], [30, 9.0]]

// —— 向量小工具 / small vector helpers ——
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
const deg = (r: number): number => (r * 180) / Math.PI
const rad = (d: number): number => (d * Math.PI) / 180
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

/** 3×3 矩阵乘向量 / matrix times vector */
export function m3apply(m: M3, v: V3): V3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
}

/**
 * 代数最小二乘的球面拟合：x² + y² + z² = 2a·x + 2b·y + 2c·z + d。返回球心、半径和径向残差的均方根。
 * Algebraic least-squares sphere fit: x² + y² + z² = 2a·x + 2b·y + 2c·z + d. Returns the centre, radius and the rms of
 * the radial residuals.
 */
export function fitSphere(p: ArrayLike<number>): { centre: V3; radius: number; rms: number } {
  const n = Math.floor(p.length / 3)
  if (n < 4) throw new Error('fitSphere: at least four points are needed')
  // 先减去均值，免得法方程病态 / subtract the mean first so the normal equations stay well conditioned
  let mx = 0, my = 0, mz = 0
  for (let i = 0; i < n; i++) {
    mx += p[i * 3]!
    my += p[i * 3 + 1]!
    mz += p[i * 3 + 2]!
  }
  mx /= n
  my /= n
  mz /= n
  const A: number[][] = Array.from({ length: 4 }, () => [0, 0, 0, 0, 0])
  for (let i = 0; i < n; i++) {
    const x = p[i * 3]! - mx, y = p[i * 3 + 1]! - my, z = p[i * 3 + 2]! - mz
    const r = [2 * x, 2 * y, 2 * z, 1]
    const t = x * x + y * y + z * z
    for (let a = 0; a < 4; a++) {
      const row = A[a]!
      row[4] = row[4]! + r[a]! * t
      for (let b = 0; b < 4; b++) row[b] = row[b]! + r[a]! * r[b]!
    }
  }
  // 高斯消元（部分主元）/ Gaussian elimination with partial pivoting
  for (let c = 0; c < 4; c++) {
    let piv = c
    for (let r = c + 1; r < 4; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r
    ;[A[c], A[piv]] = [A[piv]!, A[c]!]
    if (Math.abs(A[c]![c]!) < 1e-30) throw new Error('fitSphere: the points do not determine a sphere')
    for (let r = 0; r < 4; r++) {
      if (r === c) continue
      const row = A[r]!, pivot = A[c]!
      const f = row[c]! / pivot[c]!
      for (let k = c; k < 5; k++) row[k] = row[k]! - f * pivot[k]!
    }
  }
  const s = A.map((row, i) => row[4]! / row[i]!)
  const centre: V3 = [s[0]! + mx, s[1]! + my, s[2]! + mz]
  const radius = Math.sqrt(s[3]! + s[0]! ** 2 + s[1]! ** 2 + s[2]! ** 2)
  let e = 0
  for (let i = 0; i < n; i++) e += (Math.hypot(p[i * 3]! - centre[0], p[i * 3 + 1]! - centre[1], p[i * 3 + 2]! - centre[2]) - radius) ** 2
  return { centre, radius, rms: Math.sqrt(e / n) }
}

/** 一只眼的拟合结果（静止空间，米）/ The fit of one eye (rest space, metres). */
export interface EyeFit {
  side: EyeSide
  centre: V3
  /** 构造的眼所用的半径：拟合半径限在文献范围之内 / the radius the constructed eye uses: the fitted radius kept inside the literature range */
  radius: number
  /** 拟合到扫描巩膜上的半径和残差 / radius and residual of the fit to the scanned sclera */
  scanRadius: number
  rms: number
  /** 光轴（单位向量）：球心指向扫描角膜的顶点 / optical axis (unit): from the centre through the scanned cornea apex */
  axis: V3
  /** 扫描角膜的顶点；没有角膜时为 null / apex of the scanned cornea; null without one */
  apex: V3 | null
}

/**
 * 拟合一只眼：巩膜定球心和半径，角膜顶点（离球心最远、且在角膜平均方向上的那个顶点）定光轴；没有角膜时光轴朝前（+z）。
 * Fit one eye: the sclera gives the centre and radius, the cornea apex (the cornea vertex farthest from the centre along
 * the cornea's mean direction) the optical axis; without a cornea the axis points forward (+z).
 */
export function fitEye(side: EyeSide, sclera: ArrayLike<number>, cornea: ArrayLike<number> | null): EyeFit {
  const s = fitSphere(sclera)
  let axis: V3 = [0, 0, 1]
  let apex: V3 | null = null
  if (cornea && cornea.length >= 3) {
    const n = cornea.length / 3
    let mean: V3 = [0, 0, 0]
    for (let i = 0; i < n; i++) mean = add(mean, sub([cornea[i * 3]!, cornea[i * 3 + 1]!, cornea[i * 3 + 2]!], s.centre))
    const dir = norm(mean)
    let best = -Infinity
    for (let i = 0; i < n; i++) {
      const q: V3 = [cornea[i * 3]!, cornea[i * 3 + 1]!, cornea[i * 3 + 2]!]
      const d = dot(sub(q, s.centre), dir)
      if (d > best) {
        best = d
        apex = q
      }
    }
    if (apex) axis = norm(sub(apex, s.centre))
  }
  return { side, centre: s.centre, radius: clamp(s.radius, EYE.radiusRange[0], EYE.radiusRange[1]), scanRadius: s.radius, rms: s.rms, axis, apex }
}

/** 构造的眼的剖面（眼的局部坐标，z 沿光轴，米）/ The profile of the constructed eye (eye-local frame, z along the axis, metres). */
export interface EyeShape {
  radius: number
  /** 角膜缘所在平面的 z 和角膜缘半径 / z of the limbus plane and the limbus radius */
  zLimbus: number
  limbus: number
  /** 角膜缘对应的极角（从光轴量）/ polar angle of the limbus (from the axis) */
  thetaLimbus: number
  /** 角膜球面的球心 z 和半径 / z of the corneal sphere's centre and its radius */
  zCornea: number
  corneaRadius: number
  /** 角膜顶点的 z / z of the corneal apex */
  apex: number
  /** 虹膜根所在平面的 z；瞳孔中心离转动中心的距离 / z of the iris root plane; distance of the pupil centre from the centre of rotation */
  zIris: number
  pupilDistance: number
}

/** 由半径算出剖面：角膜是半径 7.8 mm 的球冠，恰好在角膜缘处接上巩膜球 / The profile from the radius: the cornea is a 7.8 mm spherical cap meeting the scleral sphere exactly at the limbus. */
export function eyeShape(radius: number): EyeShape {
  const limbus = Math.min(EYE.limbusRadius, radius * 0.9)
  const zLimbus = Math.sqrt(radius * radius - limbus * limbus)
  const rc = Math.max(EYE.corneaRadius, limbus * 1.05)
  const zCornea = zLimbus - Math.sqrt(rc * rc - limbus * limbus)
  const apex = zCornea + rc
  const zIris = apex - EYE.apexToIris
  return { radius, zLimbus, limbus, thetaLimbus: Math.asin(limbus / radius), zCornea, corneaRadius: rc, apex, zIris, pupilDistance: zIris + EYE.irisCone }
}

/** 极角 θ（从光轴量）方向上眼表面到球心的距离：角膜内取角膜球冠，外面取巩膜球 / Distance of the eye surface from the centre at polar angle θ (from the axis): the corneal cap inside the limbus, the sclera outside. */
export function surfaceRadius(shape: EyeShape, theta: number): number {
  if (theta >= shape.thetaLimbus) return shape.radius
  const s = Math.sin(theta), c = Math.cos(theta)
  const zc = shape.zCornea, rc = shape.corneaRadius
  return zc * c + Math.sqrt(Math.max(0, rc * rc - zc * zc * s * s))
}

/** 眼的局部坐标基：e1 水平（≈ +x），e2 竖直（≈ +y），a 光轴 / The eye-local basis: e1 horizontal (≈ +x), e2 vertical (≈ +y), a the axis. */
export function eyeBasis(axis: V3): { e1: V3; e2: V3; a: V3 } {
  const a = norm(axis)
  const e2 = norm(sub([0, 1, 0], scale(a, a[1])))
  const e1 = cross(e2, a)
  return { e1, e2, a }
}

/** 头部坐标里的方向（+z 向前，+y 向上，+x 向人体左侧）/ A direction in the head frame (+z forward, +y up, +x to the body's left). */
export function gazeDirection(yawDeg: number, pitchDeg: number): V3 {
  const y = rad(yawDeg), p = rad(pitchDeg)
  return [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)]
}

/** 方向 → 角度（度）/ direction → angles (degrees) */
export function gazeAngles(d: V3): { yaw: number; pitch: number } {
  return { yaw: deg(Math.atan2(d[0], d[2])), pitch: deg(Math.atan2(d[1], Math.hypot(d[0], d[2]))) }
}

/** 限幅到 GAZE_LIMITS / Clamp to GAZE_LIMITS. */
export function clampGaze(g: { yaw: number; pitch: number }): { yaw: number; pitch: number } {
  return { yaw: clamp(g.yaw, -GAZE_LIMITS.yaw, GAZE_LIMITS.yaw), pitch: clamp(g.pitch, -GAZE_LIMITS.down, GAZE_LIMITS.up) }
}

/**
 * 双眼看同一个目标点（头部静止坐标）时各自的角度（集合），限幅之后。目标在双眼中点看来远远超出转动范围（例如在头后）时，
 * 双眼回到正前方，不硬拧到极限。
 * Each eye's angles when both look at one target point (head rest frame) — vergence — after clamping. When the target lies
 * far outside the range as seen from between the eyes (behind the head, say), both eyes return to straight ahead rather than
 * straining at the limit.
 */
export function eyeAngles(centres: readonly V3[], target: V3): { yaw: number; pitch: number }[] {
  const mid = scale(centres.reduce<V3>((a, c) => add(a, c), [0, 0, 0]), 1 / Math.max(1, centres.length))
  const g = gazeAngles(sub(target, mid))
  if (Math.abs(g.yaw) > GAZE_LIMITS.yaw * 1.6 || g.pitch > GAZE_LIMITS.up * 1.8 || g.pitch < -GAZE_LIMITS.down * 1.8) return centres.map(() => ({ yaw: 0, pitch: 0 }))
  return centres.map((c) => clampGaze(gazeAngles(sub(target, c))))
}

/** 固定角度的注视：双眼中点沿该方向 FIXED_GAZE_DISTANCE 处的一点 / The target of a fixed gaze: the point FIXED_GAZE_DISTANCE along that direction from between the eyes. */
export function fixedTarget(centres: readonly V3[], yaw: number, pitch: number): V3 {
  const mid = scale(centres.reduce<V3>((a, c) => add(a, c), [0, 0, 0]), 1 / Math.max(1, centres.length))
  const g = clampGaze({ yaw, pitch })
  return add(mid, scale(gazeDirection(g.yaw, g.pitch), FIXED_GAZE_DISTANCE))
}

/**
 * 把 from 转到 to 的最小转动（行主序矩阵）。眼从静止光轴转到注视方向用它：转轴与两者都垂直，没有绕光轴的扭转（Listing 定律的近似）。
 * The smallest rotation taking `from` to `to` (row-major). Used to turn the eye from its rest axis to the gaze direction: the
 * axis of rotation is perpendicular to both, with no twist about the line of sight (an approximation of Listing's law).
 */
export function rotationBetween(from: V3, to: V3): M3 {
  const f = norm(from), t = norm(to)
  const v = cross(f, t)
  const c = dot(f, t)
  if (c < -0.999999) {
    // 反向：绕任一垂直轴转 180° / opposite: 180° about any perpendicular axis
    const ax = norm(Math.abs(f[0]) < 0.9 ? cross(f, [1, 0, 0]) : cross(f, [0, 1, 0]))
    return [2 * ax[0] * ax[0] - 1, 2 * ax[0] * ax[1], 2 * ax[0] * ax[2], 2 * ax[1] * ax[0], 2 * ax[1] * ax[1] - 1, 2 * ax[1] * ax[2], 2 * ax[2] * ax[0], 2 * ax[2] * ax[1], 2 * ax[2] * ax[2] - 1]
  }
  const k = 1 / (1 + c)
  return [
    v[0] * v[0] * k + c, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1],
    v[1] * v[0] * k + v[2], v[1] * v[1] * k + c, v[1] * v[2] * k - v[0],
    v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], v[2] * v[2] * k + c,
  ]
}

/**
 * 眼从静止时的光轴 `axis` 转到看向 (yaw, pitch) 的转动。扫描的光轴可能偏离正前方好几度（女性右眼约 10°，是配准变形的结果），
 * 从它转过去，构造的眼的光轴就正好对准目标，不会看上去斜视。
 * The eye's rotation from its rest optical axis `axis` to looking at (yaw, pitch). The scanned axis can be several degrees off
 * straight ahead (about 10° for the female right eye, an outcome of the registration warp); turning from it puts the
 * constructed eye's axis exactly on the target, so it never looks squinted.
 */
export function gazeRotation(yaw: number, pitch: number, axis: V3 = [0, 0, 1]): M3 {
  return rotationBetween(axis, gazeDirection(yaw, pitch))
}

/** 分段线性插值，两端外延取端点值 / Piecewise-linear interpolation, held constant beyond the ends. */
export function interpolate(table: readonly [number, number][], x: number): number {
  if (x <= table[0]![0]) return table[0]![1]
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i]!
    if (x <= x1) {
      const [x0, y0] = table[i - 1]!
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
    }
  }
  return table[table.length - 1]![1]
}

/**
 * 垂直注视 pitch（度）时上、下睑缘相对原位的竖直移动（mm，正 = 向上）：瞳孔中心随眼上下移动 pupilDistance·sin(pitch)，
 * 睑缘到瞳孔中心的距离按 LID_MRD1 / LID_MRD2 变化。
 * Vertical travel of the upper and lower lid margins (mm, positive = up) at vertical gaze `pitch` (degrees): the pupil
 * centre moves by pupilDistance·sin(pitch) with the eye, and the margin-to-pupil distances change as LID_MRD1 / LID_MRD2 say.
 */
export function lidTravel(pitchDeg: number, pupilDistance: number): { upper: number; lower: number } {
  const p = (pupilDistance / MM) * Math.sin(rad(pitchDeg))
  const upper = p + (interpolate(LID_MRD1, pitchDeg) - interpolate(LID_MRD1, 0))
  const lower = p - (interpolate(LID_MRD2, pitchDeg) - interpolate(LID_MRD2, 0))
  return { upper, lower }
}

// —— 地址参数 / URL parameters ——

/** 解析 gaze 参数：'c' 为看相机；'yaw,pitch'（度）为固定角度；无效时为 null / Parse the gaze parameter: 'c' = the camera; 'yaw,pitch' (degrees) = fixed; null when invalid. */
export function parseGaze(value: string): 'camera' | { yaw: number; pitch: number } | null {
  if (value === 'c' || value === 'camera') return 'camera'
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(value)
  if (!m) return null
  return clampGaze({ yaw: Number(m[1]), pitch: Number(m[2]) })
}

/** 写出 gaze 参数；看相机（缺省）返回 null，不写 / Format the gaze parameter; null for the camera (the default), which is not written. */
export function formatGaze(g: 'camera' | { yaw: number; pitch: number }): string | null {
  if (g === 'camera') return null
  const r = (x: number): number => Math.round(x * 10) / 10 + 0
  return `${r(g.yaw)},${r(g.pitch)}`
}
