// Anatomical landmark checks for imported nerves: numeric tests of "does this nerve run where the
// textbook says", evaluated against the surrounding BodyParts3D structures. Used by the pipeline
// (report) and by the output-validation test (assertions), so they work on plain meshes and
// centrelines looked up by part name.
//
// Frame: metres, Y up, anterior +Z, the body's left at +X. Limbs hang at the sides.

import type { Mesh } from './geometry.ts'
import { densify } from './importZa.ts'
import { PointIndex, surfacePoints } from './register.ts'
import type { Polyline } from './tube.ts'

export interface LandmarkContext {
  /** mesh of the part with this exact name, or null */
  mesh(name: string): Mesh | null
  /** centrelines of the nerve part with this exact name, or null */
  nerve(name: string): Polyline[] | null
}

export interface LandmarkResult {
  id: string
  side: 'L' | 'R'
  claim: string
  pass: boolean
  /** null = could not be evaluated (a part is missing) */
  evaluated: boolean
  /** human-readable measurements, distances in mm */
  measured: string
  /** key numbers, mm unless noted */
  values: Record<string, number>
}

type V3 = [number, number, number]
const mm = (v: number) => (v * 1000).toFixed(1)

/** Centroid of the mesh vertices with y in [y0, y1]; null when the slab is empty. */
export function slabCentroid(mesh: Mesh, y0: number, y1: number): V3 | null {
  let n = 0
  let x = 0
  let y = 0
  let z = 0
  const p = mesh.positions
  for (let i = 0; i < p.length; i += 3) {
    if (p[i + 1]! < y0 || p[i + 1]! > y1) continue
    x += p[i]!
    y += p[i + 1]!
    z += p[i + 2]!
    n++
  }
  return n ? [x / n, y / n, z / n] : null
}

export function bboxOf(mesh: Mesh): [number, number, number, number, number, number] {
  const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  const p = mesh.positions
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    if (p[i + k]! < b[k]!) b[k] = p[i + k]!
    if (p[i + k]! > b[k + 3]!) b[k + 3] = p[i + k]!
  }
  return b
}

const surfaceIndex = (mesh: Mesh) => new PointIndex(surfacePoints(mesh, 0.0015), 0.004)

/** All centreline samples of a nerve, 1 mm apart, as [x, y, z][]. */
function samples(branches: Polyline[]): V3[] {
  const out: V3[] = []
  for (const b of branches) {
    const d = densify(b, 0.001)
    for (let i = 0; i < d.points.length; i += 3) out.push([d.points[i]!, d.points[i + 1]!, d.points[i + 2]!])
  }
  return out
}

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const closestTo = (pts: V3[], target: V3): V3 | null => {
  let best: V3 | null = null
  let bd = Infinity
  for (const p of pts) {
    const d = dist(p, target)
    if (d < bd) {
      bd = d
      best = p
    }
  }
  return best
}
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN
}

const missing = (id: string, side: 'L' | 'R', claim: string, what: string): LandmarkResult => ({ id, side, claim, pass: false, evaluated: false, measured: `not evaluated: ${what} missing`, values: {} })

const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth']

export interface LandmarkOptions {
  /**
   * 桡神经沟检查按肱骨干自己的轴线取切片，而不是按水平面（缺省为否，即原来的做法：假定肱骨是竖直的）。
   * 上肢外展过的身体要打开它：肱骨斜了以后，水平切片切到的不是同一段骨。肱骨恰好竖直时两种做法结果相同。
   * The radial-groove check takes its slabs perpendicular to the humeral shaft's own axis instead of
   * horizontally (off by default, which is the earlier behaviour: a vertical humerus is assumed). A
   * body with abducted arms needs it: on a tilted humerus a horizontal slab is another piece of bone.
   * For an exactly vertical humerus the two give the same result.
   */
  shaftAligned?: boolean
}

/**
 * 顶点云的主轴（协方差矩阵最大特征值的方向，幂迭代），朝上；以及质心。
 * Principal axis of a vertex cloud (direction of the largest eigenvalue of the covariance, by power iteration), pointing up; and the centroid.
 */
