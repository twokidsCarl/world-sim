// Female body: the male model registered onto real female anchors.
//   bun tools/pipeline/female.ts [--out <dir>]
// Reads the built male body (public/anatomy/male — run the male pipeline first) and the female
// anchor package (data/raw/female/out/anchors), writes public/anatomy/female.
//
// What is real and what is not (also written to pipeline-report.json `notes`):
//   scanned  her own bones (Visible Human Female CT), moved rigidly, bone by bone, from the
//            supine scan pose into the male's standing pose; a few good-quality organs and trunk
//            muscles from the same CT
//   curated  uterus, ovaries, tubes, vagina, pelvic ligaments, uterine vessels, breasts (HRA)
//   warped   everything else: male geometry carried through a smooth deformation that maps the
//            male skeleton onto hers
//
// Steps
//   1. pose      per-bone rigid transforms scan → standing (arms: from the anchor package; legs
//                and feet: each bone turned about its proximal joint centre to the male bone's
//                orientation; right forearm and hand: mirrored left ones, the right ones are
//                clipped by the CT field of view)
//   2. field P   the same motion as a smooth field, for her soft tissue that spans joints
//   3. field D   male → female, from similarity fits of every male bone onto her posed bone
//   4. parts     her real parts where one exists one-to-one in good quality, warped male parts
//                otherwise, male-only parts dropped, HRA female organs added
//   5. clean-up  collisions with her bones, nerve tubes rebuilt from warped centrelines
//   6. checks, adjacency, trees, output

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AnatomyData, Concept, NervePath, Part, Provenance, SourceInfo, SystemDef, SystemId, TissueId } from '../../src/anatomy/types.ts'
import { computeAdjacency } from './adjacency.ts'
import { loadBuiltBody } from './body.ts'
import { hasFemaleAnchors, loadFemaleAnchors, type FemaleItem } from './femaleAnchors.ts'
import { computeNormals, measure, simplifyMesh, weld, type Mesh, type MeshStats } from './geometry.ts'
import { writeSystemGlb, type GlbPart } from './glb.ts'
import { HARD_TISSUES, overlapWith, pushOutOfSolids, SOLID_TISSUES, SurfaceField, type ExistingPart } from './import3.ts'
import { canalFor, isaPathFromFma, NERVE_BUILD_DEFAULTS, warpNerveLines } from './importZa.ts'
import { runLandmarkChecks, slabCentroid } from './landmarks.ts'
import { depthOf, LAYERS } from './layers.ts'
import { applyRigid, buildDeformation, buildTwoLevelDeformation, fitRigid, icp, InsideTester, PointIndex, surfaceDistance, surfacePoints, thinPoints, type Deformation, type Rigid } from './register.ts'
import type { Polyline } from './tube.ts'
import { loadFmaNames } from './zanatomy.ts'

const ROOT = join(import.meta.dirname, '../..')
const MALE_DIR = join(ROOT, 'public/anatomy/male')

// ── Parameters ────────────────────────────────────────────────────────────────────────────────
const FIELD = { minSigma: Number(process.env.SOMA_SIGMA ?? 0.012), k: Number(process.env.SOMA_K ?? 32) }
const TWO_LEVEL = { coarseSpacing: 0.025, coarseSigma: Number(process.env.SOMA_CS ?? 0.04), coarseK: 64, fineSigma: 0.012, fineK: 32, fadeDistance: Number(process.env.SOMA_FADE ?? 0.03) }
const ANCHOR_SPACING = 0.006
/** bone anchors: after the similarity fit, points are moved onto her bone surface within this distance */
const SNAP_DISTANCE = 0.012
/** a male bone whose similarity fit onto her bone is worse than this (symmetric p95) is not used as an anchor */
const MAX_FIT_P95 = 0.012
/** soft-tissue anchors (centroid + scale only) get this confidence relative to a perfect bone fit */
const SOFT_ANCHOR_CONFIDENCE = 0.2
/** her real soft parts count as rigidly moved (stay "scanned") when the posing field bends them less than this */
const RIGID_TOLERANCE = 0.002
/** her real soft part replaces the warped male one only when their centroids agree within this */
const REAL_SOFT_MAX_OFFSET = 0.03
const ADJACENCY = { threshold: 0.002, spacing: 0.002, maxDegree: 200 }
const SIMPLIFY = { perThickness: 0.08, min: 0.08e-3, max: 0.8e-3, minTriangles: 400, maxEdge: 0.012 }

/** Male parts that have no place in a female body: by system, then by name. */
const MALE_ONLY_NAME = /\bpenis\b|\btest(is|es|icular)\b|prostat|seminal|deferent|epididym|scrot|spermat|cremaster|^urethra$/i
const isMaleOnly = (p: Part) => p.system === 'reproductive' || MALE_ONLY_NAME.test(p.name)

const SOURCE_VHF: SourceInfo = {
  name: 'Visible Human Female CT',
  url: 'https://data.lhncbc.nlm.nih.gov/public/Visible-Human/Female-Images/radiological/normalCT/',
  license: 'NLM Terms and Conditions (attribution required)',
  attribution: 'Courtesy of the U.S. National Library of Medicine. Segmented with TotalSegmentator 2.18.0 and MOOSE 3.2.2; bones moved rigidly from the supine scan pose to a standing pose by this project.',
}
const SOURCE_HRA: SourceInfo = {
  name: 'Human Reference Atlas',
  url: 'https://cdn.humanatlas.io/digital-objects/ref-organ/united-female/latest/assets/3d-vh-f-united.glb',
  license: 'CC BY 4.0',
  attribution: 'Human Reference Atlas 3D Reference Object Library (HuBMAP / HRA), CC BY 4.0; modelled from the Visible Human Female, Courtesy of the U.S. National Library of Medicine. Placed in the CT frame by a bone-driven field.',
}

interface FPart {
  id: string
  fma: string
  name: string
  system: SystemId
  tissue: TissueId
  depth: number
  side: 'L' | 'R' | 'M'
  provenance: Provenance
  source: string
  mesh: Mesh
  volume?: number
  /** id of the male part this one corresponds to (replaces or is warped from) */
  male?: string
  centrelines?: Polyline[]
  /** geometry is final (already simplified male mesh, rebuilt nerve tube) */
  keepGeometry?: boolean
  note?: string
}

const round = (v: number, digits = 5) => Number(v.toFixed(digits))
const pad = (s: string | number, n: number) => String(s).padEnd(n)
const mm = (v: number) => (v * 1000).toFixed(1)
const quantile = (values: number[], p: number): number => {
  const s = [...values].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]! : 0
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
const fromMatrix = (m: number[]): Rigid => ({ r: [m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!], t: [m[3]!, m[7]!, m[11]!] })
const IDENT: Rigid = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }
const apply3 = (m: Rigid, p: readonly number[]): [number, number, number] => [
  m.r[0]! * p[0]! + m.r[1]! * p[1]! + m.r[2]! * p[2]! + m.t[0],
  m.r[3]! * p[0]! + m.r[4]! * p[1]! + m.r[5]! * p[2]! + m.t[1],
  m.r[6]! * p[0]! + m.r[7]! * p[1]! + m.r[8]! * p[2]! + m.t[2],
]
/** x ↦ R(x − pivot) + target */
const about = (r: number[], pivot: readonly number[], target: readonly number[]): Rigid => ({
  r,
  t: [
    target[0]! - (r[0]! * pivot[0]! + r[1]! * pivot[1]! + r[2]! * pivot[2]!),
    target[1]! - (r[3]! * pivot[0]! + r[4]! * pivot[1]! + r[5]! * pivot[2]!),
    target[2]! - (r[6]! * pivot[0]! + r[7]! * pivot[1]! + r[8]! * pivot[2]!),
  ],
})
const compose = (a: Rigid, b: Rigid): Rigid => {
  // a ∘ b
  const r = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[3 * i + j] = a.r[3 * i]! * b.r[j]! + a.r[3 * i + 1]! * b.r[3 + j]! + a.r[3 * i + 2]! * b.r[6 + j]!
  return { r, t: apply3(a, b.t) }
}
const transformMesh = (m: Mesh, t: Rigid): Mesh => ({ positions: applyRigid(t, m.positions), indices: m.indices })
const mirrorX = (m: Mesh): Mesh => {
  const positions = Float32Array.from(m.positions, (v, i) => (i % 3 === 0 ? -v : v))
  const indices = Uint32Array.from(m.indices)
  for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2]!, indices[t + 1]!]
  return { positions, indices }
}
const angleDeg = (r: number[]) => (Math.acos(Math.max(-1, Math.min(1, (r[0]! + r[4]! + r[8]! - 1) / 2))) * 180) / Math.PI

/** Rotation that turns `source` (female bone) to the orientation of `target` (male bone), sizes aside. */
function orientationTo(source: Mesh, target: Mesh): { r: number[]; rms: number } {
  const tgt = thinPoints(surfacePoints(target, 0.003), 0.003)
  const src = thinPoints(surfacePoints(source, 0.004), 0.006)
  const res = icp(src, new PointIndex(tgt, 0.008), { maxIterations: 60, scale: true })
  const s = Math.cbrt(Math.abs(res.transform.r[0]! * (res.transform.r[4]! * res.transform.r[8]! - res.transform.r[5]! * res.transform.r[7]!) - res.transform.r[1]! * (res.transform.r[3]! * res.transform.r[8]! - res.transform.r[5]! * res.transform.r[6]!) + res.transform.r[2]! * (res.transform.r[3]! * res.transform.r[7]! - res.transform.r[4]! * res.transform.r[6]!)))
  return { r: res.transform.r.map((v) => v / s), rms: res.rms }
}

/**
 * Centreline of a rib as a polyline from its vertebral end to its anterior end: surface points
 * are binned by their angle round a vertical axis through the middle of the rib cage (a rib
 * sweeps monotonically from the back round the side to the front), one centroid per bin.
 * Returns the centreline points and their normalised arc length.
 */
function ribCentreline(points: Float32Array, axisZ: number): { c: number[][]; s: number[]; angleOf: (x: number, z: number) => number; a0: number; a1: number } {
  const angleOf = (x: number, z: number) => Math.atan2(Math.abs(x), -(z - axisZ))
  const BINS = 24
  let a0 = Infinity
  let a1 = -Infinity
  for (let i = 0; i < points.length; i += 3) {
    const a = angleOf(points[i]!, points[i + 2]!)
    if (a < a0) a0 = a
    if (a > a1) a1 = a
  }
  const sum = Array.from({ length: BINS }, () => [0, 0, 0, 0])
  for (let i = 0; i < points.length; i += 3) {
    const b = Math.min(BINS - 1, Math.floor(((angleOf(points[i]!, points[i + 2]!) - a0) / Math.max(1e-9, a1 - a0)) * BINS))
    const acc = sum[b]!
    acc[0] = acc[0]! + points[i]!
    acc[1] = acc[1]! + points[i + 1]!
    acc[2] = acc[2]! + points[i + 2]!
    acc[3] = acc[3]! + 1
  }
  const c = sum.filter((x) => x[3]! > 0).map((x) => [x[0]! / x[3]!, x[1]! / x[3]!, x[2]! / x[3]!])
  const s = [0]
  for (let i = 1; i < c.length; i++) s.push(s[i - 1]! + Math.hypot(c[i]![0]! - c[i - 1]![0]!, c[i]![1]! - c[i - 1]![1]!, c[i]![2]! - c[i - 1]![2]!))
  const total = s[s.length - 1]! || 1
  return { c, s: s.map((v) => v / total), angleOf, a0, a1 }
}

