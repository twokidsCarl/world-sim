// 从应用状态推导每个部件的显示状态，都是纯函数。这里不用 three.js，所以规则可以单元测试（tests/app*.test.ts），拾取也复用它们。
// Pure derivations from app state to per-part display state. No three.js here so the
// rules can be unit-tested (tests/app*.test.ts) and reused by picking.

import { boundsCenter, type AnatomyGraph, type Bounds } from '../anatomy/graph.ts'
import type { Provenance, SystemId, Vec3 } from '../anatomy/types.ts'

export const HIDDEN = 0
export const NORMAL = 1
export const GHOST = 2

export interface SystemState {
  visible: boolean
  opacity: number
}

export interface DisplayInput {
  systems: Partial<Record<SystemId, SystemState>>
  /** 深度小于 peel 的层被剥掉。 */
  /** Layers with depth < peel are peeled away. */
  peel: number
  hidden: ReadonlySet<string>
  /** 被滤掉的来源类别（例如隐藏所有非扫描重建的部件）。 */
  /** Provenance kinds filtered out (e.g. hide everything that was not scanned). */
  provenanceHidden?: ReadonlySet<Provenance>
  /** 设置后只显示这些部件（忽略系统开关和剥层）。 */
  /** When set, only these parts are shown (system toggles and peel are ignored). */
  isolated: ReadonlySet<string> | null
  /** 除了选中的部件及其相邻部件，其余都画成淡影。 */
  /** Ghost everything except the selection and its adjacent parts. */
  adjacentMode: boolean
  selected: ReadonlySet<string>
  /**
   * 皮肤画成不透明时要藏起来的部件（头发、眉毛、阴毛的网格还没有贴合新皮肤）；被选中或被隔离的仍然显示。
   * Parts to hide while the skin is drawn opaque (the hair, eyebrow and pubic-hair meshes are not
   * yet fitted to the new skins); a selected or isolated one is still shown.
   */
  unfitted?: ReadonlySet<string> | null
}

/**
 * 皮肤此刻是否画成不透明：打开了"不透明皮肤"、打开了体表图（且没有调成透视），或者皮肤本身被选中。
 * Whether the skin is drawn opaque right now: the opaque-skin switch, a skin map (not see-through),
 * or the skin itself being selected.
 */
export function skinDrawnOpaque(s: { skinOpaque: boolean; skinMapMode: string; skinSeeThrough: boolean; selection: { set: ReadonlySet<string> } }, mainSkin: string | null): boolean {
  return s.skinOpaque || (s.skinMapMode !== 'off' && !s.skinSeeThrough) || (mainSkin !== null && s.selection.set.has(mainSkin))
}

/** 选中的部件加上与它们相邻的所有部件。 */
/** Selection plus every part adjacent to a selected part. */
export function adjacentFocus(graph: AnatomyGraph, selected: ReadonlySet<string>): Set<string> {
  const out = new Set<string>(selected)
  for (const id of selected) {
    const p = graph.part(id)
    if (p) for (const a of p.adjacent) out.add(a)
  }
  return out
}

/**
 * 每个部件的显示状态（下标同 graph.parts）：选中的部件总是显示；隔离会取代系统 / 剥层 / 隐藏 / 来源这几种过滤；相邻模式下焦点集合总是显示，其余本来可见的画成淡影。
 * Display state per part (indexed like graph.parts).
 *  - a selected part is always shown, whatever the filters say;
 *  - isolation replaces the system / peel / hidden / provenance filters;
 *  - in adjacent mode the focus set is always shown and everything else that would be
 *    visible is ghosted.
 */
export function computeDisplay(graph: AnatomyGraph, s: DisplayInput, out?: Uint8Array): Uint8Array {
  const parts = graph.parts
  const res = out && out.length === parts.length ? out : new Uint8Array(parts.length)
  const focus = s.adjacentMode && s.selected.size > 0 ? adjacentFocus(graph, s.selected) : null
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (s.selected.has(p.id) || focus?.has(p.id)) {
      res[i] = NORMAL
      continue
    }
    const visible = s.isolated
      ? s.isolated.has(p.id)
      : (s.systems[p.system]?.visible ?? true) &&
        p.depth >= s.peel &&
        !s.hidden.has(p.id) &&
        !(s.unfitted?.has(p.id) ?? false) &&
        !(s.provenanceHidden?.has(p.provenance) ?? false)
    res[i] = !visible ? HIDDEN : focus ? GHOST : NORMAL
  }
  return res
}

