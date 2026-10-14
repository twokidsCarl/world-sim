// 头皮：发际线（按每个人体自己的鼻根、耳廓定）、密度场（文献的每平方厘米根数，颞部低一些，发际线处渐变）、毛囊单位和毛囊。
// The scalp: the hairline (set from each body's own nasion and auricles), the density field (hairs per cm² from the
// literature, lower at the temples, ramping in at the hairline), follicular units and follicles.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type HeadFrame, type Knot, azimuth, earDistance, hairlineAt, toHead } from './frame.ts'
import { type V3, add, cross, hash01, norm, rng, scale, type Surface } from './geom.ts'
import { type Root, rootAt, scatter } from './sample.ts'
import { ROOT, type BodyData } from './skin.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Params = Record<string, any>
export function loadParams(): Params {
  return (JSON.parse(readFileSync(join(ROOT, 'data', 'curated', 'hair', 'hair.json'), 'utf8')) as { values: Params }).values
}

export interface Scalp {
  knots: Knot[]
  /** 头皮上一点的密度（根每平方米）/ density at a point of the scalp (hairs per m²) */
  density: (p: V3) => number
  /** 离发际线的高度（米，负 = 在发际线下）/ height above the hairline (m; negative = below it) */
  aboveHairline: (p: V3) => number
  /** 头皮的三角形（候选区域）/ the scalp's triangles (candidate region) */
  triangles: [number, number, number][]
}

/** 发际线以内这段距离里密度从 0 渐增到满（米）/ density ramps from 0 to full over this distance inside the hairline (m) */
const RAMP = 0.006
/** 离耳廓至少这么远（米）/ keep at least this far from the auricle (m) */
export const EAR_MARGIN = 0.007

/**
 * 发际线控制点。额中（trichion）高度 = 鼻根高度 + 额高（按性别）；颞部内收，鬓角落在耳前，绕过耳廓上方，到后颈。
 * 后面这些相对位置是对照男性头发外壳的覆盖范围定的（本项目的假设）。
 * The hairline knots. Mid-forehead (trichion) height = nasion height + forehead height (by sex); the temples recede,
 * the sideburn ends in front of the ear, the line passes over the auricle and down to the nape. These relative
 * positions were set against the coverage of the male hair shell (this project's assumption).
 */
export function hairlineKnots(f: HeadFrame, body: 'male' | 'female', P: Params): Knot[] {
  const front = f.nasion[1] + P.foreheadHeightBySex[body] / 1000
  const ear = f.ears[0]!
  const earFront = Math.min(f.ears[0]!.phi[0], f.ears[1]!.phi[0])
  const earBack = Math.max(f.ears[0]!.phi[1], f.ears[1]!.phi[1])
  const earTop = Math.max(f.ears[0]!.h[1], f.ears[1]!.h[1])
  const earBottom = Math.min(ear.h[0], f.ears[1]!.h[0])
  const male = body === 'male'
  const nape = earBottom - 0.012
  return [
    [0, front],
    [22, front + (male ? 0.004 : -0.002)],
    [33, front - (male ? 0.004 : 0.008)],
    [48, front - (male ? 0.03 : 0.036)],
    [earFront - 12, earTop + 0.012],
    [earFront - 3, earTop - (male ? 0.02 : 0.008)],
    [earFront + 4, earTop + 0.014],
    [earBack - 2, earTop + 0.012],
    [earBack + 6, earBottom + 0.01],
    [earBack + 25, nape + 0.008],
    [160, nape],
    [180, nape - 0.002],
  ]
}

