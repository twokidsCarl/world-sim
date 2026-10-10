// Filling gaps in BodyParts3D 4.0 from release 3.0.
//
// 4.0 is not 3.0 plus detail: the body was re-posed and re-proportioned (feet ~66 mm, thorax
// ~20 mm, head ~8 mm apart in Y) and many organs were moved or re-modelled individually. So 3.0
// parts cannot be dropped into 4.0 space. What this module does:
//
//   1. pair every 3.0 structure with its 4.0 counterpart (same concept id; or, when 4.0 only has
//      the concept as an aggregate, the union of the 4.0 elements under it)
//   2. rigid ICP per pair; pairs that fit well become anchors (their 3.0 surface points, mapped
//      through their own rigid fit, say where 3.0 space went)
//   3. one smooth deformation 3.0 → 4.0 from all anchor points (register.buildDeformation)
//   4. every 3.0 structure WITHOUT a same-concept 4.0 element is a candidate: warp it, then decide
//      whether it adds anything (redundancy against 4.0 surfaces of the same system) and whether
//      it landed plausibly (interpenetration with 4.0 solids)
//
// Everything is measured and returned in the report; nothing is assumed to fit.

import type { SystemId, TissueId } from '../../src/anatomy/types.ts'
import { measure, type Mesh, type MeshStats } from './geometry.ts'
import { applyRigid, buildDeformation, icp, InsideTester, PointIndex, rotationAngle, surfaceDistance, surfacePoints, thinPoints, type Deformation, type DistanceStats, type Rigid } from './register.ts'
import { fmaOf, walkAncestors, type Release3, type Release3Part } from './release3.ts'
import type { Ontology } from './tables.ts'

/** A part already in the dataset (4.0). */
export interface ExistingPart {
  id: string
  fma: string
  name: string
  mesh: Mesh
  stats: MeshStats
  system: SystemId
  tissue: TissueId
}

export interface Import3Options {
  /** Anchor acceptance: worst of the two one-sided 95th-percentile distances after the rigid fit. */
  anchorMaxP95: number
  /** Anchor confidence = 1 / (1 + (p95 / anchorSoftP95)²). */
  anchorSoftP95: number
  /** Anchor point density: one per voxel of this size. */
  anchorSpacing: number
  /** Kernel bandwidth floor of the deformation. */
  minSigma: number
  k: number
  /** A sample counts as "on" a 4.0 surface within this distance. */
  nearDistance: number
  /** Candidates whose surface is at least this much on same-system 4.0 surfaces are redundant. */
  redundantFraction: number
  /** Candidates with more than this fraction of their surface deeper than `deepDistance` inside 4.0 solids are rejected. */
  maxDeepInside: number
  deepDistance: number
  /** Candidates with more than this fraction of their surface inside 4.0 solids at any depth (after the clean-up) are rejected. */
  maxInside: number
}

export const IMPORT3_DEFAULTS: Import3Options = {
  anchorMaxP95: 0.005,
  anchorSoftP95: 0.002,
  anchorSpacing: 0.006,
  minSigma: 0.008,
  k: 32,
  nearDistance: 0.002,
  redundantFraction: 0.7,
  maxDeepInside: 0.2,
  deepDistance: 0.004,
  maxInside: 0.5,
}

export interface PairFit {
  id: string
  name: string
  kind: 'direct' | 'aggregate'
  elements: string[]
  transform: Rigid
  /** 3.0 → 4.0 one-sided distances after the rigid fit */
  forward: DistanceStats
  /** 4.0 → 3.0 */
  backward: DistanceStats
  /** before any alignment */
  centroidOffset: [number, number, number]
  rawForward: DistanceStats
  accepted: boolean
  centroid: [number, number, number]
}

