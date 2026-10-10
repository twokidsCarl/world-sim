// BodyParts3D -> runtime anatomy pipeline.
//   bun tools/pipeline/run.ts [--out <dir>] [--classify-only]
// Reads data/raw/bodyparts3d, writes public/anatomy/male/{anatomy.json,<system>.glb,pipeline-report.json}.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AnatomyData, NervePath, Part, Provenance, SourceInfo, SystemDef, SystemId, TissueId } from '../../src/anatomy/types.ts'
import { computeAdjacency } from './adjacency.ts'
import { classify, sideFromName, sideOf, type Classification } from './classify.ts'
import { RELABELLED, SIDE_OVERRIDES, SWAPPED_LABELS } from './corrections.ts'
import { computeExposure, type ExposureRole } from './exposure.ts'
import { compareNormals, computeNormals, measure, rotateToRuntime, simplifyMesh, sourceToRuntime, weld, type Mesh, type MeshStats } from './geometry.ts'
import { writeSystemGlb, type GlbPart } from './glb.ts'
import { depthOf, EXPOSURE_MAX_DISTANCE, LAYERS, SUPERFICIAL_EXPOSURE, usesExposure } from './layers.ts'
import { contentsInside, crossValidate, evaluateCandidates, HARD_TISSUES, IMPORT3_DEFAULTS, overlapWith, pairStructures, placeConcept, pushOutOfSolids, register3to4, SOLID_TISSUES, SurfaceField, type ExistingPart, type Placement } from './import3.ts'
import { canalFor, isaPathFromFma, NERVE_BUILD_DEFAULTS, registerZa, syntheticConceptId, warpNerve, type TreePath } from './importZa.ts'
import { nerveAgreement, runLandmarkChecks, type LandmarkResult } from './landmarks.ts'
import { InsideTester, surfacePoints, thinPoints } from './register.ts'
import type { Polyline } from './tube.ts'
import { displayName, hasZa, loadFmaNames, loadZa, type ZaItem } from './zanatomy.ts'
import { parseObj } from './obj.ts'
import { hasRelease3, loadRelease3, RAW3_DIR } from './release3.ts'
import { listObjFiles, loadTables, RAW_DIR } from './source.ts'
import { emitConcepts, type Ontology } from './tables.ts'

// ── Parameters ────────────────────────────────────────────────────────────────────────────────
/** Simplification error bound: this fraction of the part's thickness (3·V/A), clamped below. */
export const SIMPLIFY_ERROR_PER_THICKNESS = 0.08
export const SIMPLIFY_ERROR_MIN = 0.08e-3 // m
export const SIMPLIFY_ERROR_MAX = 0.8e-3 // m
/** Parts at or below this many triangles are never simplified. */
export const SIMPLIFY_MIN_TRIANGLES = 400
/** Never coarser than one triangle per equilateral triangle of this edge length (m). */
export const SIMPLIFY_MAX_EDGE = 0.012
export const ADJACENCY_THRESHOLD = 0.002 // m
export const ADJACENCY_SPACING = 0.002 // m
/** Parts touching more parts than this are envelopes (the skin); they get no adjacency at all. */
export const ADJACENCY_MAX_DEGREE = 200
/** Same concept + bounds equal within this (m) = a re-tessellation of the same structure. */
const NEAR_DUPLICATE_BBOX = 0.0005
/** Release 3.0 candidates vetoed by hand: file id -> reason. */
// These are the same structures as existing 4.0 parts but filed under a different concept id
// (a whole where 4.0 has the pieces, a set where 4.0 has the members, or a renamed concept), and
// they do not coincide with the 4.0 geometry closely enough for the automatic redundancy test
// because 4.0 re-modelled them.
const IMPORT3_EXCLUDE: Record<string, string> = {
  FMA7197: '4.0 has the whole liver as hepatovenous segments II–IX + caudate lobe (10 parts, 1,950 cm³), re-modelled',
  FMA7409: '4.0 has its own bronchial tree (101 parts), re-modelled',
  FMA66326: '4.0 has its own pulmonary arterial tree (99 parts), re-modelled',
  FMA66643: '4.0 has its own pulmonary venous tree (84 parts), re-modelled',
  FMA7208: '4.0 has the ileum as 31 zone parts',
  FMA7207: '4.0 has the jejunum as 23 zone parts',
  FMA7198nsn: 'remainder of the pancreas; 4.0 has "Pancreas" and "Parenchyma of pancreas"',
  FMA14543nsn: 'remainder of the colon; 4.0 has ascending, transverse and descending colon (and it lands inside them)',
  FMA76893: '= 4.0 "Taenia libera"',
  FMA76891: '= 4.0 "Taenia mesocolica"',
  FMA76892: '= 4.0 "Taenia omentalis"',
  FMA7266: '4.0 models the left ventricular papillary muscles differently ("Lateral papillary muscle of left ventricle" and its heads)',
  FMA76994: '4.0 has the branches of the right coronary artery in more detail',
  FMA76751: '= the ten 4.0 parts named "Posterior vein of left ventricle"',
  FMA70751: '= 4.0 "Hair of head"',
  FMA70754: '= 4.0 "Pubic hair"',
  FMA52780: '= 4.0 "External ear"',
  FMA12513: '4.0 has the eyeball as its layers and contents (sclera, cornea, choroid, lens, …)',
  BP24: '4.0 has the costal cartilages individually',
  BP28: '4.0 has the costal cartilages individually',
  FMA59815nsn: '= 4.0 "Lip"',
  FMA76775: '= the two 4.0 parts named "Medial lumbar intertransversarius"',
}

const ROOT = join(import.meta.dirname, '../..')
/** Id prefix of parts imported from release 3.0 (whose files are named by concept, not FJ id). */
export const R3_PREFIX = 'R3_'
// Release 3.0 predates the 2025 relicensing notice of the 4.0 archive; its own README and every
// OBJ header still state CC BY-SA 2.1 JP, so that is what is recorded for the imported parts.
const SOURCE3: SourceInfo = {
  name: 'BodyParts3D 3.0',
  url: 'https://dbarchive.biosciencedbc.jp/data/bodyparts3d/20110915/',
  license: 'CC BY-SA 2.1 JP',
  attribution: 'BodyParts3D, Copyright© The Database Center for Life Science licensed by CC Attribution-Share Alike 2.1 Japan',
}
const ZA_NOTE = ' Artist-modelled atlas geometry, non-rigidly registered to the BodyParts3D 4.0 body by this project (nerve tubes rebuilt from the registered centrelines); positions are approximate.'
const SOURCE_ZA: SourceInfo = {
  name: 'Z-Anatomy',
  url: 'https://github.com/Z-Anatomy/Models-of-human-anatomy',
  license: 'CC BY-SA 4.0',
  attribution: 'Z-Anatomy - The libre 3D atlas of anatomy - CC-BY-SA 4.0 (based on BodyParts3D - The Database Center for Life Science - CC-BY-SA 2.1 Japan).' + ZA_NOTE,
}
const SOURCE_O3D: SourceInfo = {
  name: 'Open3DModel',
  url: 'https://anatomytool.org/open3dmodel',
  license: 'CC BY-SA 4.0',
  attribution: 'Open3DModel, Open 3D Model project (LUMC, UMC Utrecht, Maastricht UMC+, KU Leuven KULAK), anatomytool.org - CC BY-SA 4.0; based on Z-Anatomy and BodyParts3D.' + ZA_NOTE,
}
/** A nerve is not shipped when, after clean-up, more than this share of its length is in bone it has no business in … */
const NERVE_MAX_IN_BONE = 0.15
/** … or deep inside muscle bellies. */
const NERVE_MAX_DEEP_IN_MUSCLE = 0.4
/** A Z-Anatomy mesh is not shipped with more than this share of its surface inside existing solids. */
const ZA_MAX_INSIDE = 0.6
/** IS-A concept (by name) for Z-Anatomy items whose FMA chain does not meet the 4.0 tree or that have no FMA id. */
const ZA_FALLBACK_ISA: Record<string, string> = {
  nerve: 'segment of neural tree organ',
  ligament: 'ligament organ',
  fascia: 'organ component',
  gland: 'organ',
  organ: 'organ component',
}
const SOURCE: SourceInfo = {
  name: 'BodyParts3D 4.0',
  url: 'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/',
  license: 'CC BY 4.0',
  attribution: 'BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International',
}

interface Element {
  id: string
  name: string
  fma: string
  volume?: number
  /** welded source mesh, runtime frame */
  mesh: Mesh
  stats: MeshStats
  sourceTriangles: number
  cls: Classification
  isa: string[]
  partOf: string[]
  provenance: Provenance
  /** set for parts imported from release 3.0 */
  placement?: Placement
  /** `SourceInfo.name` when the geometry is not from the first source */
  source?: string
  /** tree positions of parts imported from the Z-Anatomy package */
  tree?: { isa: TreePath; partOf: TreePath | null }
  /** final centrelines of nerve parts (written to nerves.json) */
  centrelines?: Polyline[]
  /** geometry was built to measure (nerve tubes): do not run the simplifier over it */
  keepGeometry?: boolean
}

const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s)
const round = (v: number, digits = 5) => Number(v.toFixed(digits))
const quantile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] ?? 0
const pad = (s: string | number, n: number) => String(s).padEnd(n)