/** Point of a centreline at normalised arc length t. */
function alongLine(line: { c: number[][]; s: number[] }, t: number): number[] {
  const { c, s } = line
  if (t <= 0) return c[0]!
  if (t >= 1) return c[c.length - 1]!
  let i = 1
  while (i < s.length - 1 && s[i]! < t) i++
  const u = (t - s[i - 1]!) / Math.max(1e-9, s[i]! - s[i - 1]!)
  return [0, 1, 2].map((k) => c[i - 1]![k]! + (c[i]![k]! - c[i - 1]![k]!) * u)
}

/** Nearest centreline position (normalised arc length) of a point. */
function paramOf(line: { c: number[][]; s: number[] }, p: readonly number[]): number {
  let best = 0
  let bd = Infinity
  for (let i = 1; i < line.c.length; i++) {
    const a = line.c[i - 1]!
    const b = line.c[i]!
    const d = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]
    const l2 = d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]! || 1e-12
    let u = ((p[0]! - a[0]!) * d[0]! + (p[1]! - a[1]!) * d[1]! + (p[2]! - a[2]!) * d[2]!) / l2
    u = u < 0 ? 0 : u > 1 ? 1 : u
    const dist = Math.hypot(p[0]! - a[0]! - u * d[0]!, p[1]! - a[1]! - u * d[1]!, p[2]! - a[2]! - u * d[2]!)
    if (dist < bd) {
      bd = dist
      best = line.s[i - 1]! + u * (line.s[i]! - line.s[i - 1]!)
    }
  }
  return best
}

const unionMesh = (meshes: Mesh[]): Mesh => {
  const positions = concat(meshes.map((m) => m.positions))
  const indices = new Uint32Array(meshes.reduce((s, m) => s + m.indices.length, 0))
  let vo = 0
  let io = 0
  for (const m of meshes) {
    for (let k = 0; k < m.indices.length; k++) indices[io + k] = m.indices[k]! + vo
    vo += m.positions.length / 3
    io += m.indices.length
  }
  return { positions, indices }
}

