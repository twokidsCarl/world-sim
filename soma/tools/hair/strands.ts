// 头发的引导发丝：按几条造型规则（分缝、长度场、梳理方向、重力）"梳"出初始形状，再做一段离线的 PBD 沉降
// （不可伸长、弯曲、重力、与皮肤相碰），最后加波纹、剪齐。
// Guide strands of scalp hair: an initial shape "combed" by a few style rules (part line, length field, comb direction,
// gravity), then a short offline PBD settle (inextensible, bending, gravity, collisions with the skin), then waves and
// a blunt cut.

import { type HeadFrame, azimuth, fromHeadDir, toHead } from './frame.ts'
import { type V3, add, dot, gauss, len, mix, norm, rng, scale, sub, type Surface, tangential, cross } from './geom.ts'
import type { Root } from './sample.ts'

export type ScalpStyle = 'short' | 'long'

export interface Strand {
  root: Root
  /** 点列，第一个点是根 / the points; the first is the root */
  pts: V3[]
  /** 层：0 贴着头皮，1 在最外面 / layer: 0 against the scalp, 1 outermost */
  layer: number
  /** 波纹相位（弧度）/ wave phase (radians) */
  phase: number
}

export interface StyleRule {
  id: ScalpStyle
  /** 每根发丝的点数 / points per strand */
  points: number
  /** 根部的发长（米）/ hair length at a root (m) */
  length: (l: V3, root: Root) => number
  /** 梳理方向（头部坐标，不必单位长）/ comb direction (head coordinates, need not be unit) */
  flow: (l: V3, nHead: V3) => V3
  /** 出皮肤的仰角（弧度）/ exit angle from the skin (radians) */
  lift: number
  /** 每段最多转多少（0–1，越小越硬）/ how much each segment may turn (0–1, smaller is stiffer) */
  turn: number
  /** 离开头皮垂下去（长发）/ leaves the scalp and hangs (long hair) */
  hangs: boolean
  /** 最外层离皮肤的距离（米）/ distance of the outermost layer from the skin (m) */
  volume: number
  /** PBD：步数、弯曲刚度（0–1）、重力倍数 / PBD: steps, bending stiffness (0–1), gravity factor */
  settle: { steps: number; bend: number; gravity: number }
  /** 波纹振幅（米）和波长（米）/ wave amplitude (m) and wavelength (m) */
  wave: { amplitude: number; length: number }
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 发旋（头顶稍后）：之后的头发从这里向四周往下 / the whorl (just behind the vertex): behind it the hair radiates outward and down */
export const WHORL_Z = -0.025
/** 分缝的位置（头部坐标 x，正 = 身体左侧）/ the part's position (head x, positive = the body's left) */
export const PART: Record<ScalpStyle, number> = { short: 0.035, long: 0.008 }
/** 在发旋之后的程度（0 前 … 1 后）：分缝只到发旋为止 / how far behind the whorl (0 front … 1 behind): the part runs only as far as the whorl */
const behindCrown = (l: V3): number => smooth(WHORL_Z + 0.015, WHORL_Z - 0.02, l[2])
/** 从发旋放射、略向下 / radiating from the whorl, a little downward */
const crownFlow = (l: V3): V3 => {
  const r = norm([l[0], 0, l[2] - WHORL_Z])
  return norm([r[0], -0.35, r[2]])
}

/** 两种造型 / the two styles */
export function styleRule(id: ScalpStyle, f: HeadFrame, P: Record<string, any>, hairlineHeight: (l: V3) => number): StyleRule {
  const curvature = P.fibreCurvature.value * 1000 // 1/m
  const waveLength = P.waveLength.value / 1000
  const amplitude = curvature * (waveLength / (2 * Math.PI)) ** 2
  if (id === 'short') {
    const L = P.styleShortLength
    // 左侧分缝（身体左侧离中线 3.5 厘米）/ a side part on the body's left, 3.5 cm from the midline
    const part = PART.short
    return {
      id,
      points: 8,
      length: (l) => {
        const t = smooth(-0.01, f.top - 0.045, l[1])
        const front = smooth(0.02, 0.09, l[2]) * 0.006
        // 两侧和后面在发际线附近修短（渐短），后颈修得最短 / the sides and back are tapered near the hairline, the nape shortest
        const hl = hairlineHeight(l)
        const back = Math.abs(azimuth(l)) > 110
        const taper = Math.abs(azimuth(l)) > 50 ? (back ? 0.25 + 0.75 * smooth(hl, hl + 0.05, l[1]) : 0.4 + 0.6 * smooth(hl, hl + 0.035, l[1])) : 1
        return ((L.sides + (L.top - L.sides) * t) / 1000 + front) * taper
      },
      flow: (l, n) => {
        // 前额一带（不论法线朝哪）也按头顶的规则梳：往分缝两侧，不往额头上垂
        // around the forehead (whatever the normal) the top rule applies too: away from the part, not down over the brow
        const front = smooth(0.03, 0.07, l[2])
        const wTop = Math.max(smooth(0.35, 0.8, n[1]), front)
        const side = l[0] > part ? 1 : -1
        const fringe = smooth(0.02, 0.07, l[2])
        const parted: V3 = norm([side * 0.85, 0.05 + 0.2 * front, -0.5 + fringe * 0.4])
        const top = norm(mix(parted, crownFlow(l), behindCrown(l)))
        // 两侧往后下梳，后面往下 / the sides are combed back and down, the back down
        const low: V3 = norm([0, -0.55, -0.85])
        return norm(mix(low, top, wTop))
      },
      lift: (20 * Math.PI) / 180,
      turn: 0.45,
      hangs: false,
      volume: 0.0035,
      settle: { steps: 16, bend: 0.6, gravity: 0.3 },
      wave: { amplitude: 0, length: waveLength },
    }
  }
  // 长发：近中缝（偏左 8 毫米），一刀齐 / long hair: a near-centre part (8 mm left), a blunt cut
  const part = PART.long
  return {
    id,
    points: 32,
    length: () => P.styleLongLength.value / 1000,
    flow: (l, n) => {
      // 前额发际线一带往上、往两侧后方梳（不往脸上垂）/ around the front hairline, combed up and back to the sides (never down over the face)
      const front = smooth(0.02, 0.06, l[2])
      const wTop = Math.max(smooth(0.4, 0.85, n[1]), front)
      const side = l[0] > part ? 1 : -1
      const parted: V3 = norm([side * 0.9, -0.05 + 0.35 * front, -0.35 - 0.3 * front])
      const top = norm(mix(parted, crownFlow(l), behindCrown(l)))
      const low: V3 = norm([0, -1, -0.25])
      return norm(mix(low, top, wTop))
    },
    lift: (15 * Math.PI) / 180,
    turn: 0.3,
    hangs: true,
    volume: 0.022,
    settle: { steps: 90, bend: 0.08, gravity: 1 },
    wave: { amplitude, length: waveLength },
  }
}

/** "向外"方向：离开头的竖直中轴（头顶附近离开头心）/ "outward": away from the head's vertical axis (away from the head centre near the top) */
export function outward(f: HeadFrame, p: V3): V3 {
  const l = toHead(f, p)
  const c = Math.min(Math.max(l[1], -0.3), 0.02)
  return norm(fromHeadDir(f, [l[0], l[1] - c, l[2]]))
}

/** 把点推到皮肤外 `margin` 处 / push a point to `margin` outside the skin */
function collide(surface: Surface, p: V3, margin: number, reach = 0.006): { p: V3; n: V3 | null } {
  const c = surface.closest(p, margin + reach)
  if (!c) return { p, n: null }
  const d = dot(sub(p, c.point), c.normal)
  if (d < margin) return { p: add(c.point, scale(c.normal, margin)), n: c.normal }
  return { p, n: c.normal }
}

/** 层的边距：根部为 0，2 厘米内渐增到该层的距离 / layer margin: 0 at the root, growing to the layer's distance within 2 cm */
const marginAt = (layer: number, volume: number, s: number): number => 0.0006 + volume * layer * smooth(0, 0.025, s)

/** 梳出一根引导发丝并沉降 / comb one guide strand and settle it */
export function growStrand(f: HeadFrame, surface: Surface, rule: StyleRule, root: Root, layer: number, seed: number, cutY: ((phi: number) => number) | null): Strand {
  const r = rng(seed)
  const lRoot = toHead(f, root.p)
  // 长度的个体差异：短发 ±12%，层的末端不会排成一条线；长发 ±6% / individual length variation: ±12 % for short hair, so layer ends do not line up; ±6 % for long
  const L0 = rule.length(lRoot, root) * (1 + (rule.hangs ? 0.06 : 0.12) * gauss(r))
  const L = cutY ? L0 * 1.25 : L0
  const N = rule.points
  const seg = L / (N - 1)
  const toWorld = (d: V3): V3 => fromHeadDir(f, d)
  const nHead = (n: V3): V3 => {
    const d = sub(add(f.origin, n), f.origin)
    return [dot(d, f.x), dot(d, f.y), dot(d, f.z)]
  }
  const down: V3 = scale(f.y, -1)
  let flow = norm(tangential(toWorld(rule.flow(lRoot, nHead(root.n))), root.n))
  // 一点随机的偏转 / a little random deflection
  flow = norm(add(flow, scale(norm(cross(root.n, flow)), 0.18 * gauss(r))))
  let d = norm(add(scale(flow, Math.cos(rule.lift)), scale(root.n, Math.sin(rule.lift))))
  const pts: V3[] = [root.p]
  // 贴着头皮、在眼高以上梳好的部分不动（发型的"定型"，代替发丝间的摩擦）/ the part combed against the scalp above eye height stays put (the style's "hold", standing in for friction between hairs)
  const held: boolean[] = [true]
  let n = root.n
  for (let k = 1; k < N; k++) {
    let p = add(pts[k - 1]!, scale(d, seg))
    const c = collide(surface, p, marginAt(layer, rule.volume, k * seg))
    p = c.p
    if (c.n) n = c.n
    pts.push(p)
    const near = !!c.n
    const l = toHead(f, p)
    held.push(held[k - 1]! && near && l[1] > 0.0)
    let target = norm(tangential(toWorld(rule.flow(l, nHead(n))), n))
    // 长发在脸前面不垂：先顺着头皮往两侧后方梳过去，到了脸的平面以后（或脸的宽度以外）才垂下
    // long hair does not hang in front of the face: it is combed over the scalp to the sides and back first, and hangs only behind the face plane (or outside the face's width)
    const clear = l[2] < 0.03 || (Math.abs(l[0]) > 0.085 && l[2] < 0.05)
    if (rule.hangs && clear && (!near || (dot(n, f.y) < 0.3 && dot(target, down) > 0.2))) target = down
    // 贴着头皮的部分顺着曲面转 / hugging the scalp, follow the surface round
    if (near && !rule.hangs) target = norm(add(target, scale(n, -0.15)))
    d = norm(mix(d, target, rule.turn))
  }
  settle(surface, rule, pts, layer, seg, held)
  if (cutY) {
    // 剪齐：到剪口高度为止 / the blunt cut: stop at the cut height
    const cut = cutY(azimuth(lRoot))
    // 剪口高度、离中线太远（搭在肩上往外滑的发丝），或者长度到了 / the cut height, too far from the midline (strands sliding outward over the shoulder), or the full length
    let arc = 0
    let k = pts.findIndex((p, i) => p[1] < cut || Math.abs(toHead(f, p)[0]) > 0.14 || (i > 0 && (arc += len(sub(p, pts[i - 1]!))) > L0))
    if (k > 1) {
      const a = pts[k - 1]!, b = pts[k]!
      // 只有剪口高度触发时才插到剪口上；其余情况停在前一点 / interpolate onto the cut only when the cut height triggered; otherwise stop at the previous point
      const t = b[1] < cut ? Math.min(1, Math.max(0, (a[1] - cut) / (a[1] - b[1]))) : 0
      const out = pts.slice(0, k)
      out.push(mix(a, b, t))
      return { root, pts: resample(out, N), layer, phase: wavePhase(root.p) }
    }
  }
  return { root, pts, layer, phase: wavePhase(root.p) }
}

/** 波纹相位随根的位置平滑变化：相邻的发丝一起起伏（成缕）/ the wave phase varies smoothly with the root position: neighbouring strands wave together (in locks) */
function wavePhase(p: V3): number {
  return 2 * Math.PI * (0.5 + 0.25 * Math.sin(p[0] * 61 + p[2] * 23) + 0.25 * Math.sin(p[1] * 47 - p[2] * 53 + 1.7))
}

/** PBD 沉降：根和第一段固定，距离约束、弯曲（隔一个点的距离）、重力、碰撞 / PBD settle: root and first segment fixed; distance, bending (distance to the point after next), gravity, collisions */
function settle(surface: Surface, rule: StyleRule, pts: V3[], layer: number, seg: number, held: boolean[]): void {
  const N = pts.length
  const rest2 = pts.slice(0, N - 2).map((p, i) => len(sub(pts[i + 2]!, p)))
  const vel: V3[] = pts.map(() => [0, 0, 0])
  const dt = 1 / 60
  const g = 9.81 * rule.settle.gravity
  for (let step = 0; step < rule.settle.steps; step++) {
    const prev = pts.map((p) => p)
    for (let i = 2; i < N; i++) {
      if (held[i]) continue
      vel[i] = scale(vel[i]!, 0.9)
      vel[i]![1] -= g * dt
      pts[i] = add(pts[i]!, scale(vel[i]!, dt))
    }
    for (let it = 0; it < 4; it++) {
      for (let i = 0; i < N - 1; i++) {
        // 距离 / distance
        project(pts, i, i + 1, seg, 1, held)
      }
      for (let i = 0; i < N - 2; i++) project(pts, i, i + 2, rest2[i]!, rule.settle.bend, held)
    }
    if (step % 2 === 0 || step === rule.settle.steps - 1) for (let i = 2; i < N; i++) if (!held[i]) pts[i] = collide(surface, pts[i]!, marginAt(layer, rule.volume, i * seg)).p
    for (let i = 2; i < N; i++) vel[i] = scale(sub(pts[i]!, prev[i]!), 1 / dt)
  }
}

/** 一条距离约束：固定的点（根、第一段、定型部分）不动 / one distance constraint: fixed points (root, first segment, held part) do not move */
function project(pts: V3[], i: number, j: number, rest: number, k: number, held: boolean[]): void {
  const fi = i < 2 || held[i]!, fj = j < 2 || held[j]!
  if (fi && fj) return
  const a = pts[i]!, b = pts[j]!
  const dv = sub(b, a)
  const l = len(dv) || 1e-9
  const corr = scale(dv, ((l - rest) / l) * k)
  if (fi) pts[j] = sub(b, corr)
  else if (fj) pts[i] = add(a, corr)
  else {
    pts[i] = add(a, scale(corr, 0.5))
    pts[j] = sub(b, scale(corr, 0.5))
  }
}

/** 按弧长重采样成 n 个点 / resample to n points by arc length */
export function resample(pts: V3[], n: number): V3[] {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + len(sub(pts[i]!, pts[i - 1]!)))
  const total = cum[cum.length - 1]!
  const out: V3[] = []
  let j = 0
  for (let k = 0; k < n; k++) {
    const s = (total * k) / (n - 1)
    while (j < pts.length - 2 && cum[j + 1]! < s) j++
    const t = (s - cum[j]!) / ((cum[j + 1]! - cum[j]!) || 1)
    out.push(mix(pts[j]!, pts[j + 1]!, Math.min(1, Math.max(0, t))))
  }
  return out
}