export interface CandidateReport {
  id: string
  name: string
  triangles: number
  /** mean displacement applied by the deformation, m */
  displacement: number
  /** collision clean-up: share of vertices that were inside bone/tooth/cartilage, share moved out, mean distance (m) */
  pushedOut: { inside: number; moved: number; meanPush: number; maxPush: number }
  /** fraction of surface samples within nearDistance of a 4.0 surface of the same system */
  onSameSystem: number
  /** fraction within nearDistance of any 4.0 surface */
  onAny: number
  /** fraction inside any 4.0 solid, at any depth */
  inside: number
  /** fraction inside any 4.0 solid and further than deepDistance from every 4.0 surface */
  deepInside: number
  /** inside fraction split by the tissue of the 4.0 solid */
  insideByTissue: Record<string, number>
  /** 4.0 solids this part reaches into most: [name, inside fraction, deep fraction] */
  insideTop: [string, number, number][]
  /** 4.0 parts that hold most of the on/inside samples: [name, fraction of this candidate's samples] */
  top: [string, number][]
  decision: 'import' | 'redundant' | 'misplaced' | 'excluded'
  reason: string
}

export interface Candidate {
  part: Release3Part
  /** warped mesh in 4.0 space */
  mesh: Mesh
  stats: MeshStats
  report: CandidateReport
}

export interface Registration {
  fits: PairFit[]
  deformation: Deformation
  anchorStructures: number
  anchorPoints: number
  /** residual of the deformation at its own anchors, per structure mean, m */
  fitResidual: { median: number; p90: number; max: number }
}

const concat = (arrays: Float32Array[]): Float32Array => {
  const out = new Float32Array(arrays.reduce((s, a) => s + a.length, 0))
  let o = 0
  for (const a of arrays) {
    out.set(a, o)
    o += a.length
  }
  return out
}
const quantile = (values: number[], p: number): number => {
  const s = [...values].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]! : 0
}

/** Step 1: which 4.0 elements stand for each 3.0 structure. */
export function pairStructures(r3: Release3, existing: ExistingPart[], conceptElements: (conceptId: string) => string[]): Map<string, { kind: 'direct' | 'aggregate'; elements: string[] }> {
  const byFma = new Map<string, string[]>()
  for (const e of existing) {
    let list = byFma.get(e.fma)
    if (!list) byFma.set(e.fma, (list = []))
    list.push(e.id)
  }
  const out = new Map<string, { kind: 'direct' | 'aggregate'; elements: string[] }>()
  for (const id of r3.parts.keys()) {
    // "…nsn" remainders and BP ids never pair: they are not the concept itself
    if (fmaOf(id) !== id) continue
    const direct = byFma.get(id)
    if (direct) {
      out.set(id, { kind: 'direct', elements: direct })
      continue
    }
    const agg = conceptElements(id)
    if (agg.length) out.set(id, { kind: 'aggregate', elements: agg })
  }
  return out
}

