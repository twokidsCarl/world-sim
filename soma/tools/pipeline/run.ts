// BodyParts3D -> runtime anatomy pipeline.
//   bun tools/pipeline/run.ts [--out <dir>] [--classify-only]
// Reads data/raw/bodyparts3d, writes public/anatomy/male/{anatomy.json,<system>.glb,pipeline-report.json}.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AnatomyData, Part, Provenance, SourceInfo, SystemDef, SystemId, TissueId } from '../../src/anatomy/types.ts'
import { computeAdjacency } from './adjacency.ts'
import { classify, sideFromName, sideOf, type Classification } from './classify.ts'
import { SIDE_OVERRIDES, SWAPPED_LABELS } from './corrections.ts'
import { computeExposure, type ExposureRole } from './exposure.ts'
import { compareNormals, computeNormals, measure, rotateToRuntime, simplifyMesh, sourceToRuntime, weld, type Mesh, type MeshStats } from './geometry.ts'
import { writeSystemGlb, type GlbPart } from './glb.ts'
import { depthOf, EXPOSURE_MAX_DISTANCE, LAYERS, SUPERFICIAL_EXPOSURE, usesExposure } from './layers.ts'
import { contentsInside, crossValidate, evaluateCandidates, IMPORT3_DEFAULTS, pairStructures, placeConcept, register3to4, SurfaceField, type ExistingPart, type Placement } from './import3.ts'
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
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString() }

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
  if (swap.size) console.log(`  source label corrections: swapped ${SWAPPED_LABELS.map(([a, b]) => `${a}↔${b}`).join(', ')}; side forced for ${Object.entries(SIDE_OVERRIDES).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  report.corrections = { swappedLabels: SWAPPED_LABELS, sideOverrides: SIDE_OVERRIDES }
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
        cls: classOf.get(c.part.id)!, isa: pl.isa, partOf: pl.partOf, provenance: 'warped', placement: pl,
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
    const simp = await simplifyMesh(e.mesh, err, floor)
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
  const data: AnatomyData = {
    schema: 1,
    body: 'male',
    sources: imported.length ? [SOURCE, SOURCE3] : [SOURCE],
    systems,
    layers: LAYERS.map((l) => ({ name: l.name })),
    parts,
    trees: { isa: isaTree, partOf: partOfTree },
  }
  const json = JSON.stringify(data)
  writeFileSync(join(stage, 'anatomy.json'), json)
  lap('wrote output')
  console.log(`\nOutput in ${outDir}`)
  console.log(`  anatomy.json ${(json.length / 1024).toFixed(0)} KB — ${parts.length} parts`)
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
  for (const f of readdirSync(outDir)) if (f.endsWith('.glb') && !staged.includes(f)) rmSync(join(outDir, f))
  rmSync(stage, { recursive: true, force: true })
  if (!existsSync(join(outDir, 'anatomy.json'))) throw new Error('output missing')
  lap('done')
}

if (import.meta.main) await main()