async function main() {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('--out')
  const outDir = outIdx >= 0 ? args[outIdx + 1]! : join(ROOT, 'public/anatomy/male')
  const classifyOnly = args.includes('--classify-only')
  const t0 = performance.now()
  const lap = (label: string) => console.log(`  [${((performance.now() - t0) / 1000).toFixed(1)}s] ${label}`)
  const report: Record<string, unknown> = {}

  // ── 1. Tables and files ─────────────────────────────────────────────────────────────────────
  const tables = loadTables()
  const files = listObjFiles()
  const tableElements = new Set<string>([...tables.isa.conceptsOf.keys(), ...tables.partOf.conceptsOf.keys()])
  const missingObj = [...tableElements].filter((id) => !files.has(id)).sort()
  const orphanObj = [...files.keys()].filter((id) => !tableElements.has(id))
  console.log(`BodyParts3D: ${tableElements.size} elements in the tables, ${files.size} OBJ files in ${RAW_DIR}`)
  if (missingObj.length) console.log(`  WARNING ${missingObj.length} elements have no OBJ (not extracted yet?): ${missingObj.slice(0, 8).join(', ')}…`)
  if (orphanObj.length) console.log(`  WARNING ${orphanObj.length} OBJ files are in no table and are skipped: ${orphanObj.slice(0, 8).join(', ')}…`)
  report.elementsInTables = tableElements.size
  report.objFiles = files.size
  report.missingObj = missingObj
  report.orphanObj = orphanObj

  // Source label corrections: `tableId(el)` is the element whose table rows / header describe `el`.
  const swap = new Map<string, string>()
  for (const [a, b] of SWAPPED_LABELS) {
    if (files.has(a) && files.has(b)) {
      swap.set(a, b)
      swap.set(b, a)
    }
  }
  const headers = new Map<string, ReturnType<typeof parseObj>['header']>()

  // ── 2. Load, weld, measure, classify ────────────────────────────────────────────────────────
  const elements: Element[] = []
  const blankHeaders: string[] = []
  const notInIsa: string[] = []
  let sourceTriangles = 0
  let sourceVertices = 0
  let weldedVertices = 0
  let weldDroppedTriangles = 0
  const normalDots: number[] = []
  const hashes = new Map<string, string>()
  for (const [id, path] of files) {
    if (!tableElements.has(id)) continue
    const obj = parseObj(readFileSync(path))
    if (obj.indices.length === 0) {
      console.log(`  WARNING ${id} has no faces, skipped`)
      continue
    }
    const runtime = sourceToRuntime(obj.positions)
    const w = weld(runtime, obj.indices)
    sourceTriangles += obj.indices.length / 3
    sourceVertices += obj.positions.length / 3
    weldedVertices += w.positions.length / 3
    weldDroppedTriangles += w.removedTriangles
    if (obj.normals) {
      const computed = computeNormals({ positions: runtime, indices: obj.indices })
      normalDots.push(compareNormals(rotateToRuntime(obj.normals), computed).meanDot)
    }
    headers.set(id, obj.header)
    const labelId = swap.get(id) ?? id
    const isaIds = tables.isa.conceptsOf.get(labelId) ?? []
    const poIds = tables.partOf.conceptsOf.get(labelId) ?? []
    if (isaIds.length === 0) notInIsa.push(id)
    const isa = isaIds.map((c) => tables.isa.name.get(c) ?? c)
    const partOf = poIds.map((c) => tables.partOf.name.get(c) ?? c)
    // 17 files have an empty header (no name / concept): fall back to the most specific concept.
    const ownConcept = isaIds[0] ?? poIds[0] ?? ''
    if (!obj.header.name || !obj.header.conceptId) blankHeaders.push(id)
    const name = obj.header.name || capitalise(isa[0] ?? partOf[0] ?? id)
    const fma = obj.header.conceptId || ownConcept
    const mesh: Mesh = { positions: w.positions, indices: w.indices }
    hashes.set(id, createHash('md5').update(new Uint8Array(obj.positions.buffer, obj.positions.byteOffset, obj.positions.byteLength)).update(new Uint8Array(obj.indices.buffer, obj.indices.byteOffset, obj.indices.byteLength)).digest('hex'))
    elements.push({
      id, name, fma, volume: obj.header.volume, mesh, stats: measure(mesh),
      sourceTriangles: obj.indices.length / 3,
      cls: classify({ name, isa, partOf }), isa, partOf, provenance: 'scanned',
    })
  }
  lap(`parsed ${elements.length} OBJ files: ${sourceTriangles} triangles, ${sourceVertices} vertices (${weldedVertices} after weld, ${weldDroppedTriangles} degenerate/duplicate triangles dropped)`)
  // swapped pairs exchange name and concept id (both headers are known only now)
  for (const e of elements) {
    const other = swap.get(e.id)
    const h = other ? headers.get(other) : undefined
    if (!h) continue
    if (h.name) e.name = h.name
    if (h.conceptId) e.fma = h.conceptId
  }
  const relabelledFrom = new Map<string, string>()
  for (const e of elements) {
    const fix = RELABELLED[e.id]
    if (!fix) continue
    relabelledFrom.set(e.id, e.fma)
    e.name = fix.name
    e.fma = fix.fma
    e.cls = classify({ name: e.name, isa: e.isa, partOf: e.partOf })
  }
  if (swap.size) console.log(`  source label corrections: swapped ${SWAPPED_LABELS.map(([a, b]) => `${a}↔${b}`).join(', ')}; side forced for ${Object.entries(SIDE_OVERRIDES).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  report.corrections = { swappedLabels: SWAPPED_LABELS, relabelled: RELABELLED, sideOverrides: SIDE_OVERRIDES }
  normalDots.sort((a, b) => a - b)
  console.log(`  source normals vs recomputed: mean dot min ${normalDots[0]?.toFixed(3)}, median ${quantile(normalDots, 0.5).toFixed(3)} (source normals are sound; normals are recomputed after simplification anyway)`)
  report.source = { triangles: sourceTriangles, vertices: sourceVertices, weldedVertices, weldDroppedTriangles, normalAgreementMin: normalDots[0], blankHeaders, notInIsa }

  // ── 3. Duplicates ───────────────────────────────────────────────────────────────────────────
  // alias: dropped element id -> kept element id
  const alias = new Map<string, string>()
  const merged: { kept: string; dropped: string; name: string; kind: 'exact' | 'near' }[] = []
  {
    const byHash = new Map<string, Element>()
    const byFma = new Map<string, Element[]>()
    for (const e of elements) {
      const h = hashes.get(e.id)!
      const first = byHash.get(h)
      if (first) {
        alias.set(e.id, first.id)
        merged.push({ kept: first.id, dropped: e.id, name: e.name, kind: 'exact' })
        continue
      }
      byHash.set(h, e)
      let list = byFma.get(e.fma)
      if (!list) byFma.set(e.fma, (list = []))
      list.push(e)
    }
    for (const list of byFma.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]!
          const b = list[j]!
          if (alias.has(a.id) || alias.has(b.id)) continue
          if (!a.stats.bbox.every((v, k) => Math.abs(v - b.stats.bbox[k]!) <= NEAR_DUPLICATE_BBOX)) continue
          const [keep, drop] = b.sourceTriangles > a.sourceTriangles ? [b, a] : [a, b]
          alias.set(drop.id, keep.id)
          merged.push({ kept: keep.id, dropped: drop.id, name: drop.name, kind: 'near' })
        }
      }
    }
  }
  const kept: Element[] = elements.filter((e) => !alias.has(e.id))
  if (merged.length) {
    console.log(`  duplicates merged (${merged.length}): ` + merged.map((m) => `${m.dropped}→${m.kept} "${m.name}" (${m.kind})`).join('; '))
  }
  report.duplicatesMerged = merged

  // table element id -> id of the kept part that now stands for it (label swaps, merged duplicates)
  const resolve = (el: string) => {
    const sw = swap.get(el) ?? el
    return alias.get(sw) ?? sw
  }

  // ── 3b. Release 3.0 import ──────────────────────────────────────────────────────────────────
  const imported: Element[] = []
  if (!hasRelease3()) {
    console.log(`\n  WARNING release 3.0 not found in ${RAW3_DIR}: lungs, liver, abdominal wall etc. will be missing`)
    report.release3 = { available: false }
  } else {
    const r3 = loadRelease3()
    lap(`release 3.0: ${r3.parts.size} OBJ files, ${[...r3.parts.values()].reduce((n, p) => n + p.sourceTriangles, 0)} triangles`)
    const existing: ExistingPart[] = kept.map((e) => ({ id: e.id, fma: e.fma, name: e.name, mesh: e.mesh, stats: e.stats, system: e.cls.system, tissue: e.cls.tissue }))
    const keptIds = new Set(kept.map((e) => e.id))
    const conceptElements = (c: string) => {
      const out = new Set<string>()
      for (const onto of [tables.isa, tables.partOf]) for (const el of onto.elements.get(c) ?? []) if (keptIds.has(resolve(el))) out.add(resolve(el))
      return [...out]
    }
    const pairs = pairStructures(r3, existing, conceptElements)
    const reg = register3to4(r3, existing, pairs, IMPORT3_DEFAULTS)
    lap(`registration 3.0 → 4.0: ${reg.fits.length} paired structures, ${reg.anchorStructures} accepted as anchors (${reg.anchorPoints} points)`)
    const cv = crossValidate(r3, reg, IMPORT3_DEFAULTS)
    lap('cross-validation')
    const field = new SurfaceField(existing)
    const placements = new Map<string, Placement>()
    const classOf = new Map<string, Classification>()
    for (const part of r3.parts.values()) {
      const pl = placeConcept(r3, part.id, tables.isa, tables.partOf)
      placements.set(part.id, pl)
      classOf.set(part.id, classify({ name: capitalise(part.name), isa: pl.isa, partOf: pl.partOf }))
    }
    const candidates = evaluateCandidates(r3, pairs, reg, field, (p) => classOf.get(p.id)!.system, (p) => IMPORT3_EXCLUDE[p.id] ?? null, IMPORT3_DEFAULTS)
    lap(`evaluated ${candidates.length} release 3.0 candidates`)
    // left/right twins share a verdict: a structure is not shipped on one side only
    {
      const twinName = (n: string) => n.replace(/\b(left|right)\b/g, (m) => (m === 'left' ? 'right' : 'left'))
      const byName = new Map(candidates.map((c) => [c.part.name, c]))
      for (const c of candidates) {
        if (c.report.decision !== 'misplaced') continue
        const twin = byName.get(twinName(c.part.name))
        if (twin && twin !== c && twin.report.decision === 'import') {
          twin.report.decision = 'misplaced'
          twin.report.reason = `its twin "${c.part.name}" is misplaced (${(c.report.inside * 100).toFixed(0)}% inside existing solids); this side: ${(twin.report.inside * 100).toFixed(0)}%`
        }
      }
    }

    // frame difference, by region of the 3.0 body
    const region = (c: readonly number[]): string => {
      const [x, y] = c as [number, number]
      if (y > 1.42) return 'head'
      if (Math.abs(x) > 0.17 || (y > 1.1 && Math.abs(x) > 0.15)) return 'upper limb'
      if (y > 1.33) return 'neck'
      if (y > 1.08) return 'thorax'
      if (y > 0.92) return 'abdomen'
      if (y > 0.78) return 'pelvis'
      if (y > 0.45) return 'thigh'
      if (y > 0.1) return 'leg'
      return 'foot'
    }
    const REGIONS = ['head', 'neck', 'thorax', 'abdomen', 'pelvis', 'upper limb', 'thigh', 'leg', 'foot']
    const direct = reg.fits.filter((f) => f.kind === 'direct')
    const mm = (v: number) => (v * 1000).toFixed(1)
    const qs = (v: number[]) => `${mm(quantile([...v].sort((a, b) => a - b), 0.5))} / ${mm(quantile([...v].sort((a, b) => a - b), 0.9))} / ${mm(Math.max(...v))}`
    console.log(`\nRelease 3.0 vs 4.0 frame (same concept in both: ${direct.length} structures; median / p90 / max in mm)`)
    console.log(`  ${pad('region', 12)}${pad('n', 5)}${pad('centroid offset', 22)}${pad('mean dY', 9)}${pad('surface dist, unaligned', 26)}${pad('after rigid fit (p95)', 24)}${pad('anchors', 9)}cross-validation error`)
    const frameRows: Record<string, unknown>[] = []
    for (const r of [...REGIONS, 'all']) {
      const f = direct.filter((x) => r === 'all' || region(x.centroid) === r)
      if (!f.length) continue
      const off = f.map((x) => Math.hypot(...x.centroidOffset))
      const dy = f.reduce((a, x) => a + x.centroidOffset[1], 0) / f.length
      const raw = f.map((x) => x.rawForward.median)
      const fit = f.map((x) => Math.max(x.forward.p95, x.backward.p95))
      const cvr = cv.filter((x) => r === 'all' || region(x.centroid) === r).map((x) => x.error)
      console.log(`  ${pad(r, 12)}${pad(f.length, 5)}${pad(qs(off), 22)}${pad(mm(dy), 9)}${pad(qs(raw), 26)}${pad(qs(fit), 24)}${pad(f.filter((x) => x.accepted).length, 9)}${cvr.length ? qs(cvr) : '-'}`)
      frameRows.push({ region: r, n: f.length, centroidOffsetMm: qs(off), meanDyMm: mm(dy), unalignedSurfaceMm: qs(raw), rigidFitP95Mm: qs(fit), anchors: f.filter((x) => x.accepted).length, crossValidationMm: cvr.length ? qs(cvr) : null })
    }
    console.log(`  deformation: Gaussian kernel regression over ${reg.anchorPoints} anchor points from ${reg.anchorStructures} structures (k=${IMPORT3_DEFAULTS.k}, σ ≥ ${IMPORT3_DEFAULTS.minSigma * 1000} mm); residual at its own anchors per structure: median ${mm(reg.fitResidual.median)}, p90 ${mm(reg.fitResidual.p90)}, max ${mm(reg.fitResidual.max)} mm`)
    const worstCv = [...cv].sort((a, b) => b.error - a.error).slice(0, 10)
    console.log(`  worst cross-validation: ${worstCv.map((x) => `${x.name} ${mm(x.error)}`).join(', ')}`)
    const rejected = reg.fits.filter((f) => !f.accepted)
    console.log(`  not usable as anchors (${rejected.length}; rigid fit p95 > ${IMPORT3_DEFAULTS.anchorMaxP95 * 1000} mm — re-modelled or re-posed between releases): ${rejected.sort((a, b) => b.forward.p95 - a.forward.p95).slice(0, 25).map((f) => `${f.name} ${mm(Math.max(f.forward.p95, f.kind === 'direct' ? f.backward.p95 : 0))}`).join(', ')}…`)

    console.log(`\nRelease 3.0 candidates (no same-concept element in 4.0): ${candidates.length}`)
    console.log(`  columns: mean displacement by the deformation (mm); share of the warped surface lying on 4.0 parts of the same system (≥ ${IMPORT3_DEFAULTS.redundantFraction * 100}% = redundant); share inside 4.0 solids at any depth after the bone clean-up (> ${IMPORT3_DEFAULTS.maxInside * 100}% = misplaced); share more than ${IMPORT3_DEFAULTS.deepDistance * 1000} mm deep (> ${IMPORT3_DEFAULTS.maxDeepInside * 100}% = misplaced); share of vertices the clean-up slid out of bone/tooth/cartilage; then the 4.0 solids it still reaches into`)
    for (const d of ['import', 'redundant', 'misplaced', 'excluded'] as const) {
      const list = candidates.filter((c) => c.report.decision === d).sort((a, b) => a.part.name.localeCompare(b.part.name))
      console.log(`  ${d} (${list.length})`)
      for (const c of list) {
        const cl = classOf.get(c.part.id)!
        const pct = (v: number) => pad((v * 100).toFixed(0) + '%', 5)
        const tail = d === 'excluded' || d === 'misplaced' ? c.report.reason : d === 'import' ? c.report.insideTop.slice(0, 3).map(([n, f, dp]) => `${n} ${(f * 100).toFixed(0)}%${dp >= 0.005 ? ` (deep ${(dp * 100).toFixed(0)}%)` : ''}`).join('; ') : c.report.top.slice(0, 2).map(([n, f]) => `${n} ${(f * 100).toFixed(0)}%`).join('; ')
        console.log(`    ${pad(c.part.id, 12)}${pad(c.part.name.slice(0, 46), 47)}${pad(`${cl.system}/${cl.tissue}`, 22)}moved ${pad(mm(c.report.displacement), 6)}same-system ${pct(c.report.onSameSystem)}inside ${pct(c.report.inside)}deep ${pct(c.report.deepInside)}pushed ${pct(c.report.pushedOut.moved)}${tail}`)
      }
    }
    // containment: 4.0 elements filed under the candidate's own concept should lie inside it
    const byIdExisting = new Map(existing.map((e) => [e.id, e]))
    const containment: Record<string, unknown>[] = []
    console.log('\nContainment of 4.0 content in release 3.0 organs (4.0 elements under the same concept; fraction of their surface inside the warped 3.0 surface)')
    for (const c of candidates) {
      const pair = pairs.get(c.part.id)
      if (!pair || pair.kind !== 'aggregate') continue
      const res = contentsInside(c.mesh, pair.elements.map((id) => byIdExisting.get(id)!))
      const raw = contentsInside(c.part.mesh, pair.elements.map((id) => byIdExisting.get(id)!))
      console.log(`  ${pad(c.part.name, 28)}${pad(c.report.decision, 11)}${pad(pair.elements.length + ' elements', 14)}inside ${pad((res.fraction * 100).toFixed(1) + '%', 8)}(unregistered: ${(raw.fraction * 100).toFixed(1)}%)  least inside: ${res.worst.slice(0, 3).map(([n, f]) => `${n} ${(f * 100).toFixed(0)}%`).join('; ')}`)
      containment.push({ id: c.part.id, name: c.part.name, decision: c.report.decision, elements: pair.elements.length, inside: round(res.fraction, 4), insideUnregistered: round(raw.fraction, 4), leastInside: res.worst })
    }
    // whole-lung view: lobe boundaries moved, so a 4.0 segment may sit in the neighbouring lobe
    const lungs: Record<string, unknown>[] = []
    for (const side of ['right', 'left']) {
      const concept = [...tables.partOf.name].find(([, n]) => n === `${side} lung`)?.[0]
      const lobes = candidates.filter((c) => c.report.decision === 'import' && (side === 'right' ? /lobe of right lung|middle lobe of lung/ : /lobe of left lung/).test(c.part.name))
      if (!concept || !lobes.length) continue
      const content = conceptElements(concept).map((id) => byIdExisting.get(id)!)
      const res = contentsInside(lobes.map((c) => c.mesh), content)
      const airways = contentsInside(lobes.map((c) => c.mesh), content.filter((e) => e.system === 'respiratory'))
      console.log(`  ${pad(`${side} lung (all lobes)`, 28)}${pad('', 11)}${pad(content.length + ' elements', 14)}inside ${pad((res.fraction * 100).toFixed(1) + '%', 8)}(bronchial tree alone ${(airways.fraction * 100).toFixed(1)}%)  least inside: ${res.worst.slice(0, 4).map(([n, f]) => `${n} ${(f * 100).toFixed(0)}%`).join('; ')}`)
      lungs.push({ side, elements: content.length, inside: round(res.fraction, 4), bronchialTreeInside: round(airways.fraction, 4), leastInside: res.worst })
    }
    report.containment = containment
    report.lungContainment = lungs
    for (const c of candidates) {
      if (c.report.decision !== 'import') continue
      const pl = placements.get(c.part.id)!
      imported.push({
        id: R3_PREFIX + c.part.id, name: capitalise(c.part.name), fma: pl.fma, mesh: c.mesh, stats: c.stats, sourceTriangles: c.part.sourceTriangles,
        cls: classOf.get(c.part.id)!, isa: pl.isa, partOf: pl.partOf, provenance: 'warped', placement: pl, source: SOURCE3.name,
      })
    }
    const viaAncestor = imported.filter((e) => e.placement!.isaViaAncestor && !e.placement!.isaByHand)
    const byHand = imported.filter((e) => e.placement!.isaByHand)
    const poVia = imported.filter((e) => e.placement!.partOfViaAncestor)
    console.log(`\nTree placement of the ${imported.length} imported parts`)
    console.log(`  isa: ${imported.length - viaAncestor.length - byHand.length} under their own concept, ${byHand.length} placed by hand (ISA_PLACEMENT_RULES), ${viaAncestor.length} under the nearest release 3.0 ancestor known to the 4.0 tree${viaAncestor.length ? ': ' + viaAncestor.map((e) => `${e.name} → ${e.placement!.isaConcept ? tables.isa.name.get(e.placement!.isaConcept) : 'ROOT'}`).join('; ') : ''}`)
    const group = (list: Element[], f: (e: Element) => string) => {
      const m = new Map<string, number>()
      for (const e of list) m.set(f(e), (m.get(f(e)) ?? 0) + 1)
      return [...m].map(([k, v]) => `${k} ×${v}`).join(', ')
    }
    console.log(`    by hand: ${group(byHand, (e) => tables.isa.name.get(e.placement!.isaConcept!)!)}`)
    console.log(`  partOf: ${imported.length - poVia.length} under their own concept, ${poVia.length} under the nearest release 3.0 ancestor: ${group(poVia, (e) => (e.placement!.partOfConcept ? tables.partOf.name.get(e.placement!.partOfConcept)! : 'not attached'))}`)
    report.release3 = {
      available: true,
      placement: imported.map((e) => ({ id: e.id, name: e.name, isa: e.placement!.isaConcept ? tables.isa.name.get(e.placement!.isaConcept) : null, isaHow: e.placement!.isaByHand ? 'by hand' : e.placement!.isaViaAncestor ? '3.0 ancestor' : 'own concept', partOf: e.placement!.partOfConcept ? tables.partOf.name.get(e.placement!.partOfConcept) : null, partOfHow: e.placement!.partOfViaAncestor ? '3.0 ancestor' : 'own concept' })), files: r3.parts.size, paired: reg.fits.length, anchors: reg.anchorStructures, anchorPoints: reg.anchorPoints,
      frame: frameRows, fitResidualM: reg.fitResidual,
      crossValidation: cv.map((x) => ({ id: x.id, name: x.name, errorM: round(x.error) })),
      fits: reg.fits.map((f) => ({ id: f.id, name: f.name, kind: f.kind, accepted: f.accepted, centroidOffset: f.centroidOffset.map((v) => round(v)), unalignedMedian: round(f.rawForward.median), fitP95: round(Math.max(f.forward.p95, f.kind === 'direct' ? f.backward.p95 : 0)) })),
      candidates: candidates.map((c) => ({ ...c.report, class: `${classOf.get(c.part.id)!.system}/${classOf.get(c.part.id)!.tissue}`, rule: classOf.get(c.part.id)!.rule })),
    }
    kept.push(...imported)
  }

  // ── 3c. Z-Anatomy / Open3DModel import (nerves, lymph nodes, thyroid, ligaments, fasciae) ────
  const importedZa: Element[] = []
  let landmarks: LandmarkResult[] = []
  if (!hasZa()) {
    console.log('\n  WARNING Z-Anatomy import package not found (data/raw/z-anatomy/out/import): no peripheral nerves, lymph nodes, thyroid or joint ligaments')
    report.zAnatomy = { available: false }
  } else {
    const pkg = loadZa()
    const fmaNames = loadFmaNames()
    const existing: ExistingPart[] = kept.map((e) => ({ id: e.id, fma: e.fma, name: e.name, mesh: e.mesh, stats: e.stats, system: e.cls.system, tissue: e.cls.tissue }))
    const field = new SurfaceField(existing)
    const reg = registerZa(pkg, field)
    const regStats = reg.stats()
    const cv = reg.crossValidate()
    lap(`Z-Anatomy package: ${pkg.items.filter((i) => !i.candidate).length} items, ${pkg.anchors.length} anchors (${reg.anchorsUsed} used); registered`)
    const mm = (v: number) => (v * 1000).toFixed(1)
    const q = (v: number[], p: number) => quantile([...v].sort((a, b) => a - b), p)
    console.log('\nZ-Anatomy / Open3DModel registration (one deformation per source frame and body side; mm)')
    console.log(`  ${pad('frame:side', 12)}${pad('anchors', 9)}${pad('own bone', 10)}${pad('own soft', 10)}${pad('from za', 9)}${pad('points', 9)}${pad('residual at anchors med/p90/max', 34)}leave-out error: bone med/p90/max | soft med/p90/max`)
    const regRows: Record<string, unknown>[] = []
    for (const [key, st] of Object.entries(regStats)) {
      const [frame, side] = key.split(':') as [string, string]
      const of = (cls: string) => cv.filter((x) => x.frame === frame && x.side === side && x.anchorClass === cls).map((x) => x.error)
      const fmt = (v: number[]) => (v.length ? `${mm(q(v, 0.5))} / ${mm(q(v, 0.9))} / ${mm(Math.max(...v))} (n=${v.length})` : '-')
      console.log(`  ${pad(key, 12)}${pad(st.structures, 9)}${pad(st.bone, 10)}${pad(st.soft, 10)}${pad(st.crossFrame, 9)}${pad(st.points, 9)}${pad(`${mm(st.residualMedian)} / ${mm(st.residualP90)} / ${mm(st.residualMax)}`, 34)}${fmt(of('bone'))} | ${fmt(of('soft'))}`)
      regRows.push({ key, ...st, residualMedian: round(st.residualMedian), residualP90: round(st.residualP90), residualMax: round(st.residualMax), leaveOutBoneMm: fmt(of('bone')), leaveOutSoftMm: fmt(of('soft')) })
    }
    const worst = [...cv].sort((a, b) => b.error - a.error).slice(0, 8)
    console.log(`  worst leave-out: ${worst.map((x) => `${x.frame}:${x.side} ${x.name} ${mm(x.error)}`).join(', ')}`)
    if (reg.anchorsSkipped.length) console.log(`  anchors skipped: ${reg.anchorsSkipped.map((a) => `${a.name} ${a.side} (${a.reason})`).join('; ')}`)

    const sourceName = (it: ZaItem) => (it.source === 'open3dmodel' ? SOURCE_O3D.name : SOURCE_ZA.name)
    const fmaTaken = new Map<string, Element[]>()
    for (const e of kept) fmaTaken.set(e.fma, [...(fmaTaken.get(e.fma) ?? []), e])
    const nameTaken = new Map(kept.map((e) => [e.name.toLowerCase(), e]))
    const isaIdByName = new Map<string, string>()
    for (const [id, n] of tables.isa.name) if (!isaIdByName.has(n)) isaIdByName.set(n, id)
    const dropped: { id: string; name: string; kind: string; reason: string }[] = []
    // FMA ids used by imported items of both sides
    const sharedAcrossSides = new Set<string>()
    {
      const sides = new Map<string, Set<string>>()
      for (const it of pkg.items) {
        if (it.candidate || !it.fma || it.side === 'M') continue
        if (it.kind === 'nerve' && !it.preferred) continue
        sides.set(it.fma, (sides.get(it.fma) ?? new Set()).add(it.side))
      }
      for (const [k, v] of sides) if (v.size > 1) sharedAcrossSides.add(k)
    }
    let mintedSided = 0
    const treeOf = (it: ZaItem, tissue: TissueId): { fma: string; tree: Element['tree'] } => {
      const fallbackName = ZA_FALLBACK_ISA[tissue] ?? 'organ component'
      const fallback = isaIdByName.get(fallbackName) ?? null
      const inIsa = (id: string) => tables.isa.name.has(id)
      let fma: string
      let isa: TreePath
      if (it.fma) {
        fma = it.fma
        isa = isaPathFromFma(fma, fmaNames?.label.get(fma) ?? it.fmaLabel ?? displayName(it.name, it.side), (id) => fmaNames?.parents.get(id), (id) => fmaNames?.label.get(id), inIsa, fallback)
        // A lateralised item filed under an unsided class (FMA has no left/right class for it,
        // or both sides were mapped to one id): each side gets its own concept, `<id>_L` /
        // `<id>_R`, as a child of the unsided one, so that names can be keyed per side.
        if (it.side !== 'M' && (it.fmaIsUnsided || sharedAcrossSides.has(fma))) {
          const sided = `${fma}_${it.side}`
          const own = displayName(it.name, it.side)
          isa = { ...isa, path: [[sided, own.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())], ...(isa.path.length ? isa.path : [])], anchor: isa.path.length ? isa.anchor : fma, how: isa.how === 'own concept' ? 'FMA is-a chain' : isa.how }
          fma = sided
          mintedSided++
        }
      } else {
        // no FMA class: a synthetic concept, sided under an unsided one
        fma = syntheticConceptId(it.name, it.side)
        const path: [string, string][] = [[fma, displayName(it.name, it.side).replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())]]
        if (it.side !== 'M') path.push([syntheticConceptId(it.name, 'M'), displayName(it.name, 'M').replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())])
        isa = { path, anchor: fallback, how: 'by hand' }
      }
      const partOf: TreePath | null = tables.partOf.name.has(fma) ? { path: [], anchor: fma, how: 'own concept' } : null
      return { fma, tree: { isa, partOf } }
    }
    const classOf = (it: ZaItem): { system: SystemId; tissue: TissueId } => {
      if (it.kind === 'nerve') return { system: 'nervous', tissue: 'nerve' }
      // the package files the meniscotibial / meniscopatellar ligaments as cartilage
      if (it.category === 'ligament-bursa-fascia' && it.tissue === 'cartilage') return { system: 'skeletal', tissue: 'ligament' }
      return { system: it.system as SystemId, tissue: it.tissue as TissueId }
    }
    const makeElement = (it: ZaItem, mesh: Mesh, extra: Partial<Element> = {}): Element => {
      const cls = classOf(it)
      const { fma, tree } = treeOf(it, cls.tissue)
      return {
        id: it.id, name: displayName(it.name, it.side), fma, mesh, stats: measure(mesh), sourceTriangles: it.triangles,
        cls: { ...cls, rule: 'Z-Anatomy package', signal: 'isa' }, isa: [], partOf: [], provenance: 'curated', source: sourceName(it), tree, ...extra,
      }
    }

    // nerves
    const nerveItems = pkg.items.filter((i) => i.kind === 'nerve' && !i.candidate && i.preferred)
    const nerveRows: Record<string, unknown>[] = []
    const agreement: Record<string, unknown>[] = []
    let lenAll = 0
    let boneBefore = 0
    let boneAfter = 0
    let muscleBefore = 0
    let muscleAfter = 0
    let canalAll = 0
    let ptsAll = 0
    let ptsMoved = 0
    let ptsBone = 0
    let pushSum = 0
    for (const it of nerveItems) {
      const name = displayName(it.name, it.side)
      const def = reg.deformation(it.frame, it.side)
      const lines = pkg.centreline(it)
      const warpedLines = lines && lines.length ? warpNerve(lines, def, field, { ...NERVE_BUILD_DEFAULTS, canal: canalFor(it.name) }) : null
      // BodyParts3D already has this nerve: keep its part, drop the import, but measure agreement
      const same = (it.fma ? fmaTaken.get(it.fma) : undefined) ?? (nameTaken.has(name.toLowerCase()) ? [nameTaken.get(name.toLowerCase())!] : undefined)
      if (same && same.length) {
        if (warpedLines) {
          for (const e of same) {
            const a = nerveAgreement(e.mesh, warpedLines.branches)
            agreement.push({ imported: name, source: sourceName(it), existing: `${e.id} ${e.name}`, medianMm: round(a.median * 1000, 2), maxMm: round(a.max * 1000, 2), within5mm: round(a.overlap, 3) })
          }
        }
        dropped.push({ id: it.id, name, kind: 'nerve', reason: `BodyParts3D 4.0 already has it (${same.map((e) => e.id).join(', ')})` })
        continue
      }
      if (warpedLines && warpedLines.mesh && !it.centrelineIncomplete) {
        const w = warpedLines
        lenAll += w.before.length
        boneBefore += w.before.inBone * w.before.length
        boneAfter += w.after.inBone * w.after.length
        muscleBefore += w.before.deepInMuscle * w.before.length
        muscleAfter += w.after.deepInMuscle * w.after.length
        canalAll += w.after.inCanal * w.after.length
        ptsAll += w.points
        ptsMoved += w.pushed
        ptsBone += w.pushedOutOfBone
        pushSum += w.meanPush * w.pushed
        const row = {
          id: it.id, name, source: sourceName(it), lengthMm: round(w.after.length * 1000, 1), inBoneBefore: round(w.before.inBone, 4), inBoneAfter: round(w.after.inBone, 4), inCanal: round(w.after.inCanal, 4),
          deepInMuscleBefore: round(w.before.deepInMuscle, 4), deepInMuscleAfter: round(w.after.deepInMuscle, 4), pointsMoved: round(w.pushed / Math.max(1, w.points), 4), meanPushMm: round(w.meanPush * 1000, 2),
          bones: w.after.bones.map(([n, l]) => [n, round(l * 1000, 1)]), muscles: w.after.muscles.map(([n, l]) => [n, round(l * 1000, 1)]),
        }
        nerveRows.push(row)
        if (w.after.inBone > NERVE_MAX_IN_BONE || w.after.deepInMuscle > NERVE_MAX_DEEP_IN_MUSCLE) {
          dropped.push({ id: it.id, name, kind: 'nerve', reason: `grossly misplaced: ${(w.after.inBone * 100).toFixed(0)}% of its length in bone (${w.after.bones.slice(0, 2).map(([n]) => n).join(', ') || '-'}), ${(w.after.deepInMuscle * 100).toFixed(0)}% deep in muscle (${w.after.muscles.slice(0, 2).map(([n]) => n).join(', ') || '-'})` })
          continue
        }
        importedZa.push(makeElement(it, w.mesh!, { centrelines: w.branches, keepGeometry: true }))
      } else {
        // ganglia (no centreline) and the 8 nerves whose centrelines are incomplete: warp the mesh
        if (!it.files?.mesh) continue
        const src = pkg.mesh(it.files.mesh)
        const w = weld(def.apply(src.positions), src.indices)
        const mesh: Mesh = { positions: w.positions, indices: w.indices }
        importedZa.push(makeElement(it, mesh, warpedLines ? { centrelines: warpedLines.branches } : {}))
      }
    }
    lap(`warped ${nerveItems.length} nerves`)

    // meshes
    const isSolid = (i: number) => SOLID_TISSUES.includes(field.parts[i]!.tissue)
    const isHard = (i: number) => HARD_TISSUES.includes(field.parts[i]!.tissue)
    const warpMesh = (it: ZaItem) => {
      const src = pkg.mesh(it.files!.mesh!)
      const def = reg.deformation(it.frame, it.side)
      const w = weld(def.apply(src.positions), src.indices)
      const pre = measure({ positions: w.positions, indices: w.indices })
      const push = pushOutOfSolids(w.positions, pre.bbox, field, isHard)
      const mesh: Mesh = { positions: push.positions, indices: w.indices }
      const stats = measure(mesh)
      const ov = overlapWith(thinPoints(surfacePoints(mesh, 0.003), 0.002), stats.bbox, field, IMPORT3_DEFAULTS.nearDistance, IMPORT3_DEFAULTS.deepDistance, isSolid)
      const byTissue: Record<string, number> = {}
      for (const [i, f] of ov.inside) byTissue[field.parts[i]!.tissue] = round((byTissue[field.parts[i]!.tissue] ?? 0) + f, 4)
      const top = [...ov.inside].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([i, f]) => `${field.parts[i]!.name} ${(f * 100).toFixed(0)}%`)
      return { mesh, stats, inside: ov.insideAny, deep: ov.deepAny, byTissue, top, pushed: push.moved / Math.max(1, w.positions.length / 3), meanPush: push.meanPush }
    }
    const meshItems = pkg.items.filter((i) => i.kind === 'mesh' && !i.candidate && i.files?.mesh && ['endocrine', 'lymph', 'ligament-bursa-fascia'].includes(i.category ?? ''))
    const meshRows: Record<string, unknown>[] = []
    for (const it of meshItems) {
      const name = displayName(it.name, it.side)
      if (it.inBp3d40) {
        dropped.push({ id: it.id, name, kind: it.category!, reason: 'flagged inBp3d40: the dataset already has this structure' })
        continue
      }
      const same = (it.fma ? fmaTaken.get(it.fma) : undefined) ?? (nameTaken.has(name.toLowerCase()) ? [nameTaken.get(name.toLowerCase())!] : undefined)
      if (same && same.length) {
        dropped.push({ id: it.id, name, kind: it.category!, reason: `the dataset already has this concept (${same.map((e) => `${e.id} ${e.name}`).join(', ')})` })
        continue
      }
      const w = warpMesh(it)
      meshRows.push({ id: it.id, name, category: it.category, inside: round(w.inside, 4), deep: round(w.deep, 4), byTissue: w.byTissue, pushed: round(w.pushed, 4), top: w.top })
      if (w.deep > IMPORT3_DEFAULTS.maxDeepInside || w.inside > ZA_MAX_INSIDE) {
        dropped.push({ id: it.id, name, kind: it.category!, reason: `misplaced: ${(w.inside * 100).toFixed(0)}% of its surface inside existing solids, ${(w.deep * 100).toFixed(0)}% deeper than ${IMPORT3_DEFAULTS.deepDistance * 1000} mm (${w.top.join(', ')})` })
        continue
      }
      importedZa.push(makeElement(it, w.mesh))
    }
    // twins share a verdict
    {
      const twin = (n: string) => n.replace(/^(Left|Right) /, (m) => (m === 'Left ' ? 'Right ' : 'Left '))
      const gone = new Map(dropped.filter((d) => /misplaced/.test(d.reason)).map((d) => [d.name, d]))
      for (let i = importedZa.length - 1; i >= 0; i--) {
        const e = importedZa[i]!
        const t = gone.get(twin(e.name))
        if (!t || twin(e.name) === e.name) continue
        dropped.push({ id: e.id, name: e.name, kind: t.kind, reason: `its twin "${t.name}" is misplaced` })
        importedZa.splice(i, 1)
      }
    }
    lap(`warped ${meshItems.length} Z-Anatomy meshes`)

    // report
    const pct = (v: number) => (v * 100).toFixed(2) + '%'
    console.log(`\nNerves: ${nerveRows.length} tube nerves measured, ${(lenAll).toFixed(1)} m of centreline`)
    console.log(`  in bone (canals/foramina excluded): ${pct(boneBefore / lenAll)} of length after registration → ${pct(boneAfter / lenAll)} after clean-up; in expected canals/foramina: ${pct(canalAll / lenAll)}`)
    console.log(`  more than 3 mm deep in muscle: ${pct(muscleBefore / lenAll)} → ${pct(muscleAfter / lenAll)}`)
    console.log(`  clean-up moved ${pct(ptsMoved / ptsAll)} of centreline points (${pct(ptsBone / ptsAll)} out of bone, the rest out of muscle bellies), mean ${mm(pushSum / Math.max(1, ptsMoved))} mm`)
    const worstBone = [...nerveRows].sort((a, b) => (b.inBoneAfter as number) * (b.lengthMm as number) - (a.inBoneAfter as number) * (a.lengthMm as number)).slice(0, 8)
    console.log(`  most bone left: ${worstBone.map((r) => `${r.name} ${((r.inBoneAfter as number) * 100).toFixed(0)}% (${(r.bones as [string, number][])[0]?.[0] ?? '-'})`).join('; ')}`)
    const worstMuscle = [...nerveRows].sort((a, b) => (b.deepInMuscleAfter as number) - (a.deepInMuscleAfter as number)).slice(0, 8)
    console.log(`  most muscle left: ${worstMuscle.map((r) => `${r.name} ${((r.deepInMuscleAfter as number) * 100).toFixed(0)}% (${(r.muscles as [string, number][])[0]?.[0] ?? '-'})`).join('; ')}`)
    if (agreement.length) {
      console.log('  imported nerves that BodyParts3D 4.0 already has (import dropped; distance from the BodyParts3D part to the imported centreline):')
      for (const a of agreement) console.log(`    ${pad(a.imported as string, 34)}vs ${pad(a.existing as string, 30)}median ${a.medianMm} mm, max ${a.maxMm} mm, ${((a.within5mm as number) * 100).toFixed(0)}% within 5 mm`)
    }

    // fallback comparisons asked for: transversus abdominis (3.0 vs Z-Anatomy) and the pleura
    const comparisons: Record<string, unknown>[] = []
    console.log('\nZ-Anatomy fallbacks compared (not imported unless stated)')
    for (const it of pkg.items.filter((i) => i.kind === 'mesh' && !i.candidate && i.files?.mesh && (/^Transversus abdominis/.test(i.name) || i.name === 'Pleura'))) {
      const name = displayName(it.name, it.side)
      // compare against everything except the 3.0 part it would replace
      const w = warpMesh(it)
      const r3 = kept.find((e) => e.id.startsWith(R3_PREFIX) && e.fma === it.fma)
      const r3row = r3 ? (report.release3 as { candidates: { id: string; inside: number; deepInside: number; insideByTissue: Record<string, number> }[] }).candidates.find((c) => R3_PREFIX + c.id === r3.id) : undefined
      console.log(`  ${pad(name, 34)}Z-Anatomy: inside ${(w.inside * 100).toFixed(1)}%, deep ${(w.deep * 100).toFixed(1)}%, by tissue ${JSON.stringify(w.byTissue)}, ${w.mesh.indices.length / 3} triangles${r3row ? ` | release 3.0 part: inside ${(r3row.inside * 100).toFixed(1)}%, deep ${(r3row.deepInside * 100).toFixed(1)}%, by tissue ${JSON.stringify(r3row.insideByTissue)}` : ''}`)
      const row: Record<string, unknown> = { name, zAnatomy: { inside: round(w.inside, 4), deep: round(w.deep, 4), byTissue: w.byTissue, top: w.top }, release3: r3row ? { inside: r3row.inside, deep: r3row.deepInside, byTissue: r3row.insideByTissue } : null }
      if (it.name === 'Pleura') {
        const lobes = kept.filter((e) => /lobe of (left |right )?lung/i.test(e.name))
        const tester = new InsideTester(w.mesh, 96)
        let inside = 0
        let total = 0
        for (const l of lobes) {
          const pts = thinPoints(surfacePoints(l.mesh, 0.004), 0.003)
          inside += tester.fractionInside(pts) * pts.length
          total += pts.length
        }
        const lungsInside = total ? inside / total : 0
        console.log(`    lung lobes (${lobes.length}) inside the pleural surface: ${(lungsInside * 100).toFixed(1)}%`)
        row.lungsInside = round(lungsInside, 4)
      }
      comparisons.push(row)
    }

    kept.push(...importedZa)
    {
      const meshByName = new Map<string, Mesh>()
      const nerveByName = new Map<string, Polyline[]>()
      for (const e of kept) {
        if (!meshByName.has(e.name)) meshByName.set(e.name, e.mesh)
        if (e.centrelines && !nerveByName.has(e.name)) nerveByName.set(e.name, e.centrelines)
      }
      landmarks = runLandmarkChecks({ mesh: (n) => meshByName.get(n) ?? null, nerve: (n) => nerveByName.get(n) ?? null })
      console.log('\nNerve landmark checks')
      for (const r of landmarks) console.log(`  ${r.evaluated ? (r.pass ? 'PASS' : 'FAIL') : 'n/a '} ${r.side} ${pad(r.id, 20)}${r.measured}`)
      console.log(`  ${landmarks.filter((r) => r.pass).length} pass, ${landmarks.filter((r) => r.evaluated && !r.pass).length} fail, ${landmarks.filter((r) => !r.evaluated).length} not evaluated`)
      report.landmarks = landmarks
    }
    const kinds = new Map<string, number>()
    for (const e of importedZa) {
      const k = `${e.source} ${e.cls.system}/${e.cls.tissue}`
      kinds.set(k, (kinds.get(k) ?? 0) + 1)
    }
    console.log(`\nImported from the Z-Anatomy package: ${importedZa.length} parts — ${[...kinds].sort().map(([k, v]) => `${k} ${v}`).join(', ')}`)
    const reasons = new Map<string, string[]>()
    for (const d of dropped) {
      const key = d.reason.replace(/\(.*$/, '').replace(/:.*$/, '').trim()
      reasons.set(key, [...(reasons.get(key) ?? []), d.name])
    }
    console.log(`  dropped ${dropped.length}:`)
    for (const [k, v] of reasons) console.log(`    ${k} (${v.length}): ${v.slice(0, 40).join('; ')}${v.length > 40 ? '; …' : ''}`)
    for (const d of dropped.filter((x) => /misplaced/.test(x.reason))) console.log(`      ${d.name}: ${d.reason}`)
    const how = new Map<string, number>()
    for (const e of importedZa) how.set(e.tree!.isa.how + (e.fma.startsWith('ZAC_') ? ' (synthetic id)' : ''), (how.get(e.tree!.isa.how + (e.fma.startsWith('ZAC_') ? ' (synthetic id)' : '')) ?? 0) + 1)
    console.log(`  sided concept ids minted for lateralised parts filed under an unsided class: ${importedZa.filter((e) => /_(L|R)$/.test(e.fma) && e.fma.startsWith('FMA')).length}`)
    console.log(`  isa placement: ${[...how].map(([k, v]) => `${k} ${v}`).join(', ')}; partOf: ${importedZa.filter((e) => e.tree!.partOf).length} attached (own concept in the 4.0 partOf tree), ${importedZa.filter((e) => !e.tree!.partOf).length} not attached`)
    report.zAnatomy = {
      available: true, registration: regRows, anchorsUsed: reg.anchorsUsed, anchorsSkipped: reg.anchorsSkipped,
      imported: Object.fromEntries([...kinds].sort()), dropped,
      nerves: {
        measured: nerveRows.length, lengthM: round(lenAll, 2), inBoneBefore: round(boneBefore / lenAll, 5), inBoneAfter: round(boneAfter / lenAll, 5), inCanal: round(canalAll / lenAll, 5),
        deepInMuscleBefore: round(muscleBefore / lenAll, 5), deepInMuscleAfter: round(muscleAfter / lenAll, 5), pointsMoved: round(ptsMoved / ptsAll, 5), pointsMovedOutOfBone: round(ptsBone / ptsAll, 5), meanPushMm: round((pushSum / Math.max(1, ptsMoved)) * 1000, 2),
        perNerve: nerveRows, agreementWithBodyParts3D: agreement,
      },
      meshes: meshRows, comparisons,
      placement: importedZa.map((e) => ({ id: e.id, fma: e.fma, isaHow: e.tree!.isa.how, isaAnchor: e.tree!.isa.anchor ? tables.isa.name.get(e.tree!.isa.anchor) : null, isaPath: e.tree!.isa.path.map(([, n]) => n), partOf: !!e.tree!.partOf })),
    }
  }

  // ── 4. Classification report ────────────────────────────────────────────────────────────────
  {
    const table = new Map<string, number>()
    const bySignal = new Map<string, number>()
    for (const e of kept) {
      const k = `${e.cls.system}/${e.cls.tissue}`
      table.set(k, (table.get(k) ?? 0) + 1)
      bySignal.set(e.cls.signal, (bySignal.get(e.cls.signal) ?? 0) + 1)
    }
    console.log('\nParts per system / tissue')
    let lastSystem = ''
    const perSystem = new Map<string, number>()
    for (const [k, v] of table) perSystem.set(k.split('/')[0]!, (perSystem.get(k.split('/')[0]!) ?? 0) + v)
    for (const [k, v] of [...table].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const [s, t] = k.split('/') as [string, string]
      console.log(`  ${pad(s === lastSystem ? '' : `${s} (${perSystem.get(s)})`, 24)}${pad(t, 12)}${v}`)
      lastSystem = s
    }
    console.log(`  decided by: ${[...bySignal].map(([k, v]) => `${k} ${v}`).join(', ')}`)
    const viaName = kept.filter((e) => e.cls.signal === 'name')
    if (viaName.length) console.log(`  classified by name only: ${viaName.map((e) => `${e.id} ${e.name}`).join('; ')}`)
    const other = kept.filter((e) => e.cls.system === 'other' || e.cls.tissue === 'other')
    console.log(other.length ? `  'other' (${other.length}):\n${other.map((e) => `    ${e.id} ${e.name}  [${e.cls.system}/${e.cls.tissue}]  isa: ${e.isa.slice(0, 4).join(' < ')}`).join('\n')}` : "  'other': none")
    report.classification = {
      counts: Object.fromEntries([...table].sort()),
      bySignal: Object.fromEntries(bySignal),
      byName: viaName.map((e) => ({ id: e.id, name: e.name })),
      other: other.map((e) => ({ id: e.id, name: e.name, isa: e.isa.slice(0, 5) })),
    }
  }
  if (classifyOnly) return

  // ── 5. Side ─────────────────────────────────────────────────────────────────────────────────
  const sides = kept.map((e) => SIDE_OVERRIDES[e.id] ?? sideOf(e.name, e.stats.centroid, e.stats.bbox))
  {
    const conflicts = kept.filter((e, i) => {
      const named = sideFromName(e.name)
      if (!named || SIDE_OVERRIDES[e.id]) return false
      const cx = e.stats.centroid[0]
      return (sides[i] === 'L' && cx < -0.005) || (sides[i] === 'R' && cx > 0.005)
    })
    const c = { L: 0, R: 0, M: 0 }
    for (const s of sides) c[s]++
    const named = kept.filter((e) => sideFromName(e.name)).length
    console.log(`\nSide: L ${c.L}, R ${c.R}, M ${c.M} (${named} from the name, ${kept.length - named} from geometry)`)
    if (conflicts.length) {
      console.log(`  named side disagrees with the centroid for ${conflicts.length} parts (name wins; these are mostly organ-relative names such as "left hepatic…", "right coronary…"):`)
      console.log('    ' + conflicts.map((e) => `${e.id} ${e.name} (x=${(e.stats.centroid[0] * 1000).toFixed(0)}mm)`).join('; '))
    }
    report.side = { counts: c, fromName: named, nameVsCentroidConflicts: conflicts.map((e) => ({ id: e.id, name: e.name, x: round(e.stats.centroid[0]) })) }
  }

  // ── 6. Exposure -> depth ────────────────────────────────────────────────────────────────────
  const sourceMeshes = kept.map((e) => e.mesh)
  const roles: ExposureRole[] = kept.map((e) => {
    const { system, tissue } = e.cls
    if (system === 'integumentary') return e.isa.includes('skin') ? 'skin' : 'ignore'
    // lymph nodes are too small to hide a muscle
    if (system === 'lymphatic' && e.provenance === 'curated') return 'ignore'
    if (tissue === 'muscle' || tissue === 'bone' || tissue === 'cartilage' || tissue === 'organ' || tissue === 'brain' || tissue === 'heart' || tissue === 'gland' || tissue === 'tooth') return 'occluder'
    return 'ignore'
  })
  const targets = kept.map((e, i) => (usesExposure(e.cls.system, e.cls.tissue) ? i : -1)).filter((i) => i >= 0)
  const hasSkin = roles.includes('skin')
  const rawExposure = hasSkin
    ? computeExposure(sourceMeshes, roles, targets, { cell: 0.004, spacing: 0.003, maxDistance: EXPOSURE_MAX_DISTANCE })
    : targets.map(() => 0)
  const exposure = new Map<number, number>()
  {
    // left/right twins share the mean
    const groups = new Map<string, number[]>()
    targets.forEach((ti, k) => {
      const key = kept[ti]!.name.replace(/\b(left|right)\b\s*/gi, '').toLowerCase()
      let g = groups.get(key)
      if (!g) groups.set(key, (g = []))
      g.push(k)
    })
    for (const g of groups.values()) {
      const mean = g.reduce((s, k) => s + rawExposure[k]!, 0) / g.length
      for (const k of g) exposure.set(targets[k]!, mean)
    }
  }
  const depths = kept.map((e, i) => depthOf(e.cls.system, e.cls.tissue, exposure.get(i) ?? 0))
  lap(`exposure of ${targets.length} muscular parts${hasSkin ? '' : ' (no skin mesh: everything deep)'}`)
  {
    console.log('\nLayers')
    LAYERS.forEach((l, d) => console.log(`  ${d} ${pad(l.name.en, 26)}${depths.filter((x) => x === d).length}`))
    const ex = (re: RegExp) => targets.filter((ti) => re.test(kept[ti]!.name)).map((ti) => `${kept[ti]!.name} ${(exposure.get(ti)! * 100).toFixed(0)}%`).join(', ')
    console.log(`  exposure spot checks: ${ex(/^Right (rectus abdominis|pectoralis minor|biceps brachii|brachialis|gluteus (maximus|medius|minimus)|soleus|sartorius|vastus intermedius|trapezius|latissimus dorsi|rhomboid major|supraspinatus|psoas major|tibialis posterior|external oblique|internal oblique|transversus abdominis)$/)}`)
    report.layers = LAYERS.map((l, d) => ({ depth: d, name: l.name.en, parts: depths.filter((x) => x === d).length }))
    report.exposure = Object.fromEntries(targets.map((ti) => [kept[ti]!.id, round(exposure.get(ti)!, 3)]))
  }

  // ── 7. Adjacency (on the unsimplified surfaces) ─────────────────────────────────────────────
  const adj = computeAdjacency(sourceMeshes, { threshold: ADJACENCY_THRESHOLD, spacing: ADJACENCY_SPACING })
  const envelopes = adj.neighbours.map((l, i) => (l.length > ADJACENCY_MAX_DEGREE ? i : -1)).filter((i) => i >= 0)
  const envelopeSet = new Set(envelopes)
  const neighbours = adj.neighbours.map((l, i) => (envelopeSet.has(i) ? [] : l.filter((j) => !envelopeSet.has(j))))
  lap(`adjacency from ${adj.samples} surface samples`)
  {
    const deg = neighbours.map((l) => l.length).filter((_, i) => !envelopeSet.has(i)).sort((a, b) => a - b)
    const pairs = neighbours.reduce((s, l) => s + l.length, 0) / 2
    const names = (i: number) => neighbours[i]!.map((j) => kept[j]!.name)
    console.log(`\nAdjacency (≤ ${ADJACENCY_THRESHOLD * 1000} mm between surface samples ≤ ${ADJACENCY_SPACING * 1000} mm apart): ${pairs} pairs`)
    console.log(`  envelopes excluded (degree > ${ADJACENCY_MAX_DEGREE}): ${envelopes.map((i) => `${kept[i]!.name} (${adj.neighbours[i]!.length})`).join(', ') || 'none'}`)
    console.log(`  degree min ${deg[0]}, p10 ${quantile(deg, 0.1)}, median ${quantile(deg, 0.5)}, p90 ${quantile(deg, 0.9)}, p99 ${quantile(deg, 0.99)}, max ${deg[deg.length - 1]}; isolated parts: ${deg.filter((d) => d === 0).length}`)
    const top = neighbours.map((l, i) => [l.length, kept[i]!.name] as const).sort((a, b) => b[0] - a[0]).slice(0, 8)
    console.log(`  highest: ${top.map(([d, n]) => `${n} ${d}`).join(', ')}`)
    const check = (name: string, re: RegExp) => {
      const i = kept.findIndex((e) => e.name === name)
      if (i < 0) return
      console.log(`  ${name} ↔ ${names(i).filter((n) => re.test(n)).join(', ') || '(nothing matching ' + re + ')'}`)
    }
    check('Left femur', /^Left (tibia|patella|hip bone|fibula)$/)
    check('Left patella', /./)
    check('Wall of ventricle', /atrium|Diaphragm|thymus|aorta|Pulmonary trunk|bronch/i)
    report.adjacency = {
      thresholdM: ADJACENCY_THRESHOLD, spacingM: ADJACENCY_SPACING, samples: adj.samples, pairs,
      envelopes: envelopes.map((i) => ({ id: kept[i]!.id, name: kept[i]!.name, rawDegree: adj.neighbours[i]!.length })),
      degree: { min: deg[0], p10: quantile(deg, 0.1), median: quantile(deg, 0.5), p90: quantile(deg, 0.9), p99: quantile(deg, 0.99), max: deg[deg.length - 1], isolated: deg.filter((d) => d === 0).length },
      highest: top.map(([d, n]) => ({ name: n, degree: d })),
    }
  }

  // ── 8. Simplify, normals, final measurements ────────────────────────────────────────────────
  const parts: Part[] = []
  const glbParts = new Map<SystemId, GlbPart[]>()
  let outTriangles = 0
  let simplifiedCount = 0
  let maxError = 0
  let worstVolume = { id: '', name: '', change: 0 }
  const trisByTissue = new Map<TissueId, [number, number]>()
  for (let i = 0; i < kept.length; i++) {
    const e = kept[i]!
    const thickness = e.stats.area > 0 ? (3 * Math.abs(e.stats.signedVolume)) / e.stats.area : 0
    const err = Math.min(SIMPLIFY_ERROR_MAX, Math.max(SIMPLIFY_ERROR_MIN, SIMPLIFY_ERROR_PER_THICKNESS * thickness))
    const floor = Math.max(SIMPLIFY_MIN_TRIANGLES, e.stats.area / (0.433 * SIMPLIFY_MAX_EDGE ** 2))
    const simp = e.keepGeometry ? { ...e.mesh, error: 0 } : await simplifyMesh(e.mesh, err, floor)
    const mesh: Mesh = { positions: simp.positions, indices: simp.indices }
    const stats = simp.indices.length === e.mesh.indices.length ? e.stats : measure(mesh)
    if (simp.indices.length < e.mesh.indices.length) {
      simplifiedCount++
      maxError = Math.max(maxError, simp.error)
      if (Math.abs(e.stats.signedVolume) > 1e-7) {
        const change = Math.abs(stats.signedVolume - e.stats.signedVolume) / Math.abs(e.stats.signedVolume)
        if (change > worstVolume.change) worstVolume = { id: e.id, name: e.name, change }
      }
    }
    const triangles = mesh.indices.length / 3
    outTriangles += triangles
    const tt = trisByTissue.get(e.cls.tissue) ?? [0, 0]
    tt[0] += e.mesh.indices.length / 3
    tt[1] += triangles
    trisByTissue.set(e.cls.tissue, tt)
    const part: Part = {
      id: e.id,
      fma: e.fma,
      name: e.name,
      system: e.cls.system,
      tissue: e.cls.tissue,
      depth: depths[i]!,
      side: sides[i]!,
      provenance: e.provenance,
      ...(e.source ? { source: e.source } : {}),
      bbox: stats.bbox.map((v) => round(v)) as Part['bbox'],
      centroid: stats.centroid.map((v) => round(v)) as Part['centroid'],
      ...(e.volume !== undefined ? { volume: e.volume } : {}),
      triangles,
      adjacent: neighbours[i]!.map((j) => kept[j]!.id),
    }
    parts.push(part)
    let list = glbParts.get(e.cls.system)
    if (!list) glbParts.set(e.cls.system, (list = []))
    list.push({ id: e.id, positions: mesh.positions, normals: computeNormals(mesh), indices: mesh.indices })
  }
  lap(`simplified ${simplifiedCount} of ${kept.length} parts`)
  const keptSourceTriangles = kept.reduce((s, e) => s + e.mesh.indices.length / 3, 0)
  const importedTriangles = imported.reduce((n, e) => n + e.mesh.indices.length / 3, 0)
  console.log(`\nTriangles: ${sourceTriangles} in the 4.0 source${importedTriangles ? ` + ${importedTriangles} in the ${imported.length} parts imported from 3.0` : ''} (${keptSourceTriangles} after welding and merging duplicates) → ${outTriangles} written (${((100 * outTriangles) / keptSourceTriangles).toFixed(1)}%)`)
  console.log(`  error bound = clamp(${SIMPLIFY_ERROR_PER_THICKNESS}·thickness, ${(SIMPLIFY_ERROR_MIN * 1000).toFixed(2)} mm, ${(SIMPLIFY_ERROR_MAX * 1000).toFixed(2)} mm); parts ≤ ${SIMPLIFY_MIN_TRIANGLES} triangles untouched; largest error reported by the simplifier ${(maxError * 1000).toFixed(3)} mm; largest volume change ${(worstVolume.change * 100).toFixed(1)}% (${worstVolume.id} ${worstVolume.name})`)
  console.log('  by tissue: ' + [...trisByTissue].sort((a, b) => b[1][0] - a[1][0]).map(([t, [a, b]]) => `${t} ${a}→${b}`).join(', '))
  report.triangles = {
    source: sourceTriangles, importedFromRelease3: importedTriangles, afterWeldAndMerge: keptSourceTriangles, written: outTriangles, simplifiedParts: simplifiedCount,
    maxErrorM: maxError, worstVolumeChange: worstVolume, byTissue: Object.fromEntries([...trisByTissue].map(([t, [a, b]]) => [t, { source: a, written: b }])),
  }

  // ── 9. Trees ────────────────────────────────────────────────────────────────────────────────
  // Merged duplicates stay reachable: the kept element takes the dropped one's place.
  const keepIds = new Set(kept.map((e) => e.id))
  const withAliases = (onto: Ontology, which: 'isa' | 'partOf'): Ontology => {
    const elementsMap = new Map<string, Set<string>>()
    for (const [c, set] of onto.elements) elementsMap.set(c, new Set([...set].map(resolve)))
    // relabelled elements leave their old concept for the right one (same ancestors above)
    for (const [id, oldFma] of relabelledFrom) {
      const next = RELABELLED[id]!.fma
      if (!elementsMap.has(next) && !onto.name.has(next)) continue
      elementsMap.get(oldFma)?.delete(id)
      let set = elementsMap.get(next)
      if (!set) elementsMap.set(next, (set = new Set()))
      set.add(id)
    }
    const name = new Map(onto.name)
    const parent = new Map(onto.parent)
    const children = new Map([...onto.children].map(([k, v]) => [k, [...v]]))
    // imported parts: under their own concept when the tree has it, otherwise as a new leaf
    // concept below the placement concept (the tree root when there is none, isa only)
    for (const e of imported) {
      const pl = e.placement!
      let anchor = which === 'isa' ? pl.isaConcept : pl.partOfConcept
      if (!anchor) {
        if (which === 'partOf') continue
        anchor = onto.root
      }
      let concept = e.fma
      if (!name.has(concept)) {
        name.set(concept, e.name[0]!.toLowerCase() + e.name.slice(1))
        parent.set(concept, anchor)
        children.set(anchor, [...(children.get(anchor) ?? []), concept])
      }
      for (let c: string | null | undefined = concept; c; c = parent.get(c)) {
        let set = elementsMap.get(c)
        if (!set) elementsMap.set(c, (set = new Set()))
        set.add(e.id)
      }
    }
    // parts from the Z-Anatomy package: create the missing concepts of their path, child first
    for (const e of importedZa) {
      const t = which === 'isa' ? e.tree!.isa : e.tree!.partOf
      if (!t) continue
      const anchor = t.anchor ?? (which === 'isa' ? onto.root : null)
      if (!anchor) continue
      const chain = [...t.path.map(([id]) => id), anchor]
      t.path.forEach(([id, label], k) => {
        if (name.has(id)) return
        const up = chain[k + 1]!
        name.set(id, label)
        parent.set(id, up)
        children.set(up, [...(children.get(up) ?? []), id])
      })
      for (let c: string | null | undefined = chain[0]; c; c = parent.get(c)) {
        let set = elementsMap.get(c)
        if (!set) elementsMap.set(c, (set = new Set()))
        set.add(e.id)
      }
    }
    return { ...onto, name, parent, children, elements: elementsMap }
  }
  const isaTree = emitConcepts(withAliases(tables.isa, 'isa'), keepIds)
  const partOfTree = emitConcepts(withAliases(tables.partOf, 'partOf'), keepIds)
  const reach = (tree: typeof isaTree) => new Set(tree.flatMap((c) => c.parts))
  const isaReach = reach(isaTree)
  const poReach = reach(partOfTree)
  console.log(`\nTrees: isa ${isaTree.length} concepts covering ${isaReach.size}/${parts.length} parts (of ${tables.isa.name.size} source concepts); partOf ${partOfTree.length} concepts covering ${poReach.size}/${parts.length} parts (of ${tables.partOf.name.size})`)
  report.trees = { isa: { concepts: isaTree.length, parts: isaReach.size }, partOf: { concepts: partOfTree.length, parts: poReach.size } }

  // ── 10. Write ───────────────────────────────────────────────────────────────────────────────
  // Everything is written to a scratch directory next to the target and then moved in file by
  // file (rename is atomic), GLBs first and anatomy.json last, so a reader never sees a
  // half-written file. Between the first and the last rename a reader can still pair the old
  // anatomy.json with a new GLB; the window is a few milliseconds.
  mkdirSync(outDir, { recursive: true })
  const stage = `${outDir.replace(/\/+$/, '')}.tmp-${process.pid}`
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  const systemDefs = JSON.parse(readFileSync(join(ROOT, 'data/curated/systems.json'), 'utf8')) as Omit<SystemDef, 'glb' | 'partCount'>[]
  const systems: SystemDef[] = []
  const glbSizes: Record<string, number> = {}
  for (const def of systemDefs) {
    const list = glbParts.get(def.id) ?? []
    let glb: string | null = null
    if (list.length) {
      glb = `${def.id}.glb`
      glbSizes[glb] = await writeSystemGlb(join(stage, glb), def.id, def.color, list)
    }
    systems.push({ id: def.id, name: def.name, color: def.color, glb, partCount: list.length })
  }
  for (const s of glbParts.keys()) if (!systemDefs.some((d) => d.id === s)) throw new Error(`system ${s} missing from data/curated/systems.json`)
  // concept audit: parts whose concept cannot describe them alone
  {
    const groups = new Map<string, Set<string>>()
    for (const p of parts) groups.set(`${p.fma}|${p.side}`, (groups.get(`${p.fma}|${p.side}`) ?? new Set()).add(p.name))
    const multi = [...groups].filter(([, v]) => v.size > 1)
    const bothSides = new Map<string, Set<string>>()
    for (const p of parts) if (p.side !== 'M') bothSides.set(p.fma, (bothSides.get(p.fma) ?? new Set()).add(p.side))
    const shared = [...bothSides].filter(([, v]) => v.size > 1).map(([k]) => k)
    const audit = {
      conceptsSharedByLeftAndRightParts: shared.length,
      partsUnderThem: parts.filter((p) => shared.includes(p.fma)).length,
      ofWhichFromBodyParts3D: parts.filter((p) => shared.includes(p.fma) && !p.source).length,
      conceptsWithDifferentlyNamedPartsOnOneSide: multi.length,
      examples: multi.slice(0, 12).map(([k, v]) => ({ concept: k.split('|')[0], names: [...v] })),
    }
    console.log(`\nConcept audit: ${audit.conceptsSharedByLeftAndRightParts} concepts are shared by left and right parts (${audit.partsUnderThem} parts, ${audit.ofWhichFromBodyParts3D} of them BodyParts3D's own unlateralised concepts); ${audit.conceptsWithDifferentlyNamedPartsOnOneSide} concepts carry differently named parts on one side, e.g. ${audit.examples.slice(0, 4).map((e) => `${e.concept}: ${e.names.join(' / ')}`).join('; ')}`)
    report.conceptAudit = audit
  }
  const cautions = maleCautions(report, imported.length, importedZa.length)
  const data: AnatomyData = {
    schema: 1,
    body: 'male',
    cautions,
    sources: [SOURCE, ...(imported.length ? [SOURCE3] : []), ...(importedZa.some((e) => e.source === SOURCE_ZA.name) ? [SOURCE_ZA] : []), ...(importedZa.some((e) => e.source === SOURCE_O3D.name) ? [SOURCE_O3D] : [])],
    systems,
    layers: LAYERS.map((l) => ({ name: l.name })),
    parts,
    trees: { isa: isaTree, partOf: partOfTree },
  }
  const json = JSON.stringify(data)
  writeFileSync(join(stage, 'anatomy.json'), json)
  // nerves.json: the centrelines the nerve tubes were built from
  const nervePaths: NervePath[] = kept
    .filter((e) => e.centrelines && e.centrelines.length)
    .map((e) => ({ part: e.id, branches: e.centrelines!.map((b) => ({ points: Array.from(b.points, (v) => round(v)), radius: Array.from(b.radius, (v) => round(v)) })) }))
  const nervesJson = JSON.stringify(nervePaths)
  if (nervePaths.length) writeFileSync(join(stage, 'nerves.json'), nervesJson)
  lap('wrote output')
  console.log(`\nOutput in ${outDir}`)
  console.log(`  anatomy.json ${(json.length / 1024).toFixed(0)} KB — ${parts.length} parts`)
  if (nervePaths.length) console.log(`  nerves.json ${(nervesJson.length / 1024).toFixed(0)} KB — ${nervePaths.length} nerves, ${nervePaths.reduce((n, p) => n + p.branches.length, 0)} branches`)
  let glbTotal = 0
  for (const s of systems) {
    if (!s.glb) continue
    const tris = parts.filter((p) => p.system === s.id).reduce((a, p) => a + p.triangles, 0)
    glbTotal += glbSizes[s.glb]!
    console.log(`  ${pad(s.glb, 22)}${pad((glbSizes[s.glb]! / 1024).toFixed(0) + ' KB', 10)}${pad(s.partCount + ' parts', 12)}${tris} triangles`)
  }
  console.log(`  GLB total ${(glbTotal / 1024 / 1024).toFixed(2)} MB`)
  const all = parts.reduce((b, p) => [Math.min(b[0]!, p.bbox[0]), Math.min(b[1]!, p.bbox[1]), Math.min(b[2]!, p.bbox[2]), Math.max(b[3]!, p.bbox[3]), Math.max(b[4]!, p.bbox[4]), Math.max(b[5]!, p.bbox[5])], [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
  console.log(`  body bounds (m): x ${all[0]!.toFixed(3)}…${all[3]!.toFixed(3)}, y ${all[1]!.toFixed(3)}…${all[4]!.toFixed(3)}, z ${all[2]!.toFixed(3)}…${all[5]!.toFixed(3)}`)
  report.output = { parts: parts.length, anatomyJsonBytes: json.length, glbBytes: glbSizes, bounds: all.map((v) => round(v, 4)) }
  report.parameters = {
    SIMPLIFY_ERROR_PER_THICKNESS, SIMPLIFY_ERROR_MIN, SIMPLIFY_ERROR_MAX, SIMPLIFY_MIN_TRIANGLES, SIMPLIFY_MAX_EDGE,
    ADJACENCY_THRESHOLD, ADJACENCY_SPACING, ADJACENCY_MAX_DEGREE, SUPERFICIAL_EXPOSURE, EXPOSURE_MAX_DISTANCE,
  }
  writeFileSync(join(stage, 'pipeline-report.json'), JSON.stringify(report, null, 1))
  const staged = readdirSync(stage).sort((a, b) => Number(a === 'anatomy.json') - Number(b === 'anatomy.json') || a.localeCompare(b))
  for (const f of staged) renameSync(join(stage, f), join(outDir, f))
  for (const f of readdirSync(outDir)) if ((f.endsWith('.glb') || f === 'nerves.json') && !staged.includes(f)) rmSync(join(outDir, f))
  rmSync(stage, { recursive: true, force: true })
  if (!existsSync(join(outDir, 'anatomy.json'))) throw new Error('output missing')
  lap('done')
}

/** What a user should not trust in the male body, most important first. */
function maleCautions(report: Record<string, unknown>, r3Parts: number, zaParts: number): { zh: string; en: string }[] {
  const out: { zh: string; en: string }[] = []
  out.push({
    en: 'This is a teaching model assembled from several atlases, not a scan of one person, and no anatomist has reviewed it. BodyParts3D itself warns that organs may overlap or leave gaps and that vessels and airways are modelled as solid tubes.',
    zh: '本模型由多套图谱数据拼合而成，并非某一个人的扫描结果，也未经解剖学专家审校。BodyParts3D 原始数据自身说明：器官之间可能相互重叠或留有空隙，血管和气道以实心管表示。',
  })
  const z = report.zAnatomy as { available: boolean; nerves?: { pointsMoved: number; inBoneAfter: number; deepInMuscleAfter: number } } | undefined
  if (z?.available && z.nerves) {
    const moved = Math.round(z.nerves.pointsMoved * 100)
    out.push({
      en: `Peripheral nerves, joint ligaments, fasciae, lymph nodes and the thyroid (${zaParts} parts from Z-Anatomy and Open3DModel) are artist-modelled and were fitted to this body by a non-rigid registration: expect about 2 mm error typically and 7–8 mm in one case out of ten, more in the thigh and leg.`,
      zh: `周围神经、关节韧带、筋膜、淋巴结和甲状腺（共 ${zaParts} 个部件，来自 Z-Anatomy 与 Open3DModel）为美术建模，经非刚性配准贴合到本模型：位置误差一般约 2 mm，约十分之一的情况达 7–8 mm，大腿和小腿处更大。`,
    })
    out.push({
      en: `Nerve courses were corrected automatically: ${moved}% of nerve centreline points were pushed out of bone or muscle bellies (3.6 mm on average), ${(z.nerves.deepInMuscleAfter * 100).toFixed(0)}% of nerve length still runs deep inside muscle, and tube thickness is schematic.`,
      zh: `神经走行经过自动修正：约 ${moved}% 的神经中心线点被从骨或肌腹内推出（平均 3.6 mm），仍有约 ${(z.nerves.deepInMuscleAfter * 100).toFixed(0)}% 的神经长度位于肌腹深部；神经粗细仅为示意。`,
    })
  }
  if (r3Parts) {
    out.push({
      en: `${r3Parts} parts (lung lobes, abdominal wall muscles, latissimus dorsi, muscles of mastication and facial expression) come from the older BodyParts3D 3.0 body and were warped into this one: about 1.4 mm error in the head, 3.6 mm in the thorax and 6.4 mm in the abdomen (medians). Thin facial muscles were flattened onto the skull.`,
      zh: `有 ${r3Parts} 个部件（肺叶、腹壁肌、背阔肌、咀嚼肌和表情肌）取自较早的 BodyParts3D 3.0 人体，经形变移入本模型：位置误差中位数在头部约 1.4 mm、胸部约 3.6 mm、腹部约 6.4 mm；较薄的表情肌被压贴在颅骨表面。`,
    })
    out.push({
      en: 'Transversus abdominis is the worst-fitting muscle: about a third of its surface lies inside neighbouring organs and muscles (stomach, colon, diaphragm), 5% of it deeper than 4 mm. The right lung base sits too high for the bronchi drawn inside it.',
      zh: '腹横肌贴合最差：约三分之一的表面嵌入相邻器官和肌肉（胃、结肠、膈），其中 5% 深度超过 4 mm。右肺底位置偏高，与其内部的支气管不完全吻合。',
    })
  }
  out.push({
    en: 'Missing structures: phrenic nerve, cervical plexus branches, great auricular and occipital nerves, splanchnic nerves; the spinal cord itself (only its central canal); pleura, pericardium and most peritoneum; cruciate ligaments and menisci of the knee; parotid gland; inferior parathyroids; middle and inner ear; fat. The liver exists only as its eight segments, the heart only as chamber walls and valves.',
    zh: '缺失的结构：膈神经、颈丛分支、耳大神经和枕神经、内脏神经；脊髓本体（仅有中央管）；胸膜、心包和大部分腹膜；膝关节交叉韧带和半月板；腮腺；下甲状旁腺；中耳和内耳；脂肪。肝脏只以肝段形式存在，心脏只有心腔壁和瓣膜。',
  })
  out.push({
    en: 'Left/right labels of five structures were wrong in the source and corrected here from their position: flexor pollicis brevis, brachium of superior colliculus, middle pharyngeal constrictor, ascending lumbar vein (labels swapped) and one fibular vein. For heart, liver and coronary structures "left/right" in a name refers to the organ, not the side of the body.',
    zh: '原始数据中有五处结构的左右标注有误，已按实际位置更正：拇短屈肌、上丘臂、咽中缩肌、腰升静脉（左右互换）以及一条腓静脉。心、肝及冠状血管名称中的“左/右”指器官自身的左右，而非身体的左右侧。',
  })
  out.push({
    en: 'The "superficial" and "deep" muscle layers are computed geometrically (how much of a muscle faces the skin uncovered), not taken from a textbook: rectus abdominis, for example, counts as deep because the external oblique aponeurosis covers it in this model.',
    zh: '肌肉的“浅层/深层”是按几何关系自动计算的（肌肉表面有多少直接朝向皮肤而未被遮盖），并非取自教科书分层：例如腹直肌在本模型中被腹外斜肌腱膜覆盖，因而归入深层。',
  })
  out.push({
    en: 'Meshes were simplified (largest deviation 0.8 mm) and the feet point downwards as in the scanner; lower-limb lymph nodes and several knee, shoulder and ankle ligaments were left out because they did not fit this body.',
    zh: '网格经过简化（最大偏差 0.8 mm）；双足呈扫描时的跖屈姿势。下肢部分淋巴结以及膝、肩、踝的若干韧带因无法贴合本模型而未收录。',
  })
  return out
}

if (import.meta.main) await main()