/** Steps 2–3: rigid fit per pair, then one deformation from the accepted pairs. */
export function register3to4(r3: Release3, existing: ExistingPart[], pairs: Map<string, { kind: 'direct' | 'aggregate'; elements: string[] }>, opts: Import3Options): Registration {
  const byId = new Map(existing.map((e) => [e.id, e]))
  const fits: PairFit[] = []
  const from: Float32Array[] = []
  const to: Float32Array[] = []
  const conf: number[] = []
  const perStructure: { from: Float32Array; to: Float32Array }[] = []
  for (const [id, pair] of pairs) {
    const part = r3.parts.get(id)!
    const targets = pair.elements.map((e) => byId.get(e)!).filter(Boolean)
    const area4 = targets.reduce((s, t) => s + t.stats.area, 0)
    if (!targets.length || area4 <= 0 || part.stats.area <= 0) continue
    // ~8,000 target points and ~500 source points whatever the size of the structure
    const spT = Math.max(0.0008, Math.sqrt(area4 / 8000))
    const spS = Math.max(0.001, Math.sqrt(part.stats.area / 500))
    const raw = surfacePoints(part.mesh, spT)
    const target = thinPoints(concat(targets.map((t) => surfacePoints(t.mesh, spT))), spT * 0.8)
    const index = new PointIndex(target, spT * 1.5)
    const dense = thinPoints(raw, spT * 0.8)
    // unaligned distance: against a coarse copy of the target so far-away queries stay cheap
    const coarse = Math.max(0.003, spT * 2)
    const rawForward = surfaceDistance(thinPoints(raw, spS), new PointIndex(thinPoints(target, coarse), coarse * 4))
    const res = icp(thinPoints(raw, spS), index, { maxIterations: 30 })
    const moved = applyRigid(res.transform, dense)
    const forward = surfaceDistance(moved, index)
    const backward = surfaceDistance(target, new PointIndex(moved, spT * 1.5))
    // an aggregate's 4.0 side may hold interior content (vessels inside a lobe), so only the
    // 3.0 → 4.0 direction is meaningful there
    const p95 = pair.kind === 'direct' ? Math.max(forward.p95, backward.p95) : forward.p95
    const accepted = p95 <= opts.anchorMaxP95 && rotationAngle(res.transform) < 0.6
    let cx = 0
    let cy = 0
    let cz = 0
    for (const t of targets) {
      cx += t.stats.centroid[0] * t.stats.area
      cy += t.stats.centroid[1] * t.stats.area
      cz += t.stats.centroid[2] * t.stats.area
    }
    fits.push({
      id, name: part.name, kind: pair.kind, elements: pair.elements, transform: res.transform, forward, backward, rawForward, accepted,
      centroid: part.stats.centroid,
      centroidOffset: [cx / area4 - part.stats.centroid[0], cy / area4 - part.stats.centroid[1], cz / area4 - part.stats.centroid[2]],
    })
    if (!accepted) continue
    const a = thinPoints(surfacePoints(part.mesh, opts.anchorSpacing), opts.anchorSpacing)
    const b = applyRigid(res.transform, a)
    from.push(a)
    to.push(b)
    perStructure.push({ from: a, to: b })
    const c = 1 / (1 + (p95 / opts.anchorSoftP95) ** 2)
    for (let i = 0; i < a.length / 3; i++) conf.push(c)
  }
  const allFrom = concat(from)
  const deformation = buildDeformation(allFrom, concat(to), { minSigma: opts.minSigma, k: opts.k, weights: Float32Array.from(conf) })
  const residuals = perStructure.map((s) => {
    const out = deformation.apply(s.from)
    let sum = 0
    for (let i = 0; i < out.length; i += 3) sum += Math.hypot(out[i]! - s.to[i]!, out[i + 1]! - s.to[i + 1]!, out[i + 2]! - s.to[i + 2]!)
    return sum / (out.length / 3)
  })
  return {
    fits, deformation, anchorStructures: perStructure.length, anchorPoints: allFrom.length / 3,
    fitResidual: { median: quantile(residuals, 0.5), p90: quantile(residuals, 0.9), max: quantile(residuals, 1) },
  }
}

/**
 * Honest accuracy estimate: 10-fold leave-structures-out. Each fold rebuilds the deformation
 * without a tenth of the anchor structures and measures how far it puts them from where their own
 * rigid fit says they belong. Returns per-structure mean errors (m).
 */
export function crossValidate(r3: Release3, reg: Registration, opts: Import3Options, folds = 10): { id: string; name: string; centroid: [number, number, number]; error: number }[] {
  const accepted = reg.fits.filter((f) => f.accepted)
  const pts = accepted.map((f) => {
    const a = thinPoints(surfacePoints(r3.parts.get(f.id)!.mesh, opts.anchorSpacing), opts.anchorSpacing)
    const p95 = f.kind === 'direct' ? Math.max(f.forward.p95, f.backward.p95) : f.forward.p95
    return { from: a, to: applyRigid(f.transform, a), conf: 1 / (1 + (p95 / opts.anchorSoftP95) ** 2) }
  })
  const out: { id: string; name: string; centroid: [number, number, number]; error: number }[] = []
  for (let fold = 0; fold < folds; fold++) {
    const train = pts.filter((_, i) => i % folds !== fold)
    const weights: number[] = []
    for (const t of train) for (let i = 0; i < t.from.length / 3; i++) weights.push(t.conf)
    const def = buildDeformation(concat(train.map((t) => t.from)), concat(train.map((t) => t.to)), { minSigma: opts.minSigma, k: opts.k, weights: Float32Array.from(weights) })
    pts.forEach((s, i) => {
      if (i % folds !== fold) return
      const moved = def.apply(s.from)
      let sum = 0
      for (let j = 0; j < moved.length; j += 3) sum += Math.hypot(moved[j]! - s.to[j]!, moved[j + 1]! - s.to[j + 1]!, moved[j + 2]! - s.to[j + 2]!)
      out.push({ id: accepted[i]!.id, name: accepted[i]!.name, centroid: accepted[i]!.centroid, error: sum / (moved.length / 3) })
    })
  }
  return out
}