async function main() {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('--out')
  const outDir = outIdx >= 0 ? args[outIdx + 1]! : join(ROOT, 'public/anatomy/female')
  const t0 = performance.now()
  const lap = (label: string) => console.log(`  [${((performance.now() - t0) / 1000).toFixed(1)}s] ${label}`)
  const report: Record<string, unknown> = {}
  const notes: string[] = []
  if (!existsSync(join(MALE_DIR, 'anatomy.json'))) throw new Error('public/anatomy/male is missing: run `bun run pipeline` first')
  if (!hasFemaleAnchors()) throw new Error('data/raw/female/out/anchors is missing: run tools/register/run_anchors.sh first')

  const male = await loadBuiltBody(MALE_DIR)
  const fa = loadFemaleAnchors()
  const fmaNames = loadFmaNames()
  const maleByName = new Map<string, Part>()
  for (const p of male.data.parts) if (!maleByName.has(p.name)) maleByName.set(p.name, p)
  const maleMesh = (id: string) => male.meshes.get(id)!
  lap(`male body: ${male.data.parts.length} parts; female anchors: ${fa.items.length} items`)
  const unknown = fa.items.flatMap((i) => i.male_parts.filter((id) => !male.parts.has(id)))
  if (unknown.length) throw new Error(`anchor package names male parts that no longer exist (${unknown.slice(0, 5).join(', ')}…): rerun tools/register/run_anchors.sh`)

  // ── 1. Pose ─────────────────────────────────────────────────────────────────────────────────
  const item = (id: string): FemaleItem => {
    const it = fa.byId.get(id)
    if (!it) throw new Error(`anchor item ${id} missing`)
    return it
  }
  const scanned = (id: string) => fa.scanned(item(id))
  const maleUnion = (it: FemaleItem) => unionMesh(it.male_parts.map(maleMesh))
  /** scan → standing, before the final vertical shift */
  const pose = new Map<string, Rigid>()
  const poseNotes: Record<string, unknown> = {}
  for (const it of fa.items) if (it.repose) pose.set(it.id, fromMatrix(it.repose))
  for (const side of ['left', 'right'] as const) {
    const jc = (n: string) => fa.jointCentres[`${n}_${side}`]!.scanned
    const femur = orientationTo(scanned(`VF_femur_${side}`), maleUnion(item(`VF_femur_${side}`)))
    const tFemur = about(femur.r, jc('hip'), jc('hip'))
    const tibia = orientationTo(scanned(`VF_tibia_${side}`), maleUnion(item(`VF_tibia_${side}`)))
    const tTibia = about(tibia.r, jc('knee'), apply3(tFemur, jc('knee')))
    const footF = unionMesh([scanned(`VF_tarsal_${side}`), scanned(`VF_metatarsal_${side}`)])
    const footM = unionMesh([maleUnion(item(`VF_tarsal_${side}`)), maleUnion(item(`VF_metatarsal_${side}`))])
    const foot = orientationTo(footF, footM)
    const tFoot = about(foot.r, jc('ankle'), apply3(tTibia, jc('ankle')))
    pose.set(`VF_femur_${side}`, tFemur)
    pose.set(`VF_patella_${side}`, tFemur)
    pose.set(`VF_tibia_${side}`, tTibia)
    pose.set(`VF_fibula_${side}`, tTibia)
    for (const g of ['tarsal', 'metatarsal', 'toes']) pose.set(`VF_${g}_${side}`, tFoot)
    poseNotes[side] = { femurDeg: round(angleDeg(femur.r), 1), tibiaDeg: round(angleDeg(tibia.r), 1), footDeg: round(angleDeg(foot.r), 1), fitRmsMm: [femur.rms, tibia.rms, foot.rms].map((v) => round(v * 1000, 1)) }
  }
  // target meshes of every item, in the standing pose
  const target = new Map<string, Mesh>()
  for (const it of fa.items) {
    if (it.pose === 'scanned-only') continue
    if (!(it.kind === 'bone' || it.kind === 'bone-group' || it.kind === 'cartilage' || it.kind === 'tooth')) continue
    target.set(it.id, transformMesh(fa.scanned(it), pose.get(it.id) ?? IDENT))
  }
  // right forearm and hand: clipped by the CT field of view → mirrored left ones, hung on the right humerus
  const MIRRORED = ['radius', 'ulna', 'carpal', 'metacarpal', 'fingers']
  {
    const leftHumerus = mirrorX(target.get('VF_humerus_left')!)
    const src = thinPoints(surfacePoints(leftHumerus, 0.003), 0.005)
    const tgt = thinPoints(surfacePoints(target.get('VF_humerus_right')!, 0.002), 0.002)
    const fit = icp(src, new PointIndex(tgt, 0.006), { maxIterations: 60 })
    for (const b of MIRRORED) target.set(`VF_${b}_right`, transformMesh(mirrorX(target.get(`VF_${b}_left`)!), fit.transform))
    poseNotes.rightForearm = { method: 'left radius, ulna and hand mirrored and attached by fitting the mirrored left humerus to the right humerus', humerusFitRmsMm: round(fit.rms * 1000, 2), rotationDeg: round(angleDeg(fit.transform.r), 1) }
  }
  // stand on the male's floor: lowest point of her feet at the height of his
  const floorOf = (meshes: Mesh[]) => Math.min(...meshes.map((m) => measure(m).bbox[1]))
  const maleFloor = floorOf(male.data.parts.filter((p) => p.tissue === 'bone' && /toe|metatarsal|calcane|talus|cuboid|cuneiform|navicular/i.test(p.name)).map((p) => maleMesh(p.id)))
  const herFloor = floorOf(['left', 'right'].flatMap((s) => ['tarsal', 'metatarsal', 'toes'].map((g) => target.get(`VF_${g}_${s}`)!)))
  const dy = maleFloor - herFloor
  const SHIFT: Rigid = { r: [...IDENT.r], t: [0, dy, 0] }
  for (const [id, m] of target) target.set(id, transformMesh(m, SHIFT))
  const finalPose = (id: string): Rigid => compose(SHIFT, pose.get(id) ?? IDENT)
  console.log(`\nPose: leg bones turned about their proximal joint to the male bone's orientation — ${JSON.stringify(poseNotes)}; whole body shifted ${mm(dy)} mm in Y to stand on the male's floor`)
  report.pose = { ...poseNotes, verticalShiftM: round(dy) }

  // 2. field P: the pose as a smooth field (for her soft tissue and the HRA organs)
  let fieldP: Deformation
  {
    const from: Float32Array[] = []
    const to: Float32Array[] = []
    for (const it of fa.items) {
      if (!(it.kind === 'bone' || it.kind === 'bone-group') || it.quality === 'poor' || it.pose === 'scanned-only') continue
      if (it.side === 'R' && MIRRORED.some((b) => it.id === `VF_${b}_right`)) continue
      const a = thinPoints(surfacePoints(fa.scanned(it), ANCHOR_SPACING), ANCHOR_SPACING)
      from.push(a)
      to.push(applyRigid(finalPose(it.id), a))
    }
    fieldP = buildDeformation(concat(from), concat(to), FIELD)
  }
  const posed = (it: FemaleItem): Mesh => ({ positions: fieldP.apply(fa.scanned(it).positions), indices: fa.scanned(it).indices })
  lap('pose and posing field')

  // ── 3. Field D: male → female ───────────────────────────────────────────────────────────────
  interface Fit { id: string; kind: string; region: string; from: Float32Array; to: Float32Array; conf: number; p95: number; scale: number }
  const fits: Fit[] = []
  const regionOf = (it: FemaleItem): string => {
    const id = it.id
    if (/cranium|mandible|teeth/.test(id)) return 'head'
    if (/vertebrae_C|hyoid|thyroid|cricoid|scalene|sternocleido|levator/.test(id)) return 'neck'
    if (/vertebrae_T|rib_|sternum|clavicula|scapula|serratus/.test(id)) return 'thorax'
    if (/vertebrae_L|kidney|spleen|pancreas|gallbladder|adrenal|liver|rectus|oblique|quadratus|psoas/.test(id)) return 'abdomen'
    if (/sacrum|hip_|gluteus|iliacus|bladder/.test(id)) return 'pelvis'
    if (/humerus|radius|ulna/.test(id)) return 'arm'
    if (/carpal|fingers/.test(id)) return 'hand'
    if (/femur|patella|tibia|fibula/.test(id)) return 'leg'
    if (/tarsal|toes/.test(id)) return 'foot'
    return 'other'
  }
  // vertical axis the ribs sweep round, per body: midline, half-way between spine and sternum
  const midZ = (meshes: Mesh[]) => {
    const b = meshes.map((m) => measure(m).bbox)
    return (Math.min(...b.map((x) => x[2])) + Math.max(...b.map((x) => x[5]))) / 2
  }
  const ribItems = fa.items.filter((i) => /^VF_rib_/.test(i.id))
  const RIB_AXIS_Z_FEMALE = midZ(ribItems.map((i) => target.get(i.id)!))
  const RIB_AXIS_Z_MALE = midZ(ribItems.flatMap((i) => i.male_parts.map(maleMesh)))
  const softTargets = new Map<string, Mesh>()
  const fitOf = new Map<string, Rigid>()
  const rejected: { id: string; p95: number }[] = []
  // vertebrae first: each rib starts its fit from the transform of the vertebra it hangs on
  const ordered = [...fa.items].sort((a, b) => Number(/VF_rib_/.test(a.id)) - Number(/VF_rib_/.test(b.id)))
  for (const it of ordered) {
    if (!it.male_parts.length || it.pose === 'scanned-only') continue
    const hard = it.kind === 'bone' || it.kind === 'bone-group' || it.kind === 'cartilage'
    if (hard) {
      // curled fingers and the single fragmented costal-cartilage label do not correspond to the male shapes
      if (/fingers|costal_cartilages/.test(it.id)) continue
      const tm = target.get(it.id)!
      const m = maleUnion(it)
      const areaF = measure(tm).area
      const sp = Math.max(0.0015, Math.sqrt(areaF / 8000))
      const tgt = thinPoints(surfacePoints(tm, sp), sp * 0.8)
      const index = new PointIndex(tgt, sp * 1.5)
      const raw = surfacePoints(m, sp)
      const rib = /^VF_rib_(?:left|right)_(\d+)$/.exec(it.id)
      const initial = undefined
      const res = icp(thinPoints(raw, Math.max(0.002, Math.sqrt(measure(m).area / 600))), index, { maxIterations: 40, scale: true, initial })
      fitOf.set(it.id, res.transform)
      const dense = applyRigid(res.transform, thinPoints(raw, sp * 0.8))
      const p95 = Math.max(surfaceDistance(dense, index).p95, surfaceDistance(tgt, new PointIndex(dense, sp * 1.5)).p95)
      if (p95 > MAX_FIT_P95 && !rib) {
        rejected.push({ id: it.id, p95 })
        continue
      }
      const from = thinPoints(surfacePoints(m, ANCHOR_SPACING), ANCHOR_SPACING)
      const to = applyRigid(res.transform, from)
      if (rib) {
        // ribs: correspondence by position along the rib (see ribCentreline), the male
        // cross-section offset carried over
        const lm = ribCentreline(raw, RIB_AXIS_Z_MALE)
        const lf = ribCentreline(tgt, RIB_AXIS_Z_FEMALE)
        for (let i = 0; i < from.length; i += 3) {
          const p = [from[i]!, from[i + 1]!, from[i + 2]!]
          const t = paramOf(lm, p)
          const cm = alongLine(lm, t)
          const cf = alongLine(lf, t)
          for (let k = 0; k < 3; k++) to[i + k] = cf[k]! + (p[k]! - cm[k]!)
        }
      }
      const fine = new PointIndex(thinPoints(surfacePoints(tm, 0.001), 0.0008), 0.003)
      const I = new Int32Array(1)
      const D2 = new Float64Array(1)
      for (let i = 0; i < to.length; i += 3) {
        if (!fine.nearest(to[i]!, to[i + 1]!, to[i + 2]!, 1, I, D2, SNAP_DISTANCE)) continue
        to[i] = fine.points[3 * I[0]!]!
        to[i + 1] = fine.points[3 * I[0]! + 1]!
        to[i + 2] = fine.points[3 * I[0]! + 2]!
      }
      const scale = Math.cbrt(Math.abs(res.transform.r[0]! * (res.transform.r[4]! * res.transform.r[8]! - res.transform.r[5]! * res.transform.r[7]!) - res.transform.r[1]! * (res.transform.r[3]! * res.transform.r[8]! - res.transform.r[5]! * res.transform.r[6]!) + res.transform.r[2]! * (res.transform.r[3]! * res.transform.r[7]! - res.transform.r[4]! * res.transform.r[6]!)))
      // a group label (hand, foot, skull) is a coarser target than a single bone
      const conf = rib ? 0.6 : (it.correspondence === 'group' ? 0.6 : 1) / (1 + (p95 / 0.008) ** 2)
      fits.push({ id: it.id, kind: it.kind, region: regionOf(it), from, to, conf, p95, scale })
    } else if (!process.env.SOMA_NOSOFT && it.quality === 'good' && it.kind === (process.env.SOMA_SOFTALL ? it.kind : 'organ') && (it.kind === 'organ' || it.kind === 'muscle') && it.id !== 'VF_brain') {
      // soft tissue: individual shapes differ too much for surface correspondences; only "this
      // organ sits here and is this big" is carried over (centroid and volume)
      const tm = posed(it)
      softTargets.set(it.id, tm)
      const m = maleUnion(it)
      const sM = measure(m)
      const sF = measure(tm)
      const volM = it.male_parts.reduce((s, id) => s + Math.abs(measure(maleMesh(id)).signedVolume), 0)
      const scale = Math.min(1.4, Math.max(0.7, Math.cbrt(Math.abs(sF.signedVolume) / Math.max(1e-9, volM))))
      const from = thinPoints(surfacePoints(m, 0.01), 0.01)
      const to = new Float32Array(from.length)
      for (let i = 0; i < from.length; i += 3) for (let k = 0; k < 3; k++) to[i + k] = sF.centroid[k]! + scale * (from[i + k]! - sM.centroid[k]!)
      fits.push({ id: it.id, kind: it.kind, region: regionOf(it), from, to, conf: SOFT_ANCHOR_CONFIDENCE, p95: NaN, scale })
    }
  }
  // Rib labels of the CT segmentation are not all trustworthy (left ribs 5–9 differ from the right
  // ones by up to 17 % in length): a rib whose mean displacement disagrees with its neighbours
  // (the ribs above and below, its opposite number, its vertebra) is treated as mislabelled.
  const suspectRibs: { id: string; offMm: number }[] = []
  {
    const meanDisp = (f: Fit) => {
      const d = [0, 0, 0]
      for (let i = 0; i < f.from.length; i++) d[i % 3] = d[i % 3]! + (f.to[i]! - f.from[i]!) / (f.from.length / 3)
      return d
    }
    const disp = new Map(fits.map((f) => [f.id, meanDisp(f)]))
    for (const f of [...fits]) {
      const m = /^VF_rib_(left|right)_(\d+)$/.exec(f.id)
      if (!m) continue
      const n = Number(m[2])
      const other = m[1] === 'left' ? 'right' : 'left'
      const refs = [`VF_rib_${m[1]}_${n - 1}`, `VF_rib_${m[1]}_${n + 1}`, `VF_rib_${other}_${n}`, `VF_vertebrae_T${n}`].map((id) => disp.get(id)).filter((d): d is number[] => !!d)
      if (refs.length < 2) continue
      const med = [0, 1, 2].map((k) => quantile(refs.map((d) => d[k]!), 0.5))
      const own = disp.get(f.id)!
      // mirrored x for the opposite rib does not matter for the median of y and z; compare those
      const off = Math.hypot(own[1]! - med[1]!, own[2]! - med[2]!)
      if (off > 0.02) suspectRibs.push({ id: f.id, offMm: round(off * 1000, 1) })
    }
    for (const s of suspectRibs) fits.splice(fits.findIndex((f) => f.id === s.id), 1)
  }
  const buildD = (list: Fit[]): Deformation => {
    const w: number[] = []
    for (const f of list) for (let i = 0; i < f.from.length / 3; i++) w.push(f.conf)
    return buildTwoLevelDeformation(concat(list.map((f) => f.from)), concat(list.map((f) => f.to)), { ...TWO_LEVEL, weights: Float32Array.from(w) })
  }
  const fieldD = buildD(fits)
  const errOf = (def: Deformation, f: Fit) => {
    const out = def.apply(f.from)
    let s = 0
    for (let i = 0; i < out.length; i += 3) s += Math.hypot(out[i]! - f.to[i]!, out[i + 1]! - f.to[i + 1]!, out[i + 2]! - f.to[i + 2]!)
    return s / (out.length / 3)
  }
  const hardFits = fits.filter((f) => f.kind !== 'organ' && f.kind !== 'muscle')
  const residual = new Map(hardFits.map((f) => [f.id, errOf(fieldD, f)]))
  const leaveOut = new Map<string, number>()
  for (let fold = 0; fold < 8; fold++) {
    const def = buildD(fits.filter((_, i) => i % 8 !== fold))
    fits.forEach((f, i) => {
      if (i % 8 === fold && f.kind !== 'organ' && f.kind !== 'muscle') leaveOut.set(f.id, errOf(def, f))
    })
  }
  lap(`male → female field: ${fits.length} anchor structures (${hardFits.length} bone/cartilage, ${fits.length - hardFits.length} soft), ${fits.reduce((s, f) => s + f.from.length / 3, 0)} points`)
  {
    console.log('\nMale → female registration (bone and cartilage anchors; mm, median / p90 / max)')
    console.log(`  ${pad('region', 10)}${pad('n', 5)}${pad('similarity fit p95', 24)}${pad('scale', 20)}${pad('field residual', 22)}leave-out error`)
    const rows: Record<string, unknown>[] = []
    for (const r of ['head', 'neck', 'thorax', 'abdomen', 'pelvis', 'arm', 'hand', 'leg', 'foot', 'all']) {
      const f = hardFits.filter((x) => r === 'all' || x.region === r)
      if (!f.length) continue
      const q3 = (v: number[], scale = 1000, d = 1) => `${(quantile(v, 0.5) * scale).toFixed(d)} / ${(quantile(v, 0.9) * scale).toFixed(d)} / ${(Math.max(...v) * scale).toFixed(d)}`
      const row = { region: r, n: f.length, fitP95: q3(f.map((x) => x.p95)), scale: q3(f.map((x) => x.scale), 1, 2), residual: q3(f.map((x) => residual.get(x.id)!)), leaveOut: q3(f.map((x) => leaveOut.get(x.id)!)) }
      console.log(`  ${pad(r, 10)}${pad(row.n, 5)}${pad(row.fitP95, 24)}${pad(row.scale, 20)}${pad(row.residual, 22)}${row.leaveOut}`)
      rows.push(row)
    }
    if (process.env.SOMA_DEBUG) for (const f of hardFits) console.log(`    ${pad(f.id, 30)}scale ${f.scale.toFixed(2)} fit p95 ${mm(f.p95)} conf ${f.conf.toFixed(2)} residual ${mm(residual.get(f.id)!)} leave-out ${mm(leaveOut.get(f.id)!)}`)
    const worst = [...leaveOut].sort((a, b) => b[1] - a[1]).slice(0, 8)
    console.log(`  worst leave-out: ${worst.map(([id, e]) => `${id} ${mm(e)}`).join(', ')}`)
    if (rejected.length) console.log(`  not used (similarity fit p95 > ${MAX_FIT_P95 * 1000} mm): ${rejected.map((r) => `${r.id} ${mm(r.p95)}`).join(', ')}`)
    if (suspectRibs.length) console.log(`  ribs not used as anchors (displacement disagrees with neighbours by > 20 mm: label suspect): ${suspectRibs.map((r) => `${r.id} ${r.offMm}`).join(', ')}`)
    const odd = hardFits.filter((f) => f.scale > 1.15 || f.scale < 0.85)
    console.log(`  size outliers among the anchors (similarity scale outside 0.85–1.15): ${odd.map((f) => `${f.id} ${f.scale.toFixed(2)}`).join(', ') || 'none'}`)
    report.registration = { anchors: fits.length, hard: hardFits.length, soft: fits.length - hardFits.length, byRegion: rows, suspectRibs, rejected: rejected.map((r) => ({ id: r.id, fitP95Mm: round(r.p95 * 1000, 1) })), perAnchor: hardFits.map((f) => ({ id: f.id, region: f.region, scale: round(f.scale, 3), fitP95Mm: round(f.p95 * 1000, 2), residualMm: round(residual.get(f.id)! * 1000, 2), leaveOutMm: round(leaveOut.get(f.id)! * 1000, 2) })), sizeOutliers: odd.map((f) => f.id) }
  }

  // Jacobian of the field on a grid over the male body
  {
    const all = concat(male.data.parts.filter((p) => p.tissue !== 'skin').map((p) => thinPoints(surfacePoints(maleMesh(p.id), 0.01), 0.01)))
    const near = new PointIndex(thinPoints(all, 0.01), 0.02)
    const boneNames = male.data.parts.filter((p) => p.tissue === 'bone')
    const bonePts = boneNames.map((p) => measure(maleMesh(p.id)).centroid)
    const h = 0.002
    const dets: number[] = []
    const bad: { det: number; at: number[] }[] = []
    const b = [-0.34, -0.08, -0.05, 0.34, 1.66, 0.25]
    const f = (x: number, y: number, z: number) => {
      const d = fieldD.displacementAt(x, y, z)
      return [x + d[0], y + d[1], z + d[2]]
    }
    for (let x = b[0]!; x <= b[3]!; x += 0.012) for (let y = b[1]!; y <= b[4]!; y += 0.012) for (let z = b[2]!; z <= b[5]!; z += 0.012) {
      if (near.distance(x, y, z, 0.012) > 0.012) continue
      const xp = f(x + h, y, z)
      const xm = f(x - h, y, z)
      const yp = f(x, y + h, z)
      const ym = f(x, y - h, z)
      const zp = f(x, y, z + h)
      const zm = f(x, y, z - h)
      const J = [0, 1, 2].map((i) => [(xp[i]! - xm[i]!) / (2 * h), (yp[i]! - ym[i]!) / (2 * h), (zp[i]! - zm[i]!) / (2 * h)])
      const det = J[0]![0]! * (J[1]![1]! * J[2]![2]! - J[1]![2]! * J[2]![1]!) - J[0]![1]! * (J[1]![0]! * J[2]![2]! - J[1]![2]! * J[2]![0]!) + J[0]![2]! * (J[1]![0]! * J[2]![1]! - J[1]![1]! * J[2]![0]!)
      dets.push(det)
      if (det <= 0.2 || det > 4) bad.push({ det, at: [x, y, z] })
    }
    const nearestBone = (p: number[]) => {
      let best = 0
      let bd = Infinity
      bonePts.forEach((c, i) => {
        const d = Math.hypot(c[0] - p[0]!, c[1] - p[1]!, c[2] - p[2]!)
        if (d < bd) {
          bd = d
          best = i
        }
      })
      return boneNames[best]!.name
    }
    const where = new Map<string, number>()
    for (const x of bad) where.set(nearestBone(x.at), (where.get(nearestBone(x.at)) ?? 0) + 1)
    if (process.env.SOMA_DEBUG) {
      const allFrom = concat(fits.map((f) => f.from))
      const owner: string[] = []
      const disp: number[][] = []
      for (const f of fits) for (let i = 0; i < f.from.length; i += 3) {
        owner.push(f.id)
        disp.push([f.to[i]! - f.from[i]!, f.to[i + 1]! - f.from[i + 1]!, f.to[i + 2]! - f.from[i + 2]!])
      }
      const ix = new PointIndex(allFrom, 0.02)
      const I = new Int32Array(12)
      const D = new Float64Array(12)
      for (const x of bad.filter((q) => q.det <= 0).sort((p, q) => p.det - q.det).filter((_, i) => i % 40 === 0).slice(0, 10)) {
        const n = ix.nearest(x.at[0]!, x.at[1]!, x.at[2]!, 12, I, D)
        const by = new Map<string, number[][]>()
        for (let k = 0; k < n; k++) by.set(owner[I[k]!]!, [...(by.get(owner[I[k]!]!) ?? []), [...disp[I[k]!]!, Math.sqrt(D[k]!)]])
        console.log(`  fold det ${x.det.toFixed(2)} at ${x.at.map((v) => (v * 1000).toFixed(0))} near ${nearestBone(x.at)}: ` + [...by].map(([id, v]) => `${id}×${v.length} d=(${[0, 1, 2].map((k) => ((v.reduce((s, q) => s + q[k]!, 0) / v.length) * 1000).toFixed(0)).join(',')}) @${(Math.min(...v.map((q) => q[3]!)) * 1000).toFixed(0)}mm`).join(' | '))
      }
    }
    const folded = dets.filter((d) => d <= 0).length
    const stats = { samples: dets.length, min: round(Math.min(...dets), 3), p01: round(quantile(dets, 0.01), 3), median: round(quantile(dets, 0.5), 3), p99: round(quantile(dets, 0.99), 3), max: round(Math.max(...dets), 3), folded, below02: dets.filter((d) => d <= 0.2).length, above4: dets.filter((d) => d > 4).length }
    const top = [...where].sort((a, b) => b[1] - a[1]).slice(0, 10)
    console.log(`\nJacobian determinant of the field (12 mm grid, ${stats.samples} samples within 12 mm of male tissue): min ${stats.min}, 1% ${stats.p01}, median ${stats.median}, 99% ${stats.p99}, max ${stats.max}; folded (≤ 0): ${folded}; ≤ 0.2: ${stats.below02}; > 4: ${stats.above4}`)
    console.log(`  extreme samples by nearest male bone: ${top.map(([n, c]) => `${n} ${c}`).join(', ') || 'none'}`)
    report.jacobian = { ...stats, extremeByNearestBone: Object.fromEntries(top) }
  }
  lap('field checks')

  // ── 4. Parts ────────────────────────────────────────────────────────────────────────────────
  const parts: FPart[] = []
  const replaced = new Set<string>()
  const realNotes: Record<string, string> = {}
  const softOffsets: { id: string; name: string; offsetMm: number }[] = []
  const notUsed: { id: string; reason: string }[] = []
  const lumbarConcept = male.data.trees.isa.find((c) => c.name === 'lumbar vertebra')?.id ?? 'FMA9921'
  for (const it of fa.items) {
    if (it.source !== 'vhf-ct' || it.pose === 'scanned-only') continue
    const isBone = it.kind === 'bone' || it.kind === 'cartilage'
    const mirrored = it.side === 'R' && MIRRORED.some((b) => it.id === `VF_${b}_right`)
    if (it.id === 'VF_vertebrae_L1') {
      // six lumbar vertebrae: her first one has no male counterpart
      parts.push({ id: it.id, fma: lumbarConcept, name: 'Supernumerary lumbar vertebra (first of six)', system: 'skeletal', tissue: 'bone', depth: depthOf('skeletal', 'bone'), side: 'M', provenance: 'scanned', source: SOURCE_VHF.name, mesh: target.get(it.id)!, volume: it.volume_ml })
      continue
    }
    if (it.correspondence !== 'one-to-one') continue
    const m = male.parts.get(it.male_parts[0]!)!
    const base = { id: it.id, fma: m.fma, name: m.name, system: m.system, tissue: m.tissue, depth: m.depth, side: m.side, source: SOURCE_VHF.name, male: m.id, volume: it.volume_ml }
    if (isBone && (it.quality !== 'poor' || mirrored)) {
      if (mirrored) {
        parts.push({ ...base, provenance: 'warped', mesh: target.get(it.id)!, volume: undefined, note: 'mirrored left bone (the right one is clipped by the CT field of view)' })
        realNotes[it.id] = 'mirrored left'
      } else parts.push({ ...base, provenance: 'scanned', mesh: target.get(it.id)! })
      replaced.add(m.id)
    } else if (!isBone && it.quality === 'good' && (it.kind === 'organ' || it.kind === 'muscle')) {
      const mesh = softTargets.get(it.id) ?? posed(it)
      // her real part is used only where it agrees with where the field puts the male one;
      // a segmented muscle that is a fragment of, or far from, its male counterpart would break
      // the continuity of everything warped around it
      {
        const wm = { positions: fieldD.apply(maleMesh(m.id).positions), indices: maleMesh(m.id).indices }
        const ws = measure(wm)
        const rs = measure(mesh)
        const off = Math.hypot(ws.centroid[0] - rs.centroid[0], ws.centroid[1] - rs.centroid[1], ws.centroid[2] - rs.centroid[2])
        const vr = Math.abs(rs.signedVolume) / Math.max(1e-9, Math.abs(ws.signedVolume))
        if (off > REAL_SOFT_MAX_OFFSET || vr < 0.4 || vr > 2.5) {
          notUsed.push({ id: it.id, reason: `${mm(off)} mm from the warped male ${m.name.toLowerCase()}, volume ratio ${vr.toFixed(2)}` })
          continue
        }
      }
      // did the posing field move it rigidly?
      const src = fa.scanned(it).positions
      const fit = fitRigid(src, mesh.positions)
      const back = applyRigid(fit, src)
      let bend = 0
      for (let i = 0; i < back.length; i += 3) bend = Math.max(bend, Math.hypot(back[i]! - mesh.positions[i]!, back[i + 1]! - mesh.positions[i + 1]!, back[i + 2]! - mesh.positions[i + 2]!))
      parts.push({ ...base, provenance: bend <= RIGID_TOLERANCE ? 'scanned' : 'warped', mesh, note: bend <= RIGID_TOLERANCE ? undefined : `re-posed non-rigidly with the bones it attaches to (bent by up to ${mm(bend)} mm)` })
      if (bend > RIGID_TOLERANCE) realNotes[it.id] = `bent ${mm(bend)} mm by re-posing`
      replaced.add(m.id)
      // how far is her real part from where the field would have put the male one?
      const wc = measure({ positions: fieldD.apply(maleMesh(m.id).positions), indices: maleMesh(m.id).indices }).centroid
      const rc = measure(mesh).centroid
      softOffsets.push({ id: it.id, name: m.name, offsetMm: round(Math.hypot(wc[0] - rc[0], wc[1] - rc[1], wc[2] - rc[2]) * 1000, 1) })
    }
  }
  for (const it of fa.items) {
    if (it.source !== 'vhf-ct' || it.correspondence !== 'one-to-one' || parts.some((p) => p.id === it.id) || notUsed.some((n) => n.id === it.id)) continue
    notUsed.push({ id: it.id, reason: it.pose === 'scanned-only' ? 'supine body surface' : it.kind === 'vessel' ? 'vessel trunks are kept as one warped tree so that branches stay connected' : it.quality !== 'good' ? `quality ${it.quality}: ${it.quality_reasons[0] ?? ''}` : it.kind })
  }
  const real = parts.length
  console.log(`\nHer real soft parts vs where the field puts the male counterpart (centroid distance, mm): ${softOffsets.map((o) => `${o.name} ${o.offsetMm}`).join(', ')}`)
  report.realSoftPartOffsets = softOffsets
  const dropped = male.data.parts.filter(isMaleOnly)
  const droppedIds = new Set(dropped.map((p) => p.id))
  // her real parts as solids for collision handling of everything warped
  const solids: ExistingPart[] = parts.map((p) => ({ id: p.id, fma: p.fma, name: p.name, mesh: p.mesh, stats: measure(p.mesh), system: p.system, tissue: p.tissue }))
  const field = new SurfaceField(solids)
  const isHard = (i: number) => HARD_TISSUES.includes(field.parts[i]!.tissue)
  let pushedParts = 0
  const insideBone: { name: string; before: number; after: number }[] = []
  const boneSolid = (i: number) => field.parts[i]!.tissue === 'bone' || field.parts[i]!.tissue === 'cartilage'
  let nerveStats = { length: 0, boneBefore: 0, boneAfter: 0, canal: 0, muscleBefore: 0, muscleAfter: 0, points: 0, moved: 0 }
  for (const m of male.data.parts) {
    if (replaced.has(m.id) || droppedIds.has(m.id)) continue
    const base = { id: `W_${m.id}`, fma: m.fma, name: m.name, system: m.system, tissue: m.tissue, depth: m.depth, side: m.side, provenance: 'warped' as Provenance, source: m.source ?? male.data.sources[0]!.name, male: m.id }
    const lines = male.nerves.get(m.id)
    if (lines && m.tissue === 'nerve') {
      const w = warpNerveLines(lines, fieldD, field, { ...NERVE_BUILD_DEFAULTS, step: 0.002, canal: canalFor(m.name) })
      if (w.mesh) {
        nerveStats = {
          length: nerveStats.length + w.before.length, boneBefore: nerveStats.boneBefore + w.before.inBone * w.before.length, boneAfter: nerveStats.boneAfter + w.after.inBone * w.after.length,
          canal: nerveStats.canal + w.after.inCanal * w.after.length, muscleBefore: nerveStats.muscleBefore + w.before.deepInMuscle * w.before.length, muscleAfter: nerveStats.muscleAfter + w.after.deepInMuscle * w.after.length,
          points: nerveStats.points + w.points, moved: nerveStats.moved + w.pushed,
        }
        parts.push({ ...base, mesh: w.mesh, centrelines: w.branches, keepGeometry: true })
        continue
      }
    }
    const src = maleMesh(m.id)
    let positions = fieldD.apply(src.positions)
    // warped soft parts must not sit in her real bones; warped bones (skull, hands, feet, sternum) are bones themselves
    if (!HARD_TISSUES.includes(m.tissue) && m.tissue !== 'skin') {
      const st = measure({ positions, indices: src.indices })
      const samples = thinPoints(surfacePoints({ positions, indices: src.indices }, 0.004), 0.003)
      const before = overlapWith(samples, st.bbox, field, 0.002, 0.004, boneSolid).insideAny
      if (before > 0) {
        const push = pushOutOfSolids(positions, st.bbox, field, isHard)
        positions = push.positions
        if (push.moved) pushedParts++
        const after = overlapWith(thinPoints(surfacePoints({ positions, indices: src.indices }, 0.004), 0.003), measure({ positions, indices: src.indices }).bbox, field, 0.002, 0.004, boneSolid).insideAny
        insideBone.push({ name: m.name, before, after })
      } else insideBone.push({ name: m.name, before: 0, after: 0 })
    }
    parts.push({ ...base, mesh: { positions, indices: src.indices }, keepGeometry: true })
  }
  lap(`${real} real female parts, ${parts.length - real} male parts warped, ${dropped.length} male-only parts dropped`)

  // HRA female organs
  const hraClass = (it: FemaleItem): { system: SystemId; tissue: TissueId } => {
    const n = it.id
    if (/artery/.test(n)) return { system: 'cardiovascular', tissue: 'artery' }
    if (/vein/.test(n)) return { system: 'cardiovascular', tissue: 'vein' }
    if (/HRA_fat_/.test(n)) return { system: 'integumentary', tissue: 'fat' }
    if (/nipple|areola/.test(n)) return { system: 'integumentary', tissue: 'skin' }
    if (/mammary|lactiferous/.test(n)) return { system: 'integumentary', tissue: 'gland' }
    if (/suspensory_ligaments_[LR]$/.test(n)) return { system: 'integumentary', tissue: 'ligament' }
    if (it.kind === 'ligament') return { system: 'reproductive', tissue: /pouch/.test(n) ? 'space' : 'ligament' }
    if (/ovary/.test(n)) return { system: 'reproductive', tissue: 'gland' }
    return { system: 'reproductive', tissue: 'organ' }
  }
  const hraName = (it: FemaleItem) => {
    const n = it.name.replace(/\s+/g, ' ').trim()
    const sided = /\b(left|right)\b/i.test(n) || it.side === 'M' ? n : `${it.side === 'L' ? 'left' : 'right'} ${n}`
    return sided[0]!.toUpperCase() + sided.slice(1)
  }
  for (const it of fa.items) {
    if (it.source !== 'hra') continue
    const cls = hraClass(it)
    const fma = it.fma ?? (it.ontology_id ? it.ontology_id.replace(':', '_') : `HRAC_${it.id.replace(/^HRA_/, '').toLowerCase()}`)
    const w = weld(posed(it).positions, fa.scanned(it).indices)
    parts.push({ id: it.id, fma, name: hraName(it), system: cls.system, tissue: cls.tissue, depth: depthOf(cls.system, cls.tissue), side: it.side, provenance: 'curated', source: SOURCE_HRA.name, mesh: { positions: w.positions, indices: w.indices }, volume: it.volume_ml || undefined })
  }
  const hra = parts.filter((p) => p.provenance === 'curated')
  lap(`${hra.length} HRA parts added`)
  await finish({ parts, male, fa, fmaNames, report, notes, outDir, lap, dropped, realNotes, insideBone, pushedParts, nerveStats, hra, notUsed })
}