export function makeScalp(b: BodyData, f: HeadFrame, P: Params): Scalp {
  const knots = hairlineKnots(f, b.body, P)
  const full = P.scalpDensity.value * 1e4 // 每平方米 / per m²
  const temporal = P.temporalDensityRatio.value
  // 发际线上的低频起伏（±2 毫米）/ low-frequency wobble of the hairline (±2 mm)
  const wobble = (phi: number): number => 0.0012 * Math.sin((phi * Math.PI) / 23 + 1.3) + 0.0008 * Math.sin((phi * Math.PI) / 9.5 + 0.4)
  const aboveHairline = (p: V3): number => {
    const l = toHead(f, p)
    const phi = azimuth(l)
    return l[1] - (hairlineAt(knots, phi) + wobble(phi))
  }
  const density = (p: V3): number => {
    const l = toHead(f, p)
    const phi = Math.abs(azimuth(l))
    const above = l[1] - (hairlineAt(knots, phi) + wobble(phi))
    if (above <= 0) return 0
    const ed = earDistance(f, l)
    if (ed < EAR_MARGIN) return 0
    const ramp = Math.min(1, above / RAMP) * Math.min(1, (ed - EAR_MARGIN) / 0.004)
    // 颞顶区（方位角 50°–120°、头顶以下）密度低一些 / the temporoparietal region (azimuth 50°–120°, below the top) is less dense
    const side = phi > 50 && phi < 125 && l[1] < f.top * 0.6 ? temporal : 1
    return full * ramp * ramp * side
  }
  const lowest = Math.min(...knots.map((k) => k[1])) - 0.01
  const triangles: [number, number, number][] = []
  const I = b.skin.indices, Pp = b.skin.positions
  for (let t = 0; t < I.length; t += 3) {
    const tri: [number, number, number] = [I[t]!, I[t + 1]!, I[t + 2]!]
    let keep = false
    for (const v of tri) {
      const l = toHead(f, [Pp[v * 3]!, Pp[v * 3 + 1]!, Pp[v * 3 + 2]!])
      if (l[1] > lowest && Math.hypot(l[0], l[2]) < 0.14) keep = true
    }
    if (keep) triangles.push(tri)
  }
  return { knots, density, aboveHairline, triangles }
}

export interface Follicle extends Root {
  /** 所属毛囊单位 / the follicular unit it belongs to */
  unit: number
}

/**
 * 毛囊：先按"每平方厘米根数 / 每单位平均根数"撒毛囊单位，每个单位再按 1–4 根的比例分出毛囊（离中心 ≤ 0.2 毫米）。
 * 发际线渐变带里只有单根的单位。
 * Follicles: follicular units are scattered at (hairs per cm² / mean hairs per unit), then each unit splits into 1–4
 * follicles (≤ 0.2 mm from its centre) by the given proportions. Units in the hairline ramp hold single hairs.
 */
export function follicles(b: BodyData, scalp: Scalp, surface: Surface, P: Params, seed: number): { units: Root[]; follicles: Follicle[] } {
  const perUnit = P.hairsPerUnit.value as number
  const units = scatter(b.skin.positions, b.normals, scalp.triangles, (p) => scalp.density(p) / perUnit, seed)
  const dist = Object.entries(P.hairsPerUnit.distribution as Record<string, number>).map(([k, v]) => [Number(k), v] as const)
  const r = rng(seed + 1)
  const out: Follicle[] = []
  units.forEach((u, i) => {
    let k = 1
    if (scalp.aboveHairline(u.p) > RAMP) {
      let x = r()
      for (const [n, w] of dist) {
        k = n
        if ((x -= w) <= 0) break
      }
    }
    const t1 = norm(cross(u.n, Math.abs(u.n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]))
    const t2 = cross(u.n, t1)
    for (let j = 0; j < k; j++) {
      const a = (j / k) * 2 * Math.PI + hash01(i, 7) * 6.28
      const rad = k === 1 ? 0 : 0.00012 + 0.00008 * r()
      const q = add(u.p, add(scale(t1, Math.cos(a) * rad), scale(t2, Math.sin(a) * rad)))
      const c = surface.closest(q, 0.002)
      if (!c) continue
      const [va, vb, vc] = surface.triangle(c.face)
      out.push({ ...rootAt(b.skin.positions, b.normals, [va, vb, vc], c.bary), unit: i })
    }
  })
  return { units, follicles: out }
}