/** Spatial index over the surfaces of all existing parts, remembering which part each sample is on. */
export class SurfaceField {
  readonly index: PointIndex
  private readonly owner: Uint16Array
  private readonly testers = new Map<number, InsideTester>()
  constructor(readonly parts: ExistingPart[], spacing = 0.0025) {
    const chunks = parts.map((p) => thinPoints(surfacePoints(p.mesh, spacing), spacing * 0.6))
    const pts = concat(chunks)
    this.owner = new Uint16Array(pts.length / 3)
    let o = 0
    chunks.forEach((c, i) => {
      this.owner.fill(i, o, o + c.length / 3)
      o += c.length / 3
    })
    this.index = new PointIndex(pts, 0.004)
  }
  private readonly i1 = new Int32Array(1)
  private readonly d1 = new Float64Array(1)
  /** Nearest existing surface: [part index, distance]; part −1 when none within maxDistance. */
  nearest(x: number, y: number, z: number, maxDistance: number): [number, number] {
    const n = this.index.nearest(x, y, z, 1, this.i1, this.d1, maxDistance)
    return n ? [this.owner[this.i1[0]!]!, Math.sqrt(this.d1[0]!)] : [-1, Infinity]
  }
  private readonly surfaces = new Map<number, PointIndex>()
  /** Dense surface samples of one part, for nearest-surface queries against that part alone. */
  surfaceIndex(i: number): PointIndex {
    let s = this.surfaces.get(i)
    if (!s) this.surfaces.set(i, (s = new PointIndex(thinPoints(surfacePoints(this.parts[i]!.mesh, 0.001), 0.0008), 0.003)))
    return s
  }
  tester(i: number): InsideTester {
    let t = this.testers.get(i)
    if (!t) this.testers.set(i, (t = new InsideTester(this.parts[i]!.mesh)))
    return t
  }
}

export interface Overlap {
  /** fraction of the samples within nearDistance of each part's surface, by part index */
  on: Map<number, number>
  /** fraction of the samples inside each solid part (any depth), by part index */
  inside: Map<number, number>
  /** fraction of the samples inside each part and further than deepDistance from any surface */
  deep: Map<number, number>
  onAny: number
  insideAny: number
  deepAny: number
}

/** How a point set (surface samples of one mesh) sits relative to the existing parts. */
export function overlapWith(points: Float32Array, bbox: readonly number[], field: SurfaceField, nearDistance: number, deepDistance: number, solid: (partIndex: number) => boolean): Overlap {
  const n = points.length / 3
  const on = new Map<number, number>()
  const deep = new Map<number, number>()
  const inside = new Map<number, number>()
  let onAny = 0
  let deepAny = 0
  let insideAny = 0
  // solids whose bounds meet ours
  const candidates: number[] = []
  field.parts.forEach((p, i) => {
    if (!solid(i)) return
    const b = p.stats.bbox
    if (b[0] > bbox[3]! || b[3] < bbox[0]! || b[1] > bbox[4]! || b[4] < bbox[1]! || b[2] > bbox[5]! || b[5] < bbox[2]!) return
    candidates.push(i)
  })
  for (let i = 0; i < n; i++) {
    const x = points[3 * i]!
    const y = points[3 * i + 1]!
    const z = points[3 * i + 2]!
    const [owner, d] = field.nearest(x, y, z, Math.max(nearDistance, deepDistance))
    if (owner >= 0 && d <= nearDistance) {
      on.set(owner, (on.get(owner) ?? 0) + 1)
      onAny++
    }
    for (const c of candidates) {
      const b = field.parts[c]!.stats.bbox
      if (x < b[0] || x > b[3] || y < b[1] || y > b[4] || z < b[2] || z > b[5]) continue
      if (field.tester(c).contains(x, y, z)) {
        inside.set(c, (inside.get(c) ?? 0) + 1)
        insideAny++
        if (d >= deepDistance) {
          deep.set(c, (deep.get(c) ?? 0) + 1)
          deepAny++
        }
        break
      }
    }
  }
  for (const m of [on, deep, inside]) for (const [k, v] of m) m.set(k, v / n)
  return { on, deep, inside, onAny: n ? onAny / n : 0, deepAny: n ? deepAny / n : 0, insideAny: n ? insideAny / n : 0 }
}