interface FinishInput {
  parts: FPart[]
  male: Awaited<ReturnType<typeof loadBuiltBody>>
  fa: ReturnType<typeof loadFemaleAnchors>
  fmaNames: ReturnType<typeof loadFmaNames>
  report: Record<string, unknown>
  notes: string[]
  outDir: string
  lap: (s: string) => void
  dropped: Part[]
  realNotes: Record<string, string>
  insideBone: { name: string; before: number; after: number }[]
  pushedParts: number
  nerveStats: { length: number; boneBefore: number; boneAfter: number; canal: number; muscleBefore: number; muscleAfter: number; points: number; moved: number }
  hra: FPart[]
  notUsed: { id: string; reason: string }[]
}

async function finish(input: FinishInput) {
  const { parts, male, fa, fmaNames, report, notes, outDir, lap, dropped, realNotes, insideBone, pushedParts, nerveStats, hra, notUsed } = input
  const byName = (name: string) => parts.find((p) => p.name === name)
  const samplesOf = (m: Mesh, spacing = 0.003) => thinPoints(surfacePoints(m, spacing), spacing * 0.8)

  // ── 5. Sex-specific collisions ──────────────────────────────────────────────────────────────
  const collisions: Record<string, unknown> = {}
  {
    // right ovary against the iliac vessels: move the ovary (rigidly) until it is clear
    for (const side of ['left', 'right']) {
      const ovary = parts.find((p) => p.id === `HRA_${side}_ovary`)
      if (!ovary) continue
      const vessels = parts.filter((p) => (p.tissue === 'artery' || p.tissue === 'vein') && /iliac/i.test(p.name))
      const insideAny = (m: Mesh) => {
        const pts = samplesOf(m, 0.002)
        const b = measure(m).bbox
        let inside = 0
        let worst = ''
        let worstN = 0
        for (const v of vessels) {
          const vb = measure(v.mesh).bbox
          if (vb[0] > b[3] || vb[3] < b[0] || vb[1] > b[4] || vb[4] < b[1] || vb[2] > b[5] || vb[5] < b[2]) continue
          const n = new InsideTester(v.mesh).fractionInside(pts)
          inside += n
          if (n > worstN) {
            worstN = n
            worst = v.name
          }
        }
        return { inside, worst }
      }
      const before = insideAny(ovary.mesh)
      let moved = 0
      if (before.inside > 0.02) {
        const vein = parts.find((p) => p.name === before.worst)!
        const oc = measure(ovary.mesh).centroid
        const idx = new PointIndex(samplesOf(vein.mesh, 0.002), 0.006)
        const I = new Int32Array(1)
        const D = new Float64Array(1)
        idx.nearest(oc[0], oc[1], oc[2], 1, I, D)
        // away from the nearest point of the vessel, horizontally towards the pelvic cavity (medially)
        let dir = [oc[0] - idx.points[3 * I[0]!]!, oc[1] - idx.points[3 * I[0]! + 1]!, oc[2] - idx.points[3 * I[0]! + 2]!]
        const len = Math.hypot(dir[0]!, dir[1]!, dir[2]!)
        dir = len > 1e-6 ? dir.map((v) => v / len) : [side === 'left' ? -1 : 1, 0, 0]
        for (let step = 1; step <= 25; step++) {
          const trial: Mesh = { positions: Float32Array.from(ovary.mesh.positions, (v, i) => v + dir[i % 3]! * 0.001 * step), indices: ovary.mesh.indices }
          moved = step
          if (insideAny(trial).inside <= 0.02) {
            ovary.mesh = trial
            break
          }
          if (step === 25) ovary.mesh = trial
        }
      }
      const after = insideAny(ovary.mesh)
      collisions[`${side} ovary vs iliac vessels`] = { insideBefore: round(before.inside, 3), vessel: before.worst || null, movedMm: moved, insideAfter: round(after.inside, 3) }
    }
    // uterus, vagina, ovaries against the warped male pelvic viscera: slide the viscera's vertices out
    const female = parts.filter((p) => p.provenance === 'curated' && p.system === 'reproductive' && (p.tissue === 'organ' || p.tissue === 'gland'))
    const solids: ExistingPart[] = female.map((p) => ({ id: p.id, fma: p.fma, name: p.name, mesh: p.mesh, stats: measure(p.mesh), system: p.system, tissue: 'bone' as TissueId }))
    const field = new SurfaceField(solids)
    const fb = solids.reduce((b, s) => [Math.min(b[0]!, s.stats.bbox[0]), Math.min(b[1]!, s.stats.bbox[1]), Math.min(b[2]!, s.stats.bbox[2]), Math.max(b[3]!, s.stats.bbox[3]), Math.max(b[4]!, s.stats.bbox[4]), Math.max(b[5]!, s.stats.bbox[5])], [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
    // Make room first: the male pelvis has bowel where her uterus and ovaries are. Warped parts
    // near each organ are moved radially out of an ellipsoid around it (semi-axes = half its
    // bounds + 3 mm); the displacement fades to zero at 1.7 semi-axes, so nothing tears.
    const groups: { name: string; members: FPart[] }[] = [
      { name: 'uterus', members: female.filter((p) => /uterus|cervix|cornua|cervical os|uterine segment/i.test(p.name) && !/tube|ligament/i.test(p.name)) },
      { name: 'left ovary', members: female.filter((p) => p.id === 'HRA_left_ovary') },
      { name: 'right ovary', members: female.filter((p) => p.id === 'HRA_right_ovary') },
    ]
    const roomFor: Record<string, number> = {}
    for (const g of groups) {
      if (!g.members.length) continue
      const b = g.members.map((p) => measure(p.mesh).bbox).reduce((a, c) => [Math.min(a[0]!, c[0]), Math.min(a[1]!, c[1]), Math.min(a[2]!, c[2]), Math.max(a[3]!, c[3]), Math.max(a[4]!, c[4]), Math.max(a[5]!, c[5])], [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
      const c = [(b[0]! + b[3]!) / 2, (b[1]! + b[4]!) / 2, (b[2]! + b[5]!) / 2]
      const r = [(b[3]! - b[0]!) / 2 + 0.003, (b[4]! - b[1]!) / 2 + 0.003, (b[5]! - b[2]!) / 2 + 0.003]
      const OUTER = 1.7
      let movedParts = 0
      for (const p of parts) {
        if (p.provenance !== 'warped' || p.tissue === 'skin' || HARD_TISSUES.includes(p.tissue) || p.tissue === 'muscle') continue
        const pos = p.mesh.positions
        let out: Float32Array | null = null
        const moveAll = (arr: Float32Array): Float32Array | null => {
          let res: Float32Array | null = null
          for (let i = 0; i < arr.length; i += 3) {
            const d = [(arr[i]! - c[0]!) / r[0]!, (arr[i + 1]! - c[1]!) / r[1]!, (arr[i + 2]! - c[2]!) / r[2]!]
            const rho = Math.hypot(d[0]!, d[1]!, d[2]!)
            if (rho >= OUTER || rho < 1e-6) continue
            // monotone map [0, OUTER] → [1.05, OUTER]
            const k = (1.05 + (rho * (OUTER - 1.05)) / OUTER) / rho
            if (!res) res = Float32Array.from(arr)
            res[i] = c[0]! + d[0]! * k * r[0]!
            res[i + 1] = c[1]! + d[1]! * k * r[1]!
            res[i + 2] = c[2]! + d[2]! * k * r[2]!
          }
          return res
        }
        out = moveAll(pos)
        if (out) {
          p.mesh = { positions: out, indices: p.mesh.indices }
          movedParts++
        }
        if (p.centrelines) p.centrelines = p.centrelines.map((l) => ({ points: moveAll(l.points) ?? l.points, radius: l.radius }))
      }
      roomFor[g.name] = movedParts
    }
    collisions.roomMade = roomFor
    const rows: { name: string; before: number; after: number; movable: boolean }[] = []
    for (const p of parts) {
      if (p.provenance === 'curated' || p.tissue === 'skin' || HARD_TISSUES.includes(p.tissue) || p.tissue === 'nerve') continue
      const st = measure(p.mesh)
      if (st.bbox[0] > fb[3]! || st.bbox[3] < fb[0]! || st.bbox[1] > fb[4]! || st.bbox[4] < fb[1]! || st.bbox[2] > fb[5]! || st.bbox[5] < fb[2]!) continue
      const frac = (m: Mesh) => overlapWith(samplesOf(m, 0.003), measure(m).bbox, field, 0.002, 0.004, () => true).insideAny
      const before = frac(p.mesh)
      if (before < 0.005) continue
      // her own scanned organs (bladder) are not reshaped; warped male parts are
      const movable = p.provenance === 'warped'
      if (movable) p.mesh = { positions: pushOutOfSolids(p.mesh.positions, st.bbox, field, () => true, { clearance: 0.0005, maxPush: 0.03, radius: 0.012, step: 0.0005 }).positions, indices: p.mesh.indices }
      rows.push({ name: p.name, before, after: movable ? frac(p.mesh) : before, movable })
    }
    rows.sort((a, b) => b.before - a.before)
    console.log(`\nFemale pelvic organs (HRA) against other parts: ${rows.length} parts had surface inside the uterus, vagina, tubes or ovaries; warped ones were slid out (≤ 30 mm)`)
    for (const r of rows.slice(0, 14)) console.log(`  ${pad(r.name, 44)}${(r.before * 100).toFixed(1)}% → ${(r.after * 100).toFixed(1)}%${r.movable ? '' : '  (her scanned part: not moved)'}`)
    for (const [k, v] of Object.entries(collisions)) console.log(`  ${k}: ${JSON.stringify(v)}`)
    collisions.pelvicViscera = rows.map((r) => ({ ...r, before: round(r.before, 4), after: round(r.after, 4) }))
    // and the other way round: how much of the uterus is inside other soft organs afterwards
    const others: ExistingPart[] = parts.filter((p) => p.provenance !== 'curated' && SOLID_TISSUES.includes(p.tissue)).map((p) => ({ id: p.id, fma: p.fma, name: p.name, mesh: p.mesh, stats: measure(p.mesh), system: p.system, tissue: p.tissue }))
    const near = others.filter((o) => !(o.stats.bbox[0] > fb[3]! || o.stats.bbox[3] < fb[0]! || o.stats.bbox[1] > fb[4]! || o.stats.bbox[4] < fb[1]! || o.stats.bbox[2] > fb[5]! || o.stats.bbox[5] < fb[2]!))
    const of = new SurfaceField(near)
    const uterine: Record<string, unknown> = {}
    for (const p of female) {
      const ov = overlapWith(samplesOf(p.mesh, 0.002), measure(p.mesh).bbox, of, 0.002, 0.004, () => true)
      if (ov.insideAny > 0.02) uterine[p.name] = { inside: round(ov.insideAny, 3), in: [...ov.inside].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([i, f]) => `${near[i]!.name} ${(f * 100).toFixed(0)}%`) }
    }
    console.log(`  HRA organs still inside other solids (> 2% of surface): ${Object.entries(uterine).map(([k, v]) => `${k} ${((v as { inside: number }).inside * 100).toFixed(0)}% (${(v as { in: string[] }).in.join(', ')})`).join('; ') || 'none'}`)
    collisions.hraInsideOthers = uterine
    report.collisions = collisions
  }
  lap('sex-specific collisions')

  // ── 6. Final geometry ───────────────────────────────────────────────────────────────────────
  const final: { p: FPart; mesh: Mesh; stats: MeshStats }[] = []
  let trianglesIn = 0
  for (const p of parts) {
    let mesh = p.mesh
    trianglesIn += mesh.indices.length / 3
    if (!p.keepGeometry) {
      const w = weld(mesh.positions, mesh.indices)
      mesh = { positions: w.positions, indices: w.indices }
      const st = measure(mesh)
      const thickness = st.area > 0 ? (3 * Math.abs(st.signedVolume)) / st.area : 0
      const err = Math.min(SIMPLIFY.max, Math.max(SIMPLIFY.min, SIMPLIFY.perThickness * thickness))
      const simp = await simplifyMesh(mesh, err, Math.max(SIMPLIFY.minTriangles, st.area / (0.433 * SIMPLIFY.maxEdge ** 2)))
      mesh = { positions: simp.positions, indices: simp.indices }
    }
    final.push({ p, mesh, stats: measure(mesh) })
  }
  const trianglesOut = final.reduce((s, f) => s + f.mesh.indices.length / 3, 0)
  lap(`final geometry: ${trianglesIn} → ${trianglesOut} triangles`)

  // adjacency
  const adj = computeAdjacency(final.map((f) => f.mesh), { threshold: ADJACENCY.threshold, spacing: ADJACENCY.spacing })
  const envelopes = new Set(adj.neighbours.map((l, i) => (l.length > ADJACENCY.maxDegree ? i : -1)).filter((i) => i >= 0))
  const neighbours = adj.neighbours.map((l, i) => (envelopes.has(i) ? [] : l.filter((j) => !envelopes.has(j))))
  {
    const deg = neighbours.map((l) => l.length).filter((_, i) => !envelopes.has(i))
    console.log(`\nAdjacency: ${neighbours.reduce((s, l) => s + l.length, 0) / 2} pairs; degree median ${quantile(deg, 0.5)}, p90 ${quantile(deg, 0.9)}, p99 ${quantile(deg, 0.99)}, max ${Math.max(...deg)}; envelopes excluded: ${[...envelopes].map((i) => `${final[i]!.p.name} (${adj.neighbours[i]!.length})`).join(', ') || 'none'}`)
    report.adjacency = { pairs: neighbours.reduce((s, l) => s + l.length, 0) / 2, degree: { median: quantile(deg, 0.5), p90: quantile(deg, 0.9), p99: quantile(deg, 0.99), max: Math.max(...deg) }, envelopes: [...envelopes].map((i) => final[i]!.p.name) }
  }
  lap('adjacency')

  const outParts: Part[] = final.map((f, i) => ({
    id: f.p.id,
    fma: f.p.fma,
    name: f.p.name,
    system: f.p.system,
    tissue: f.p.tissue,
    depth: f.p.depth,
    side: f.p.side,
    provenance: f.p.provenance,
    source: f.p.source,
    bbox: f.stats.bbox.map((v) => round(v)) as Part['bbox'],
    centroid: f.stats.centroid.map((v) => round(v)) as Part['centroid'],
    ...(f.p.volume ? { volume: f.p.volume } : {}),
    triangles: f.mesh.indices.length / 3,
    adjacent: neighbours[i]!.map((j) => final[j]!.p.id),
  }))

  // ── 7. Trees: the male trees with part ids translated, male-only concepts pruned, female ones added
  const toFemale = new Map<string, string>()
  for (const p of parts) if (p.male) toFemale.set(p.male, p.id)
  const fallbackIsa = (name: string) => male.data.trees.isa.find((c) => c.name === name)?.id ?? null
  const rebuild = (tree: Concept[], extras: { part: string; path: [string, string][]; anchor: string | null }[]): Concept[] => {
    const nodes = new Map<string, Concept>(tree.map((c) => [c.id, { ...c, parts: c.parts.map((id) => toFemale.get(id)).filter((id): id is string => !!id) }]))
    const order = tree.map((c) => c.id)
    for (const e of extras) {
      if (!e.anchor || !nodes.has(e.anchor)) continue
      const chain = [...e.path.map(([id]) => id), e.anchor]
      // create parents before children so the list stays parent-first
      for (let k = e.path.length - 1; k >= 0; k--) {
        const [id, label] = e.path[k]!
        if (nodes.has(id)) continue
        nodes.set(id, { id, name: label, parent: chain[k + 1]!, parts: [] })
        order.push(id)
      }
      nodes.get(chain[0]!)!.parts.push(e.part)
    }
    // prune concepts with nothing beneath them
    const children = new Map<string, string[]>()
    for (const id of order) {
      const c = nodes.get(id)!
      if (c.parent) children.set(c.parent, [...(children.get(c.parent) ?? []), id])
    }
    const alive = new Map<string, boolean>()
    const isAlive = (id: string): boolean => {
      if (alive.has(id)) return alive.get(id)!
      const v = nodes.get(id)!.parts.length > 0 || (children.get(id) ?? []).some(isAlive)
      alive.set(id, v)
      return v
    }
    // parent-first order: originals already are; new nodes were appended parent-first per chain,
    // but a new node's parent may be another new node appended later → stable topological pass
    const out: Concept[] = []
    const emitted = new Set<string>()
    const emit = (id: string) => {
      if (emitted.has(id) || !isAlive(id)) return
      const c = nodes.get(id)!
      if (c.parent) emit(c.parent)
      emitted.add(id)
      out.push(c)
    }
    for (const id of order) emit(id)
    return out
  }
  const isaExtras: { part: string; path: [string, string][]; anchor: string | null }[] = []
  const partOfExtras: { part: string; path: [string, string][]; anchor: string | null }[] = []
  const inIsa = new Set(male.data.trees.isa.map((c) => c.id))
  const placement: Record<string, number> = {}
  const partOfByName = (n: string) => male.data.trees.partOf.find((c) => c.name === n)?.id ?? null
  for (const p of parts) {
    if (p.male) continue
    if (p.id === 'VF_vertebrae_L1') {
      isaExtras.push({ part: p.id, path: [], anchor: p.fma })
      partOfExtras.push({ part: p.id, path: [], anchor: partOfByName('vertebral column') ?? partOfByName('skeletal system') })
      continue
    }
    // HRA
    const fallback = fallbackIsa(p.tissue === 'artery' ? 'artery' : p.tissue === 'vein' ? 'vein' : 'anatomical structure')
    let tp
    if (/^FMA\d+$/.test(p.fma) && fmaNames) tp = isaPathFromFma(p.fma, fmaNames.label.get(p.fma) ?? p.name, (id) => fmaNames.parents.get(id), (id) => fmaNames.label.get(id), (id) => inIsa.has(id), fallback)
    else tp = { path: [[p.fma, p.name[0]!.toLowerCase() + p.name.slice(1)]] as [string, string][], anchor: fallback, how: 'by hand' as const }
    placement[tp.how] = (placement[tp.how] ?? 0) + 1
    isaExtras.push({ part: p.id, path: tp.path, anchor: tp.anchor })
    // part-of: by hand, under the system the part belongs to
    const sys = p.system === 'reproductive' ? partOfByName('genital system') : p.system === 'integumentary' ? (partOfByName('integument') ?? partOfByName('integumentary system')) : partOfByName('cardiovascular system')
    partOfExtras.push({ part: p.id, path: [[p.fma, p.name[0]!.toLowerCase() + p.name.slice(1)]], anchor: sys })
  }
  // the male-only "genital system" branch would be pruned before the female parts are attached: keep the node
  const isaTree = rebuild(male.data.trees.isa, isaExtras)
  const partOfTree = rebuild(male.data.trees.partOf, partOfExtras)
  const reach = (t: Concept[]) => new Set(t.flatMap((c) => c.parts))
  console.log(`\nTrees: isa ${isaTree.length} concepts covering ${reach(isaTree).size}/${parts.length} parts; partOf ${partOfTree.length} concepts covering ${reach(partOfTree).size} parts; HRA isa placement: ${JSON.stringify(placement)} (partOf: by hand under genital system / integument / cardiovascular system)`)
  report.trees = { isa: { concepts: isaTree.length, parts: reach(isaTree).size }, partOf: { concepts: partOfTree.length, parts: reach(partOfTree).size }, hraIsaPlacement: placement }

  // ── 8. Checks ───────────────────────────────────────────────────────────────────────────────
  const meshByName = new Map<string, Mesh>()
  const nerveByName = new Map<string, Polyline[]>()
  for (const f of final) {
    if (!meshByName.has(f.p.name)) meshByName.set(f.p.name, f.p.mesh)
    if (f.p.centrelines && !nerveByName.has(f.p.name)) nerveByName.set(f.p.name, f.p.centrelines)
  }
  const landmarks = runLandmarkChecks({ mesh: (n) => meshByName.get(n) ?? null, nerve: (n) => nerveByName.get(n) ?? null })
  console.log('\nNerve landmark checks (same definitions as the male)')
  for (const r of landmarks) console.log(`  ${r.evaluated ? (r.pass ? 'PASS' : 'FAIL') : 'n/a '} ${r.side} ${pad(r.id, 20)}${r.measured.slice(0, 230)}`)
  console.log(`  ${landmarks.filter((r) => r.pass).length} pass, ${landmarks.filter((r) => r.evaluated && !r.pass).length} fail, ${landmarks.filter((r) => !r.evaluated).length} not evaluated`)
  report.landmarks = landmarks

  // muscle attachments: both ends of long muscles still on the right bones?
  const maleMeshByName = new Map<string, Mesh>()
  for (const p of male.data.parts) if (!maleMeshByName.has(p.name)) maleMeshByName.set(p.name, male.meshes.get(p.id)!)
  const endDistance = (muscle: Mesh, bone: Mesh, end: 'top' | 'bottom'): number => {
    let y0 = Infinity
    let y1 = -Infinity
    for (let i = 1; i < muscle.positions.length; i += 3) {
      y0 = Math.min(y0, muscle.positions[i]!)
      y1 = Math.max(y1, muscle.positions[i]!)
    }
    const cut = end === 'top' ? y1 - 0.04 * (y1 - y0) : y0 + 0.04 * (y1 - y0)
    const idx = new PointIndex(samplesOf(bone, 0.002), 0.01)
    const d: number[] = []
    for (let i = 0; i < muscle.positions.length; i += 3) {
      const y = muscle.positions[i + 1]!
      if (end === 'top' ? y < cut : y > cut) continue
      d.push(idx.distance(muscle.positions[i]!, y, muscle.positions[i + 2]!))
    }
    return quantile(d, 0.5)
  }
  const ATTACH: [string, 'top' | 'bottom', string][] = [
    ['Long head of {s} biceps femoris', 'top', '{S} hip bone'], ['Long head of {s} biceps femoris', 'bottom', '{S} fibula'],
    ['{S} rectus femoris', 'top', '{S} hip bone'], ['{S} rectus femoris', 'bottom', '{S} patella'],
    ['Acromial part of {s} deltoid', 'top', '{S} scapula'], ['Acromial part of {s} deltoid', 'bottom', '{S} humerus'],
    ['Medial head of {s} gastrocnemius', 'top', '{S} femur'], ['{S} calcaneal tendon', 'bottom', '{S} calcaneus'],
    ['{S} sartorius', 'top', '{S} hip bone'], ['{S} sartorius', 'bottom', '{S} tibia'],
    ['{S} semimembranosus', 'top', '{S} hip bone'], ['{S} semimembranosus', 'bottom', '{S} tibia'],
    ['Long head of {s} triceps brachii', 'top', '{S} scapula'], ['{S} brachioradialis', 'bottom', '{S} radius'],
  ]
  const attachments: { muscle: string; end: string; bone: string; maleMm: number; femaleMm: number; ok: boolean }[] = []
  for (const side of ['Left', 'Right']) {
    for (const [mT, end, bT] of ATTACH) {
      const mn = mT.replace('{S}', side).replace('{s}', side.toLowerCase())
      const bn = bT.replace('{S}', side).replace('{s}', side.toLowerCase())
      const fm = meshByName.get(mn)
      const fb = meshByName.get(bn)
      const mm0 = maleMeshByName.get(mn)
      const mb = maleMeshByName.get(bn)
      if (!fm || !fb || !mm0 || !mb) continue
      const a = endDistance(mm0, mb, end)
      const b = endDistance(fm, fb, end)
      attachments.push({ muscle: mn, end, bone: bn, maleMm: round(a * 1000, 1), femaleMm: round(b * 1000, 1), ok: b <= a + 0.005 })
    }
  }
  console.log(`\nMuscle attachments (median distance of the muscle's end to the bone, male → female, mm): ${attachments.filter((a) => a.ok).length}/${attachments.length} within 5 mm of the male value`)
  for (const a of attachments) console.log(`  ${a.ok ? 'ok  ' : 'OFF '}${pad(a.muscle, 40)}${pad(a.end, 7)}${pad(a.bone, 20)}${pad(a.maleMm, 7)}→ ${a.femaleMm}`)
  report.attachments = attachments

  // sex-specific placement
  const cz = (n: string) => measure(byName(n)!.mesh).centroid
  const sexChecks: Record<string, unknown> = {}
  {
    const uterus = byName('Body of uterus') ?? parts.find((p) => /uterus/i.test(p.name) && p.provenance === 'curated')!
    const u = measure(uterus.mesh).centroid
    const bladder = cz('Urinary bladder')
    const rectum = cz('Rectum')
    sexChecks.uterusBetweenBladderAndRectum = { pass: bladder[2] > u[2] && u[2] > rectum[2], zMm: { bladder: round(bladder[2] * 1000, 1), uterus: round(u[2] * 1000, 1), rectum: round(rectum[2] * 1000, 1) }, bladderIs: byName('Urinary bladder')!.provenance, rectumIs: byName('Rectum')!.provenance }
    const hips = ['Left hip bone', 'Right hip bone'].map((n) => measure(byName(n)!.mesh).bbox)
    const sac = measure(byName('Sacrum')!.mesh).bbox
    for (const side of ['left', 'right']) {
      const o = measure(parts.find((p) => p.id === `HRA_${side}_ovary`)!.mesh).centroid
      const insideBox = o[0] > Math.min(hips[0]![0], hips[1]![0]) && o[0] < Math.max(hips[0]![3], hips[1]![3]) && o[1] > Math.min(hips[0]![1], hips[1]![1]) && o[1] < Math.max(hips[0]![4], hips[1]![4]) && o[2] > sac[2] && o[2] < Math.max(hips[0]![5], hips[1]![5])
      sexChecks[`${side}OvaryInPelvis`] = { pass: insideBox && (side === 'left' ? o[0] > 0.01 : o[0] < -0.01) && Math.abs(o[0]) < 0.09, centroidMm: o.map((v) => round(v * 1000, 1)) }
    }
    for (const [side, S] of [['L', 'left'], ['R', 'right']] as const) {
      const breast = parts.find((p) => p.id === `HRA_mammary_lobes_${side}`)!
      const pec = byName(`Sternocostal part of ${S} pectoralis major`)!
      const b = measure(breast.mesh)
      const pm = measure(pec.mesh)
      const skin = parts.find((p) => p.tissue === 'skin' && p.name === 'Skin')
      const outside = skin ? 1 - new InsideTester(skin.mesh, 96).fractionInside(samplesOf(breast.mesh, 0.004)) : NaN
      sexChecks[`${S}BreastAnteriorToPectoralis`] = { pass: b.centroid[2] > pm.centroid[2] && b.bbox[5] > pm.bbox[5], breastCentroidZMm: round(b.centroid[2] * 1000, 1), pectoralisCentroidZMm: round(pm.centroid[2] * 1000, 1), pectoralisFrontZMm: round(pm.bbox[5] * 1000, 1), fractionOutsideWarpedSkin: round(outside, 3) }
    }
    const maleOnly = parts.filter((p) => p.provenance === 'warped' && (p.system === 'reproductive' || MALE_ONLY_NAME.test(p.name)))
    sexChecks.noMaleOnlyParts = { pass: maleOnly.length === 0, found: maleOnly.map((p) => p.name) }
    const twin = (n: string) => n.replace(/\b(left|right)\b/gi, (m) => (m[0] === m[0]!.toUpperCase() ? (m.toLowerCase() === 'left' ? 'Right' : 'Left') : m === 'left' ? 'right' : 'left'))
    const names = new Set(parts.map((p) => p.name))
    const lonely = parts.filter((p) => /\b(left|right)\b/i.test(p.name) && twin(p.name) !== p.name && !names.has(twin(p.name))).map((p) => p.name)
    const maleNames = new Set(male.data.parts.map((p) => p.name))
    const newLonely = lonely.filter((n) => !maleNames.has(n) || maleNames.has(twin(n)))
    sexChecks.leftRightPresence = { pass: newLonely.length === 0, unpairedOnlyInFemale: newLonely, unpairedAlsoInMale: lonely.length - newLonely.length }
    console.log('\nSex-specific checks')
    for (const [k, v] of Object.entries(sexChecks)) console.log(`  ${(v as { pass: boolean }).pass ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(v).slice(0, 260)}`)
    report.sexChecks = sexChecks
  }

  // warped parts against her bones
  {
    const before = insideBone.filter((x) => x.before > 0)
    const worst = [...insideBone].sort((a, b) => b.after - a.after).slice(0, 10)
    const st = { warpedSoftParts: insideBone.length, touchingBoneBefore: before.length, meanInsideBefore: round(insideBone.reduce((s, x) => s + x.before, 0) / Math.max(1, insideBone.length), 4), meanInsideAfter: round(insideBone.reduce((s, x) => s + x.after, 0) / Math.max(1, insideBone.length), 4), over10pctBefore: insideBone.filter((x) => x.before > 0.1).length, over10pctAfter: insideBone.filter((x) => x.after > 0.1).length, partsWithVerticesMoved: pushedParts }
    console.log(`\nWarped soft parts against her real bones (share of surface inside bone or cartilage): mean ${(st.meanInsideBefore * 100).toFixed(2)}% → ${(st.meanInsideAfter * 100).toFixed(2)}% after the slide-out; parts above 10%: ${st.over10pctBefore} → ${st.over10pctAfter}; worst after: ${worst.map((x) => `${x.name} ${(x.after * 100).toFixed(0)}%`).join(', ')}`)
    const n = nerveStats
    console.log(`  nerves (${(n.length).toFixed(1)} m): in bone ${((n.boneBefore / n.length) * 100).toFixed(2)}% → ${((n.boneAfter / n.length) * 100).toFixed(2)}% (canals ${((n.canal / n.length) * 100).toFixed(2)}%); > 3 mm deep in her real muscles ${((n.muscleBefore / n.length) * 100).toFixed(2)}% → ${((n.muscleAfter / n.length) * 100).toFixed(2)}%; ${((n.moved / Math.max(1, n.points)) * 100).toFixed(1)}% of centreline points moved`)
    report.interpenetration = { ...st, worstAfter: worst.map((x) => ({ name: x.name, inside: round(x.after, 3) })), nerves: { lengthM: round(n.length, 2), inBoneBefore: round(n.boneBefore / n.length, 5), inBoneAfter: round(n.boneAfter / n.length, 5), inCanal: round(n.canal / n.length, 5), deepInRealMuscleBefore: round(n.muscleBefore / n.length, 5), deepInRealMuscleAfter: round(n.muscleAfter / n.length, 5), pointsMoved: round(n.moved / Math.max(1, n.points), 4) } }
  }

  // her bones are her bones: rigidly moved
  {
    let worst = 0
    let count = 0
    for (const p of parts) {
      if (p.provenance !== 'scanned' || p.tissue !== 'bone') continue
      const it = fa.byId.get(p.id)
      if (!it) continue
      const src = fa.scanned(it).positions
      const fit = fitRigid(src, p.mesh.positions)
      const back = applyRigid(fit, src)
      for (let i = 0; i < back.length; i += 3) worst = Math.max(worst, Math.hypot(back[i]! - p.mesh.positions[i]!, back[i + 1]! - p.mesh.positions[i + 1]!, back[i + 2]! - p.mesh.positions[i + 2]!))
      count++
    }
    console.log(`\nHer scanned bones: ${count} parts, largest deviation from a rigid motion of the scan ${(worst * 1e6).toFixed(1)} µm (shapes and lengths unchanged)`)
    report.scannedBones = { parts: count, maxNonRigidDeviationM: worst }
  }

  // ── 9. Notes and output ─────────────────────────────────────────────────────────────────────
  const count = (f: (p: FPart) => boolean) => parts.filter(f).length
  const maleNamesDropped = dropped.map((p) => p.name)
  notes.push(
    'This body is a construction, not a scan of one person: her real skeleton (Visible Human Female CT) carries male soft tissue (BodyParts3D, Z-Anatomy, Open3DModel) that was deformed to fit it. Only parts marked "scanned" are her own anatomy.',
    `Warped parts (${count((p) => p.provenance === 'warped')}) are anchored by bone only. Between bones their position is extrapolated: expect errors of 1–3 cm for limb muscles, vessels and nerves, more in the abdomen and pelvis.`,
    'Pose: the donor was scanned supine with flexed elbows and plantar-flexed feet. Each bone was moved rigidly into the male model\'s standing pose; joint spaces (elbow, knee, ankle, shoulder girdle) are therefore approximate, and the scapulae and clavicles keep their supine position.',
    'Right forearm and hand bones are mirrored copies of the left ones (the right ones are cut off by the CT field of view). Hands and feet: individual bones are warped male bones fitted to her segmented bone groups; her fingers were curled, the model\'s are extended.',
    'She has six lumbar vertebrae. Her first one is shown as "Supernumerary lumbar vertebra"; her second to sixth carry the names of the male first to fifth.',
    'Rib numbering comes from an automatic CT segmentation and is unreliable on the left side (ribs 5–9).',
    'Skin is the male skin deformed to her skeleton: it is not female body shape, and the breasts (Human Reference Atlas, standing shape) are separate parts that protrude through it.',
    'Uterus, ovaries, uterine tubes, vagina, pelvic ligaments and uterine vessels are artist-modelled (Human Reference Atlas) and were placed by a bone-driven fit; neighbouring bowel, vessels and nerves are deformed male anatomy pushed aside, not female pelvic anatomy.',
    'Missing: external genitalia and perineum, female urethra, ovarian and vaginal vessels, pelvic floor differences. Male-only parts were removed, including the testicular vessels.',
    'Her scanned organs (kidneys, spleen, pancreas, bladder, some trunk muscles) are in supine post-mortem position and do not always meet the warped vessels and ducts that should connect to them.',
    'Nerve tubes have schematic radii; a fifth of their length was moved out of bone or muscle bellies by an automatic clean-up.',
  )
  report.notes = notes
  report.counts = {
    parts: parts.length,
    byProvenance: Object.fromEntries(['scanned', 'warped', 'curated'].map((k) => [k, count((p) => p.provenance === k)])),
    bySource: Object.fromEntries([...new Set(parts.map((p) => p.source))].map((s) => [s, count((p) => p.source === s)])),
    bySystem: Object.fromEntries([...new Set(parts.map((p) => p.system))].sort().map((s) => [s, Object.fromEntries(['scanned', 'warped', 'curated'].map((k) => [k, count((p) => p.system === s && p.provenance === k)]))])),
    droppedMaleOnly: maleNamesDropped,
    realPartsAvailableButNotUsed: notUsed,
    realPartsNotes: realNotes,
  }
  console.log(`\nParts: ${parts.length} — ${JSON.stringify((report.counts as { byProvenance: unknown }).byProvenance)}; by source ${JSON.stringify((report.counts as { bySource: unknown }).bySource)}`)
  for (const [s, v] of Object.entries((report.counts as { bySystem: Record<string, Record<string, number>> }).bySystem)) console.log(`  ${pad(s, 16)}scanned ${pad(v.scanned!, 5)}warped ${pad(v.warped!, 6)}curated ${v.curated}`)
  console.log(`  male-only parts dropped (${dropped.length}): ${maleNamesDropped.join('; ')}`)
  console.log(`  her real parts available one-to-one but not used (${notUsed.length}): ${notUsed.map((n) => `${n.id} (${n.reason})`).join('; ')}`)
  console.log(`  HRA parts (${hra.length}): ${hra.map((p) => p.name).join('; ').slice(0, 900)}`)

  const stage = `${outDir.replace(/\/+$/, '')}.tmp-${process.pid}`
  mkdirSync(outDir, { recursive: true })
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  const systemDefs = JSON.parse(readFileSync(join(ROOT, 'data/curated/systems.json'), 'utf8')) as Omit<SystemDef, 'glb' | 'partCount'>[]
  const systems: SystemDef[] = []
  const glbSizes: Record<string, number> = {}
  for (const def of systemDefs) {
    const list: GlbPart[] = final.filter((f) => f.p.system === def.id).map((f) => ({ id: f.p.id, positions: f.mesh.positions, normals: computeNormals(f.mesh), indices: f.mesh.indices }))
    let glb: string | null = null
    if (list.length) {
      glb = `${def.id}.glb`
      glbSizes[glb] = await writeSystemGlb(join(stage, glb), def.id, def.color, list)
    }
    systems.push({ id: def.id, name: def.name, color: def.color, glb, partCount: list.length })
  }
  const usedSources = new Set(parts.map((p) => p.source))
  const data: AnatomyData = {
    schema: 1,
    body: 'female',
    sources: [...male.data.sources.filter((s) => usedSources.has(s.name)), SOURCE_VHF, SOURCE_HRA],
    systems,
    layers: LAYERS.map((l) => ({ name: l.name })),
    parts: outParts,
    trees: { isa: isaTree, partOf: partOfTree },
  }
  const json = JSON.stringify(data)
  writeFileSync(join(stage, 'anatomy.json'), json)
  const nervePaths: NervePath[] = parts.filter((p) => p.centrelines?.length).map((p) => ({ part: p.id, branches: p.centrelines!.map((b) => ({ points: Array.from(b.points, (v) => round(v)), radius: Array.from(b.radius, (v) => round(v)) })) }))
  if (nervePaths.length) writeFileSync(join(stage, 'nerves.json'), JSON.stringify(nervePaths))
  const all = outParts.reduce((b, p) => [Math.min(b[0]!, p.bbox[0]), Math.min(b[1]!, p.bbox[1]), Math.min(b[2]!, p.bbox[2]), Math.max(b[3]!, p.bbox[3]), Math.max(b[4]!, p.bbox[4]), Math.max(b[5]!, p.bbox[5])], [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
  report.output = { parts: outParts.length, triangles: trianglesOut, glbBytes: glbSizes, anatomyJsonBytes: json.length, nerves: nervePaths.length, bounds: all.map((v) => round(v, 4)) }
  writeFileSync(join(stage, 'pipeline-report.json'), JSON.stringify(report, null, 1))
  const staged = readdirSync(stage).sort((a, b) => Number(a === 'anatomy.json') - Number(b === 'anatomy.json') || a.localeCompare(b))
  for (const f of staged) renameSync(join(stage, f), join(outDir, f))
  for (const f of readdirSync(outDir)) if ((f.endsWith('.glb') || f === 'nerves.json') && !staged.includes(f)) rmSync(join(outDir, f))
  rmSync(stage, { recursive: true, force: true })
  console.log(`\nOutput: public/anatomy/female — ${outParts.length} parts, ${trianglesOut} triangles, anatomy.json ${(json.length / 1024).toFixed(0)} KB, nerves.json ${nervePaths.length} nerves`)
  let total = 0
  for (const s of systems) {
    if (!s.glb) continue
    total += glbSizes[s.glb]!
    console.log(`  ${pad(s.glb, 22)}${pad((glbSizes[s.glb]! / 1024).toFixed(0) + ' KB', 10)}${s.partCount} parts`)
  }
  console.log(`  GLB total ${(total / 1024 / 1024).toFixed(2)} MB; body bounds (m): x ${all[0]!.toFixed(3)}…${all[3]!.toFixed(3)}, y ${all[1]!.toFixed(3)}…${all[4]!.toFixed(3)}, z ${all[2]!.toFixed(3)}…${all[5]!.toFixed(3)}`)
  lap('done')
}

if (import.meta.main) await main()