/** 波纹：沿副法线的正弦位移，根部为零、5 厘米内长到满幅，然后再推出皮肤 / waves: a sine offset along the binormal, zero at the root and full within 5 cm, then pushed out of the skin again */
export function addWaves(f: HeadFrame, surface: Surface, rule: StyleRule, s: Strand, phase: number): V3[] {
  if (rule.wave.amplitude <= 0) return s.pts
  const out: V3[] = [s.pts[0]!]
  let arc = 0
  for (let i = 1; i < s.pts.length; i++) {
    arc += len(sub(s.pts[i]!, s.pts[i - 1]!))
    const t = norm(sub(s.pts[i]!, s.pts[i - 1]!))
    const b = norm(cross(t, outward(f, s.pts[i]!)))
    const a = rule.wave.amplitude * smooth(0, 0.05, arc) * Math.sin((2 * Math.PI * arc) / rule.wave.length + phase)
    out.push(collide(surface, add(s.pts[i]!, scale(b, a)), marginAt(s.layer, rule.volume, arc) * 0.8).p)
  }
  // 最后再查一遍，搜得远一些（耳前的凹处最近点可能在近 1 厘米外）/ a last pass searching further (in the hollow in front of the ear the closest point can be nearly 1 cm away)
  for (let i = 1; i < out.length; i++) out[i] = collide(surface, out[i]!, 0.0004, 0.012).p
  return out
}