/** Tissues a soft part cannot share space with at all; warped parts are pushed out of these. */
export const HARD_TISSUES: TissueId[] = ['bone', 'tooth', 'cartilage']

export interface PushOutResult {
  positions: Float32Array
  /** vertices that were inside a hard solid */
  inside: number
  /** of those, moved to the surface */
  moved: number
  /** mean distance moved, m */
  meanPush: number
  maxPush: number
}

/**
 * Collision clean-up after warping: vertices that ended up inside a hard solid (bone, tooth,
 * cartilage) are slid out along the locally dominant "way out" — the average, over the inside
 * vertices within `radius`, of the vector to the nearest surface — until they clear it by
 * `clearance`. Using the neighbourhood's direction rather than each vertex's own nearest surface
 * keeps a thin muscle on one side of a thin bone. Vertices that would need more than `maxPush`
 * are left where they are (they show up in the interpenetration report instead).
 */
export function pushOutOfSolids(
  positions: Float32Array,
  bbox: readonly number[],
  field: SurfaceField,
  isHard: (partIndex: number) => boolean,
  opts: { clearance: number; maxPush: number; radius: number; step: number } = { clearance: 0.0004, maxPush: 0.006, radius: 0.012, step: 0.0002 },
): PushOutResult {
  const n = positions.length / 3
  const solids: number[] = []
  field.parts.forEach((p, i) => {
    if (!isHard(i)) return
    const b = p.stats.bbox
    if (b[0] > bbox[3]! || b[3] < bbox[0]! || b[1] > bbox[4]! || b[4] < bbox[1]! || b[2] > bbox[5]! || b[5] < bbox[2]!) return
    solids.push(i)
  })
  const out = Float32Array.from(positions)
  if (!solids.length) return { positions: out, inside: 0, moved: 0, meanPush: 0, maxPush: 0 }
  const who: number[] = []
  const owner: number[] = []
  const grad: number[] = []
  for (let v = 0; v < n; v++) {
    const x = positions[3 * v]!
    const y = positions[3 * v + 1]!
    const z = positions[3 * v + 2]!
    for (const c of solids) {
      const b = field.parts[c]!.stats.bbox
      if (x < b[0] || x > b[3] || y < b[1] || y > b[4] || z < b[2] || z > b[5]) continue
      if (!field.tester(c).contains(x, y, z)) continue
      const s = field.surfaceIndex(c)
      const found = s.nearest(x, y, z, 1, I1, D1)
      who.push(v)
      owner.push(c)
      if (found) grad.push(s.points[3 * I1[0]!]! - x, s.points[3 * I1[0]! + 1]! - y, s.points[3 * I1[0]! + 2]! - z)
      else grad.push(0, 0, 0)
      break
    }
  }
  if (!who.length) return { positions: out, inside: 0, moved: 0, meanPush: 0, maxPush: 0 }
  const pts = new Float32Array(who.length * 3)
  who.forEach((v, j) => pts.set(positions.subarray(3 * v, 3 * v + 3), 3 * j))
  const index = new PointIndex(pts, opts.radius)
  const K = Math.min(24, who.length)
  const idx = new Int32Array(K)
  const d2 = new Float64Array(K)
  let moved = 0
  let sum = 0
  let max = 0
  for (let j = 0; j < who.length; j++) {
    const v = who[j]!
    const x = pts[3 * j]!
    const y = pts[3 * j + 1]!
    const z = pts[3 * j + 2]!
    const found = index.nearest(x, y, z, K, idx, d2, opts.radius)
    let dx = 0
    let dy = 0
    let dz = 0
    for (let k = 0; k < found; k++) {
      const q = idx[k]!
      if (owner[q] !== owner[j]) continue
      dx += grad[3 * q]!
      dy += grad[3 * q + 1]!
      dz += grad[3 * q + 2]!
    }
    let len = Math.hypot(dx, dy, dz)
    if (len < 1e-9) {
      dx = grad[3 * j]!
      dy = grad[3 * j + 1]!
      dz = grad[3 * j + 2]!
      len = Math.hypot(dx, dy, dz)
      if (len < 1e-9) continue
    }
    dx /= len
    dy /= len
    dz /= len
    const tester = field.tester(owner[j]!)
    let t = 0
    let exited = false
    while (t < opts.maxPush) {
      t += opts.step
      if (!tester.contains(x + dx * t, y + dy * t, z + dz * t)) {
        exited = true
        break
      }
    }
    if (!exited) continue
    t += opts.clearance
    out[3 * v] = x + dx * t
    out[3 * v + 1] = y + dy * t
    out[3 * v + 2] = z + dz * t
    moved++
    sum += t
    if (t > max) max = t
  }
  return { positions: out, inside: who.length, moved, meanPush: moved ? sum / moved : 0, maxPush: max }
}
const I1 = new Int32Array(1)
const D1 = new Float64Array(1)