function principalAxis(mesh: Mesh): { c: V3; u: V3 } {
  const p = mesh.positions
  const n = p.length / 3
  const c: V3 = [0, 0, 0]
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) c[k] = c[k]! + p[i + k]! / n
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) m[3 * a + b] = m[3 * a + b]! + (p[i + a]! - c[a]!) * (p[i + b]! - c[b]!)
  let u: V3 = [0, 1, 0]
  for (let it = 0; it < 200; it++) {
    const v: V3 = [m[0]! * u[0] + m[1]! * u[1] + m[2]! * u[2], m[3]! * u[0] + m[4]! * u[1] + m[5]! * u[2], m[6]! * u[0] + m[7]! * u[1] + m[8]! * u[2]]
    const l = Math.hypot(v[0], v[1], v[2]) || 1
    u = [v[0] / l, v[1] / l, v[2] / l]
  }
  if (u[1] < 0) u = [-u[0], -u[1], -u[2]]
  return { c, u }
}

/** Run every check for both sides. */
export function runLandmarkChecks(ctx: LandmarkContext, opts: LandmarkOptions = {}): LandmarkResult[] {
  const out: LandmarkResult[] = []
  for (const side of ['L', 'R'] as const) {
    const S = side === 'L' ? 'Left' : 'Right'
    const s = S.toLowerCase()
    /** +1 when lateral is +X (left side) */
    const lat = side === 'L' ? 1 : -1
    const need = (id: string, claim: string, meshes: string[], nerves: string[]): { m: Mesh[]; n: V3[][] } | LandmarkResult => {
      const m: Mesh[] = []
      for (const name of meshes) {
        const x = ctx.mesh(name)
        if (!x) return missing(id, side, claim, `"${name}"`)
        m.push(x)
      }
      const n: V3[][] = []
      for (const name of nerves) {
        const x = ctx.nerve(name)
        if (!x) return missing(id, side, claim, `nerve "${name}"`)
        n.push(samples(x))
      }
      return { m, n }
    }
    const isResult = (x: unknown): x is LandmarkResult => typeof (x as LandmarkResult).evaluated === 'boolean'

    // 1. median nerve at the wrist
    {
      const id = 'median-wrist'
      const claim = 'median nerve passes palmar to the distal radius, deep to the flexor retinaculum'
      const r = need(id, claim, [`${S} radius`, `Flexor retinaculum of ${s} wrist`], [`${S} median nerve`])
      if (isResult(r)) out.push(r)
      else {
        const [radius, retinaculum] = r.m as [Mesh, Mesh]
        const rb = bboxOf(radius)
        const distal = slabCentroid(radius, rb[1], rb[1] + 0.02)!
        const ret = slabCentroid(retinaculum, -Infinity, Infinity)!
        // palmar direction: from the distal radius towards the retinaculum, horizontal part
        let px = ret[0] - distal[0]
        let pz = ret[2] - distal[2]
        const pl = Math.hypot(px, pz) || 1
        px /= pl
        pz /= pl
        const level = r.n[0]!.filter((p) => p[1] >= rb[1] - 0.005 && p[1] <= rb[1] + 0.02)
        const at = closestTo(level, distal)
        if (!at) out.push(missing(id, side, claim, 'median nerve at the level of the distal radius'))
        else {
          const palmar = (at[0] - distal[0]) * px + (at[2] - distal[2]) * pz
          const retPalmar = (ret[0] - distal[0]) * px + (ret[2] - distal[2]) * pz
          const dRadius = surfaceIndex(radius).distance(at[0], at[1], at[2])
          const tunnel = closestTo(r.n[0]!, ret)!
          const dRet = surfaceIndex(retinaculum).distance(tunnel[0], tunnel[1], tunnel[2])
          const tunnelPalmar = (tunnel[0] - distal[0]) * px + (tunnel[2] - distal[2]) * pz
          const pass = palmar > 0 && dRadius < 0.02 && dRet < 0.008 && tunnelPalmar < retPalmar + 0.003
          out.push({ id, side, claim, pass, evaluated: true, measured: `${mm(palmar)} mm palmar of the distal radius centre (${mm(dRadius)} mm from its surface); ${mm(dRet)} mm from the flexor retinaculum, ${mm(retPalmar - tunnelPalmar)} mm deep to its centre`, values: { palmarOfRadius: palmar * 1000, toRadius: dRadius * 1000, toRetinaculum: dRet * 1000, deepToRetinaculum: (retPalmar - tunnelPalmar) * 1000 } })
        }
      }
    }

    // 2. ulnar nerve behind the medial epicondyle
    {
      const id = 'ulnar-epicondyle'
      const claim = 'ulnar nerve passes posterior to the medial epicondyle of the humerus'
      const r = need(id, claim, [`${S} humerus`], [`${S} ulnar nerve`])
      if (isResult(r)) out.push(r)
      else {
        const humerus = r.m[0]!
        const hb = bboxOf(humerus)
        // medial epicondyle: the most medial vertex of the distal 12% of the humerus
        let epi: V3 | null = null
        const p = humerus.positions
        for (let i = 0; i < p.length; i += 3) {
          if (p[i + 1]! > hb[1] + 0.12 * (hb[4] - hb[1])) continue
          if (!epi || p[i]! * lat < epi[0] * lat) epi = [p[i]!, p[i + 1]!, p[i + 2]!]
        }
        const at = closestTo(r.n[0]!, epi!)!
        const d = dist(at, epi!)
        const posterior = epi![2] - at[2]
        const pass = d < 0.015 && posterior > 0
        out.push({ id, side, claim, pass, evaluated: true, measured: `closest approach ${mm(d)} mm from the epicondyle tip, ${mm(posterior)} mm posterior to it`, values: { toEpicondyle: d * 1000, posterior: posterior * 1000 } })
      }
    }

    // 3. sciatic nerve
    {
      const id = 'sciatic-piriformis'
      const claim = 'sciatic nerve leaves the pelvis below piriformis'
      const r = need(id, claim, [`${S} piriformis`], [`${S} sciatic nerve`])
      if (isResult(r)) out.push(r)
      else {
        const pir = r.m[0]!
        const pb = bboxOf(pir)
        const pc = slabCentroid(pir, -Infinity, Infinity)!
        const idx = surfaceIndex(pir)
        // where the nerve is closest to the muscle, is it under it? compare with the muscle's
        // lower border in the 2 cm wide column around that point
        let at: V3 | null = null
        let bd = Infinity
        for (const q of r.n[0]!) {
          const d = idx.distance(q[0], q[1], q[2], 0.05)
          if (d < bd) {
            bd = d
            at = q
          }
        }
        if (!at) out.push(missing(id, side, claim, 'sciatic nerve within 5 cm of piriformis'))
        else {
          let lower = Infinity
          const p = pir.positions
          for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i]! - at[0]) < 0.01 && Math.abs(p[i + 2]! - at[2]) < 0.015 && p[i + 1]! < lower) lower = p[i + 1]!
          if (!Number.isFinite(lower)) lower = pb[1]
          // highest point of the nerve behind the muscle (posterior to its centroid, within its x range)
          const behind = r.n[0]!.filter((q) => q[2] < pc[2] && q[0] > pb[0] - 0.01 && q[0] < pb[3] + 0.01)
          const top = behind.reduce((m, q) => Math.max(m, q[1]), -Infinity)
          const below = pc[1] - top
          const pass = bd < 0.012 && at[1] < pc[1] + 0.003 && below > -0.005
          out.push({ id, side, claim, pass, evaluated: true, measured: `closest approach ${mm(bd)} mm, there ${mm(pc[1] - at[1])} mm below the muscle's centroid (${mm(at[1] - lower)} mm from its lower border); behind the muscle the nerve stays ${mm(below)} mm below the centroid`, values: { toPiriformis: bd * 1000, belowCentroid: (pc[1] - at[1]) * 1000, fromLowerBorder: (at[1] - lower) * 1000 } })
        }
      }
    }
    {
      const id = 'sciatic-thigh'
      const claim = 'sciatic nerve runs posterior to the femur between biceps femoris and the medial hamstrings'
      const r = need(id, claim, [`${S} femur`, `Long head of ${s} biceps femoris`, `${S} semimembranosus`], [`${S} sciatic nerve`])
      if (isResult(r)) out.push(r)
      else {
        const [femur, biceps, semi] = r.m as [Mesh, Mesh, Mesh]
        const fb = bboxOf(femur)
        const rows: { post: number; between: number; d: number }[] = []
        for (const f of [0.45, 0.55, 0.65]) {
          const y = fb[1] + f * (fb[4] - fb[1])
          const shaft = slabCentroid(femur, y - 0.01, y + 0.01)
          const b = slabCentroid(biceps, y - 0.01, y + 0.01)
          const m = slabCentroid(semi, y - 0.01, y + 0.01)
          if (!shaft || !b || !m) continue
          const level = r.n[0]!.filter((q) => Math.abs(q[1] - y) < 0.004)
          const at = closestTo(level, shaft)
          if (!at) continue
          // position between the medial hamstring (0) and biceps femoris (1) along the line joining them
          const ux = b[0] - m[0]
          const uz = b[2] - m[2]
          const t = ((at[0] - m[0]) * ux + (at[2] - m[2]) * uz) / (ux * ux + uz * uz)
          rows.push({ post: shaft[2] - at[2], between: t, d: Math.hypot(at[0] - shaft[0], at[2] - shaft[2]) })
        }
        if (!rows.length) out.push(missing(id, side, claim, 'sciatic nerve at mid-thigh'))
        else {
          const post = Math.min(...rows.map((x) => x.post))
          const tMin = Math.min(...rows.map((x) => x.between))
          const tMax = Math.max(...rows.map((x) => x.between))
          const dMax = Math.max(...rows.map((x) => x.d))
          const pass = post > 0.005 && tMin > -0.35 && tMax < 1.35 && dMax < 0.07
          out.push({ id, side, claim, pass, evaluated: true, measured: `at 45/55/65% of femur height: ≥ ${mm(post)} mm posterior to the shaft axis, ≤ ${mm(dMax)} mm from it; position between semimembranosus (0) and biceps femoris (1): ${tMin.toFixed(2)}…${tMax.toFixed(2)}`, values: { posteriorMin: post * 1000, fromShaftMax: dMax * 1000, betweenMin: tMin, betweenMax: tMax } })
        }
      }
    }

    // 4. radial nerve in the spiral groove
    {
      const id = 'radial-humerus'
      const claim = 'radial nerve wraps round the posterior humeral shaft from medial to lateral'
      const r = need(id, claim, [`${S} humerus`], [`${S} radial nerve`])
      if (isResult(r)) out.push(r)
      else {
        const humerus = r.m[0]!
        const idx = surfaceIndex(humerus)
        // 骨干坐标系：along = 沿骨干向上的坐标，back / inward = 向后、向 +X 的单位方向（都垂直于骨干）。
        // 缺省（不按骨干对齐）时就是世界坐标的 y、z、x，与原来的做法逐项相同。
        // The shaft frame: `along` = the coordinate up the shaft, `back` / `inward` = unit directions
        // backwards and towards +X (both perpendicular to the shaft). By default (not shaft-aligned) they
        // are the world's y, z and x, term for term what the check did before.
        let u: V3 = [0, 1, 0]
        let zp: V3 = [0, 0, 1]
        let xp: V3 = [1, 0, 0]
        if (opts.shaftAligned) {
          u = principalAxis(humerus).u
          const d = u[2]
          const l = Math.hypot(-d * u[0], -d * u[1], 1 - d * u[2]) || 1
          zp = [(-d * u[0]) / l, (-d * u[1]) / l, (1 - d * u[2]) / l]
          xp = [u[1] * zp[2] - u[2] * zp[1], u[2] * zp[0] - u[0] * zp[2], u[0] * zp[1] - u[1] * zp[0]]
        }
        const along = (x: number, y: number, z: number) => x * u[0] + y * u[1] + z * u[2]
        const hp = humerus.positions
        let s0 = Infinity
        let s1 = -Infinity
        for (let i = 0; i < hp.length; i += 3) {
          const a = along(hp[i]!, hp[i + 1]!, hp[i + 2]!)
          if (a < s0) s0 = a
          if (a > s1) s1 = a
        }
        const hb = [0, s0, 0, 0, s1, 0]
        const h = s1 - s0
        const axisAt = (sv: number): V3 | null => {
          if (!opts.shaftAligned) return slabCentroid(humerus, sv - 0.01, sv + 0.01)
          let n = 0
          const c: V3 = [0, 0, 0]
          for (let i = 0; i < hp.length; i += 3) {
            const a = along(hp[i]!, hp[i + 1]!, hp[i + 2]!)
            if (a < sv - 0.01 || a > sv + 0.01) continue
            c[0] += hp[i]!
            c[1] += hp[i + 1]!
            c[2] += hp[i + 2]!
            n++
          }
          return n ? [c[0] / n, c[1] / n, c[2] / n] : null
        }
        // 取贴骨（15 mm 以内）的采样点中最靠后的一个：桡神经沟里的主干。到肱三头肌的分支离骨 2 cm 以上，
        // 它们是否比主干更靠后与“神经绕过肱骨干后面”无关（在男性静息位上两者只差 0.1 mm）。没有贴骨的采样点时退回到全部采样点。
        // The most posterior of the samples lying on the bone (within 15 mm): the trunk in the radial
        // groove. Branches to triceps run 2 cm and more from the bone, and whether one of them is further
        // back than the trunk says nothing about the nerve wrapping the shaft (on the male at rest the
        // two differ by 0.1 mm). With no sample on the bone, all samples are used as before.
        let best: { post: number; d: number } | null = null
        let bestNear: { post: number; d: number } | null = null
        for (const q of r.n[0]!) {
          const sq = along(q[0], q[1], q[2])
          const f = (sq - hb[1]!) / h
          if (f < 0.3 || f > 0.7) continue
          const a = axisAt(sq)
          if (!a) continue
          const post = (a[0] - q[0]) * zp[0] + (a[1] - q[1]) * zp[1] + (a[2] - q[2]) * zp[2]
          const d = idx.distance(q[0], q[1], q[2])
          if (!best || post > best.post) best = { post, d }
          if (d < 0.015 && (!bestNear || post > bestNear.post)) bestNear = { post, d }
        }
        if (bestNear) best = bestNear
        const medialAt = (f0: number, f1: number): number | null => {
          const v: number[] = []
          for (const q of r.n[0]!) {
            const sq = along(q[0], q[1], q[2])
            const f = (sq - hb[1]!) / h
            if (f < f0 || f > f1) continue
            const a = axisAt(sq)
            if (a) v.push(((a[0] - q[0]) * xp[0] + (a[1] - q[1]) * xp[1] + (a[2] - q[2]) * xp[2]) * lat)
          }
          return v.length ? median(v) : null
        }
        const proximal = medialAt(0.72, 0.9)
        const distal = medialAt(0.1, 0.28)
        if (!best || proximal === null || distal === null) out.push(missing(id, side, claim, 'radial nerve along the humeral shaft'))
        else {
          const pass = best.post > 0.003 && best.d < 0.015 && proximal > 0 && distal < 0
          out.push({ id, side, claim, pass, evaluated: true, measured: `mid-shaft: up to ${mm(best.post)} mm posterior to the shaft axis, ${mm(best.d)} mm from the bone; ${mm(proximal)} mm medial of the axis proximally, ${mm(-distal)} mm lateral distally`, values: { posterior: best.post * 1000, toBone: best.d * 1000, medialProximal: proximal * 1000, lateralDistal: -distal * 1000 } })
        }
      }
    }

    // 5. common fibular nerve at the fibular neck
    {
      const id = 'fibular-neck'
      const claim = 'common fibular nerve winds round the neck of the fibula on its lateral side'
      const r = need(id, claim, [`${S} fibula`], [`${S} common fibular nerve`])
      if (isResult(r)) out.push(r)
      else {
        const fibula = r.m[0]!
        const fb = bboxOf(fibula)
        const idx = surfaceIndex(fibula)
        const y0 = fb[4] - 0.05
        const y1 = fb[4] - 0.01
        const neck = slabCentroid(fibula, y0, y1)!
        let bd = Infinity
        let at: V3 | null = null
        for (const q of r.n[0]!) {
          if (q[1] < y0 - 0.01 || q[1] > y1 + 0.01) continue
          const d = idx.distance(q[0], q[1], q[2], 0.05)
          if (d < bd) {
            bd = d
            at = q
          }
        }
        if (!at) out.push(missing(id, side, claim, 'common fibular nerve at the level of the fibular neck'))
        else {
          const lateral = (at[0] - neck[0]) * lat
          const posterior = neck[2] - at[2]
          const pass = bd < 0.008 && (lateral > 0 || posterior > 0) && lateral > -0.004
          out.push({ id, side, claim, pass, evaluated: true, measured: `${mm(bd)} mm from the fibula 1–5 cm below its tip, ${mm(lateral)} mm lateral and ${mm(posterior)} mm posterior of the neck's axis`, values: { toFibula: bd * 1000, lateral: lateral * 1000, posterior: posterior * 1000 } })
        }
      }
    }

    // 6. femoral nerve and artery under the inguinal ligament
    {
      const id = 'femoral-triangle'
      const claim = 'femoral nerve lies lateral to the femoral artery where they pass under the inguinal ligament'
      const r = need(id, claim, [`${S} inguinal ligament`, `${S} femoral artery`], [`${S} femoral nerve`])
      if (isResult(r)) out.push(r)
      else {
        const [lig, artery] = r.m as [Mesh, Mesh]
        const ligIdx = surfaceIndex(lig)
        // where the artery is closest to the ligament
        let ap: V3 | null = null
        let ad = Infinity
        const p = artery.positions
        for (let i = 0; i < p.length; i += 3) {
          const d = ligIdx.distance(p[i]!, p[i + 1]!, p[i + 2]!, 0.06)
          if (d < ad) {
            ad = d
            ap = [p[i]!, p[i + 1]!, p[i + 2]!]
          }
        }
        const a = ap ? slabCentroid(artery, ap[1] - 0.006, ap[1] + 0.006) : null
        const level = ap ? r.n[0]!.filter((q) => Math.abs(q[1] - ap![1]) < 0.006) : []
        const at = a ? closestTo(level, a) : null
        if (!a || !at) out.push(missing(id, side, claim, 'femoral nerve at the level where the artery meets the ligament'))
        else {
          const lateral = (at[0] - a[0]) * lat
          const sep = Math.hypot(at[0] - a[0], at[2] - a[2])
          const dLig = ligIdx.distance(at[0], at[1], at[2])
          const pass = lateral > 0.002 && sep < 0.04 && dLig < 0.03
          out.push({ id, side, claim, pass, evaluated: true, measured: `${mm(lateral)} mm lateral of the artery (${mm(sep)} mm apart), ${mm(dLig)} mm from the ligament; artery ${mm(ad)} mm from the ligament`, values: { lateral: lateral * 1000, separation: sep * 1000, toLigament: dLig * 1000 } })
        }
      }
    }

    // 7. brachial plexus roots between the scalenes
    {
      const id = 'plexus-scalenes'
      const claim = 'roots of the brachial plexus emerge between scalenus anterior and scalenus medius'
      const ant = ctx.mesh(`${S} scalenus anterior`)
      const med = ctx.mesh(`${S} scalenus medius`)
      const roots = ['C5', 'C6', 'C7', 'C8', 'T1'].map((l) => [l, ctx.nerve(`${S} ${l} root of brachial plexus`)] as const).filter((x) => x[1]) as [string, Polyline[]][]
      if (!ant || !med || !roots.length) out.push(missing(id, side, claim, !ant || !med ? 'a scalene muscle' : 'brachial plexus roots'))
      else {
        const antIdx = surfaceIndex(ant)
        const medIdx = surfaceIndex(med)
        const rows: { level: string; t: number; dAnt: number; dMed: number }[] = []
        for (const [level, lines] of roots) {
          // the point of the root that is closest to both muscles at once
          let best: { q: V3; s: number; dAnt: number; dMed: number } | null = null
          for (const q of samples(lines)) {
            const dAnt = antIdx.distance(q[0], q[1], q[2], 0.04)
            const dMed = medIdx.distance(q[0], q[1], q[2], 0.04)
            const sc = Math.max(dAnt, dMed)
            if (!best || sc < best.s) best = { q, s: sc, dAnt, dMed }
          }
          if (!best || !Number.isFinite(best.s)) continue
          const a = slabCentroid(ant, best.q[1] - 0.008, best.q[1] + 0.008)
          const m = slabCentroid(med, best.q[1] - 0.008, best.q[1] + 0.008)
          if (!a || !m) continue
          const ux = a[0] - m[0]
          const uz = a[2] - m[2]
          const t = ((best.q[0] - m[0]) * ux + (best.q[2] - m[2]) * uz) / (ux * ux + uz * uz)
          rows.push({ level, t, dAnt: best.dAnt, dMed: best.dMed })
        }
        if (!rows.length) out.push(missing(id, side, claim, 'a root passing within 4 cm of both scalenes at a level where both exist'))
        else {
          const ok = rows.filter((x) => x.t > -0.25 && x.t < 1.25 && Math.max(x.dAnt, x.dMed) < 0.012)
          const pass = ok.length >= Math.ceil(rows.length * 0.6)
          out.push({ id, side, claim, pass, evaluated: true, measured: rows.map((x) => `${x.level}: ${x.t.toFixed(2)} between medius (0) and anterior (1), ${mm(x.dMed)} / ${mm(x.dAnt)} mm from them`).join('; '), values: { rootsBetween: ok.length, rootsEvaluated: rows.length, worstDistance: Math.max(...rows.map((x) => Math.max(x.dAnt, x.dMed))) * 1000 } })
        }
      }
    }

    // 8. intercostal nerves under their ribs
    {
      const id = 'intercostal-ribs'
      const claim = 'each intercostal nerve follows the inferior border of its own rib'
      const rows: { n: number; d: number; below: number; own: number }[] = []
      for (let n = 1; n <= 11; n++) {
        const nerve = ctx.nerve(`${S} ${ORDINALS[n - 1]!.toLowerCase()} intercostal nerve`)
        const rib = ctx.mesh(`${S} ${ORDINALS[n - 1]!.toLowerCase()} rib`)
        const next = ctx.mesh(`${S} ${ORDINALS[n]!.toLowerCase()} rib`)
        if (!nerve || !rib || !next) continue
        const ribIdx = new PointIndex(surfacePoints(rib, 0.0015), 0.004)
        const nextIdx = surfaceIndex(next)
        const rbx = bboxOf(rib)
        const ds: number[] = []
        let below = 0
        let own = 0
        let count = 0
        const I = new Int32Array(1)
        const D = new Float64Array(1)
        for (const q of samples(nerve)) {
          // alongside the rib only: not the part that runs on past the costal cartilage
          if (q[0] < rbx[0] - 0.005 || q[0] > rbx[3] + 0.005 || q[2] < rbx[2] - 0.005 || q[2] > rbx[5] + 0.005) continue
          if (!ribIdx.nearest(q[0], q[1], q[2], 1, I, D)) continue
          const d = Math.sqrt(D[0]!)
          ds.push(d)
          count++
          if (ribIdx.points[3 * I[0]! + 1]! > q[1]) below++
          if (d < nextIdx.distance(q[0], q[1], q[2])) own++
        }
        if (count < 20) continue
        rows.push({ n, d: median(ds), below: below / count, own: own / count })
      }
      if (!rows.length) out.push(missing(id, side, claim, 'intercostal nerves or ribs'))
      else {
        const ok = rows.filter((x) => x.d < 0.006 && x.own > 0.8)
        const pass = ok.length >= rows.length - 1
        out.push({ id, side, claim, pass, evaluated: true, measured: rows.map((x) => `${x.n}: ${mm(x.d)} mm from rib ${x.n} (median), ${(x.own * 100).toFixed(0)}% nearer it than rib ${x.n + 1}, ${(x.below * 100).toFixed(0)}% below its nearest rib point`).join('; '), values: { nerves: rows.length, ok: ok.length, worstMedianDistance: Math.max(...rows.map((x) => x.d)) * 1000, meanBelow: rows.reduce((a, x) => a + x.below, 0) / rows.length } })
      }
    }
  }
  return out
}

/**
 * Agreement between an imported nerve and an existing nerve part: median distance from the
 * existing part's surface to the imported centreline, restricted to the stretch where the two
 * overlap along the imported line. Returns NaN when they do not overlap.
 */
export function nerveAgreement(existing: Mesh, imported: Polyline[]): { median: number; max: number; overlap: number } {
  const pts = samples(imported)
  if (!pts.length) return { median: NaN, max: NaN, overlap: 0 }
  const flat = new Float32Array(pts.length * 3)
  pts.forEach((p, i) => flat.set(p, 3 * i))
  const idx = new PointIndex(flat, 0.005)
  const surf = surfacePoints(existing, 0.0015)
  const d: number[] = []
  for (let i = 0; i < surf.length; i += 3) d.push(idx.distance(surf[i]!, surf[i + 1]!, surf[i + 2]!))
  d.sort((a, b) => a - b)
  return { median: d[Math.floor((d.length - 1) / 2)] ?? NaN, max: d[d.length - 1] ?? NaN, overlap: d.filter((x) => x < 0.005).length / Math.max(1, d.length) }
}