/** 爆炸量为 1 时，乘在（质心 − 中心）上的倍数。 */
/** Multiplier applied to (centroid − centre) at explode amount 1. */
export const EXPLODE_GAIN = 1.6

/**
 * 爆炸位移（每个部件 xyz，米）：部件按质心离中心的距离成比例地向外移。给了 only 时只移动这些部件，并以它们自己的中心为准。
 * Explode offsets (xyz per part, metres). Parts move away from the centre in proportion to
 * their centroid's offset from it. With `only`, just those parts move, about their own centre.
 */
export function computeExplode(
  graph: AnatomyGraph,
  amount: number,
  only: ReadonlySet<string> | null,
  out?: Float32Array,
): Float32Array {
  const parts = graph.parts
  const res = out && out.length === parts.length * 3 ? out : new Float32Array(parts.length * 3)
  res.fill(0)
  if (amount <= 0) return res
  const scoped = only && only.size >= 2 ? only : null
  const b = scoped ? graph.bounds(scoped) : graph.bodyBounds
  if (!b) return res
  const c = boundsCenter(b)
  const k = amount * EXPLODE_GAIN
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (scoped && !scoped.has(p.id)) continue
    res[i * 3] = (p.centroid[0] - c[0]) * k
    res[i * 3 + 1] = (p.centroid[1] - c[1]) * k
    res[i * 3 + 2] = (p.centroid[2] - c[2]) * k
  }
  return res
}

export type SectionAxis = 'axial' | 'coronal' | 'sagittal'

export interface SectionState {
  enabled: boolean
  axis: SectionAxis
  /** 在该轴上身体范围内的位置，0..1。 */
  /** 0..1 across the body's extent on the axis. */
  position: number
  flip: boolean
}

export interface PlaneEq {
  /** 保留满足 normal·p + constant >= 0 的点。 */
  /** Points with normal·p + constant >= 0 are kept. */
  normal: Vec3
  constant: number
}

const AXIS_INDEX: Record<SectionAxis, 0 | 1 | 2> = { sagittal: 0, axial: 1, coronal: 2 }

/**
 * 给定状态下的剖切面。不翻转时保留的是平面下方（横断）、后方（冠状）或身体右侧（矢状）的那一半，也就是从上方 / 前方 / 身体左侧看到切面。
 * Section plane for the given state. Unflipped, the kept half is the one below (axial),
 * behind (coronal) or on the body's right of (sagittal) the plane — i.e. the cut face is
 * what you see from above / the front / the body's left.
 */
export function sectionPlane(bounds: Bounds, s: SectionState): PlaneEq {
  const a = AXIS_INDEX[s.axis]
  const lo = bounds[a]!
  const hi = bounds[a + 3]!
  const pos = lo + (hi - lo) * Math.min(1, Math.max(0, s.position))
  const sign = s.flip ? 1 : -1
  const normal: Vec3 = [0, 0, 0]
  normal[a] = sign
  return { normal, constant: -sign * pos }
}

/**
 * 射线（起点 o，单位方向 d）落在保留半空间内的一段 [near, far]；从不进入时为 null。
 * Portion [near, far] of a ray (origin o, unit direction d) inside the kept half-space,
 * or null when the ray never enters it.
 */
export function clipRay(o: Vec3, d: Vec3, plane: PlaneEq): [number, number] | null {
  const n = plane.normal
  const a = n[0] * d[0] + n[1] * d[1] + n[2] * d[2]
  const b = n[0] * o[0] + n[1] * o[1] + n[2] * o[2] + plane.constant
  if (Math.abs(a) < 1e-9) return b >= 0 ? [0, Infinity] : null
  const t = -b / a
  if (a > 0) return [Math.max(0, t), Infinity]
  return t < 0 ? null : [0, t]
}

/**
 * 把一个封闭网格当成管子时的半径：2·V/A 对长圆柱是精确的，对分叉的神经和小血管也是不错的粗细度量。
 * Radius of the tube a closed mesh would be if it were one: 2·V/A is exact for a long
 * cylinder and a good thinness measure for branching nerves and small vessels.
 */
export function tubeRadius(volume: number, area: number): number {
  return area > 0 ? (2 * Math.abs(volume)) / area : 0
}

/** 等效管半径小于这个值（米）的部件，拾取时带容差。 */
/** Parts whose equivalent tube radius is below this (metres) get tolerant picking. */
export const THIN_RADIUS = 0.0015