/** Tissues that are solid bodies another structure should not sit inside. */
export const SOLID_TISSUES: TissueId[] = ['bone', 'tooth', 'cartilage', 'muscle', 'organ', 'brain', 'heart', 'gland']

/**
 * Step 4: warp every 3.0 structure that has no same-concept 4.0 element and judge it.
 * `systemOf` classifies a candidate (the caller owns classification); `exclude` lets the caller
 * veto candidates by id with a reason.
 */
export function evaluateCandidates(
  r3: Release3,
  pairs: Map<string, { kind: 'direct' | 'aggregate'; elements: string[] }>,
  reg: Registration,
  field: SurfaceField,
  systemOf: (part: Release3Part) => SystemId,
  exclude: (part: Release3Part) => string | null,
  opts: Import3Options,
): Candidate[] {
  const out: Candidate[] = []
  const isSolid = (i: number) => SOLID_TISSUES.includes(field.parts[i]!.tissue)
  for (const part of r3.parts.values()) {
    if (pairs.get(part.id)?.kind === 'direct') continue
    const positions = reg.deformation.apply(part.mesh.positions)
    let disp = 0
    for (let i = 0; i < positions.length; i += 3) disp += Math.hypot(positions[i]! - part.mesh.positions[i]!, positions[i + 1]! - part.mesh.positions[i + 1]!, positions[i + 2]! - part.mesh.positions[i + 2]!)
    disp /= Math.max(1, positions.length / 3)
    // collision clean-up against hard tissue (only for parts that will be considered at all)
    const pre = measure({ positions, indices: part.mesh.indices })
    const push: PushOutResult | null = pushOutOfSolids(positions, pre.bbox, field, (i) => HARD_TISSUES.includes(field.parts[i]!.tissue))
    const mesh: Mesh = { positions: push ? push.positions : positions, indices: part.mesh.indices }
    const stats = measure(mesh)
    const samples = thinPoints(surfacePoints(mesh, 0.003), 0.002)
    const ov = overlapWith(samples, stats.bbox, field, opts.nearDistance, opts.deepDistance, isSolid)
    const system = systemOf(part)
    let onSame = 0
    for (const [i, f] of ov.on) if (field.parts[i]!.system === system) onSame += f
    const tally = new Map<number, number>()
    for (const m of [ov.on, ov.deep]) for (const [i, f] of m) tally.set(i, (tally.get(i) ?? 0) + f)
    const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([i, f]) => [field.parts[i]!.name, Number(f.toFixed(3))] as [string, number])
    const insideByTissue: Record<string, number> = {}
    for (const [i, f] of ov.inside) insideByTissue[field.parts[i]!.tissue] = Number(((insideByTissue[field.parts[i]!.tissue] ?? 0) + f).toFixed(4))
    const insideTop = [...ov.inside].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([i, f]) => [field.parts[i]!.name, Number(f.toFixed(3)), Number((ov.deep.get(i) ?? 0).toFixed(3))] as [string, number, number])
    const veto = exclude(part)
    let decision: CandidateReport['decision'] = 'import'
    let reason = ''
    if (veto) {
      decision = 'excluded'
      reason = veto
    } else if (onSame >= opts.redundantFraction) {
      decision = 'redundant'
      reason = `${(onSame * 100).toFixed(0)}% of its surface lies on existing ${system} parts`
    } else if (ov.deepAny > opts.maxDeepInside) {
      decision = 'misplaced'
      reason = `${(ov.deepAny * 100).toFixed(0)}% of its surface is more than ${opts.deepDistance * 1000} mm inside existing solids`
    } else if (ov.insideAny > opts.maxInside) {
      decision = 'misplaced'
      reason = `${(ov.insideAny * 100).toFixed(0)}% of its surface is inside existing solids (${insideTop.slice(0, 3).map(([nm, f]) => `${nm} ${(f * 100).toFixed(0)}%`).join(', ')})`
    }
    out.push({
      part, mesh, stats,
      report: { id: part.id, name: part.name, triangles: mesh.indices.length / 3, displacement: disp, pushedOut: { inside: (push?.inside ?? 0) / Math.max(1, positions.length / 3), moved: (push?.moved ?? 0) / Math.max(1, positions.length / 3), meanPush: push?.meanPush ?? 0, maxPush: push?.maxPush ?? 0 }, onSameSystem: onSame, onAny: ov.onAny, inside: ov.insideAny, deepInside: ov.deepAny, insideByTissue, insideTop, top, decision, reason },
    })
  }
  return out
}

/** Chains for classification and tree placement of a 3.0 concept. */
export interface Placement {
  /** FMA id the part is filed under (own id without "nsn"; nearest FMA ancestor for BP ids) */
  fma: string
  /** concept names, most specific first, usable as IS-A signal (from the 4.0 isa tree) */
  isa: string[]
  /** concept names usable as PART-OF signal (4.0 partOf chain plus every 3.0 ancestor) */
  partOf: string[]
  /** 4.0 concept the part hangs under in each tree (the concept itself when 4.0 has it) */
  isaConcept: string | null
  partOfConcept: string | null
  /** true when the tree position had to come from a 3.0 ancestor rather than the concept itself */
  isaViaAncestor: boolean
  /** true when the IS-A position came from ISA_PLACEMENT_RULES */
  isaByHand: boolean
  partOfViaAncestor: boolean
}

const chainNames = (onto: Ontology, concept: string): string[] => {
  const out: string[] = []
  for (let c: string | null | undefined = concept; c; c = onto.parent.get(c)) out.push(onto.name.get(c) ?? c)
  return out
}

/**
 * Hand-made IS-A positions for 3.0 concepts the 4.0 IS-A tree does not know. The 3.0
 * "conventional" tree mixes is-a, part-of and regional links, so walking it into the 4.0 IS-A
 * tree lands on things like "subdivision of face"; these rules name the 4.0 IS-A concept (by its
 * name) a structure belongs under instead. First match wins.
 */
export const ISA_PLACEMENT_RULES: [RegExp, string][] = [
  [/^aponeurosis of epicranius$/, 'tendon'],
  [/inguinal ligament/, 'skeletal ligament'],
  [/masseter|temporalis|pterygoid/, 'muscle of head'],
  [/buccinator|corrugator supercilii|depressor (anguli oris|labii inferioris|septi nasi)|frontalis|levator (anguli oris|labii superioris)|mentalis|nasalis|occipitalis|procerus|risorius|temporoparietalis|zygomaticus|orbicularis (oris|oculi)/, 'muscle of face'],
  [/rectus abdominis|pyramidalis|internal oblique|transversus abdominis/, 'muscle of anterior abdominal wall'],
  [/quadratus lumborum/, 'muscle of abdomen'],
  [/multifidus/, 'deep postvertebral muscle'],
  [/spinalis cervicis/, 'spinalis'],
  [/longus colli/, 'prevertebral muscle'],
  [/latissimus dorsi/, 'extrinsic muscle of shoulder'],
  [/extensor digitorum brevis|dorsal interossei of (left|right) foot/, 'intrinsic muscle of foot'],
  [/lobe of (left |right )?lung/, 'anatomical lobe'],
]

export function placeConcept(r3: Release3, id: string, isa: Ontology, partOf: Ontology): Placement {
  const own = fmaOf(id)
  const ancestors: { id: string; distance: number }[] = []
  walkAncestors(r3.parents, id, (a, d) => {
    ancestors.push({ id: a, distance: d })
  })
  const fma = own ?? ancestors.find((a) => fmaOf(a.id) === a.id)?.id ?? id
  const find = (onto: Ontology): { concept: string | null; via: boolean } => {
    if (own && onto.name.has(own)) return { concept: own, via: false }
    // nearest 3.0 ancestor known to this tree; ties go to the most specific (fewest elements)
    let best: { id: string; distance: number } | null = null
    for (const a of ancestors) {
      if (!onto.name.has(a.id)) continue
      if (best && a.distance > best.distance) break
      const size = (c: string) => onto.elements.get(c)?.size ?? 0
      if (!best || size(a.id) < size(best.id)) best = a
    }
    return { concept: best?.id ?? null, via: true }
  }
  let i = find(isa)
  let isaByHand = false
  if (i.via) {
    const name = r3.names.get(id) ?? id
    const rule = ISA_PLACEMENT_RULES.find(([re]) => re.test(name))
    if (rule) {
      let concept: string | null = null
      for (const [cid, cname] of isa.name) {
        if (cname === rule[1]) {
          concept = cid
          break
        }
      }
      if (!concept) throw new Error(`ISA_PLACEMENT_RULES: no IS-A concept named "${rule[1]}"`)
      i = { concept, via: true }
      isaByHand = true
    }
  }
  const p = find(partOf)
  const names3 = ancestors.map((a) => r3.names.get(a.id) ?? a.id)
  return {
    fma,
    isa: [r3.names.get(id) ?? id, ...(i.concept ? chainNames(isa, i.concept) : [])],
    partOf: [...(p.concept ? chainNames(partOf, p.concept) : []), ...names3],
    isaConcept: i.concept,
    partOfConcept: p.concept,
    isaViaAncestor: i.via,
    isaByHand,
    partOfViaAncestor: p.via,
  }
}

/**
 * Containment check: the fraction of the surface samples of each given existing part that lies
 * inside any of `meshes`. Used for "the 4.0 bronchi and vessels of a lung should be inside the
 * imported lobes": a direct measure of whether the registration put the organ where its
 * contents are.
 */
export function contentsInside(meshes: Mesh | Mesh[], contents: ExistingPart[], spacing = 0.003): { fraction: number; samples: number; worst: [string, number][] } {
  const testers = (Array.isArray(meshes) ? meshes : [meshes]).map((m) => new InsideTester(m, 64))
  let inside = 0
  let total = 0
  const per: [string, number][] = []
  for (const c of contents) {
    const pts = thinPoints(surfacePoints(c.mesh, spacing), spacing * 0.8)
    const n = pts.length / 3
    if (!n) continue
    let hit = 0
    for (let i = 0; i < n; i++) {
      for (const t of testers) {
        if (t.contains(pts[3 * i]!, pts[3 * i + 1]!, pts[3 * i + 2]!)) {
          hit++
          break
        }
      }
    }
    inside += hit
    total += n
    per.push([c.name, hit / n])
  }
  per.sort((a, b) => a[1] - b[1])
  return { fraction: total ? inside / total : 0, samples: total, worst: per.slice(0, 5) }
}
