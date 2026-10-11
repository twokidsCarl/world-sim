// BodyParts3D -> 运行时解剖数据管线。
//   bun tools/pipeline/run.ts [--out <dir>] [--classify-only]
// 读取 data/raw/bodyparts3d，写出 public/anatomy/male/{anatomy.json,<system>.glb,pipeline-report.json}。
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
import { canalFor, isaPathFromFma, localJointWarp, NERVE_BUILD_DEFAULTS, registerZa, syntheticConceptId, warpNerve, type JointCacheEntry, type TreePath } from './importZa.ts'
import { capHoles, envelopeOf } from './derive.ts'
import { checkSkinFit, internalsKey, loadSkinPackage } from './skinPackage.ts'
import { deriveFat, FAT_DEEP_TISSUES, FAT_OPTIONS, FAT_REGIONS, fatRegionOfBone, isFatPart } from './fat.ts'
import { PointIndex } from './register.ts'
import { nerveAgreement, runLandmarkChecks, type LandmarkResult } from './landmarks.ts'
import { InsideTester, surfacePoints, thinPoints } from './register.ts'
import type { Polyline } from './tube.ts'
import { displayName, hasZa, loadFmaNames, loadZa, type ZaItem } from './zanatomy.ts'
import { parseObj } from './obj.ts'
import { hasRelease3, loadRelease3, RAW3_DIR } from './release3.ts'
import { listObjFiles, loadTables, RAW_DIR } from './source.ts'
import { emitConcepts, type Ontology } from './tables.ts'

// ── 参数 / Parameters ────────────────────────────────────────────────────────────────────────────────
/**
 * 简化误差上限：部件厚度（3·V/A）的这一比例，并按下面的范围钳制。
 * Simplification error bound: this fraction of the part's thickness (3·V/A), clamped below.
 */
export const SIMPLIFY_ERROR_PER_THICKNESS = 0.08
export const SIMPLIFY_ERROR_MIN = 0.08e-3 // 米 / m
export const SIMPLIFY_ERROR_MAX = 0.8e-3 // 米 / m
/**
 * 三角形数不超过此值的部件一律不简化。
 * Parts at or below this many triangles are never simplified.
 */
export const SIMPLIFY_MIN_TRIANGLES = 400
/**
 * 简化后不得比“每个此边长（米）的等边三角形对应一个三角形”更粗。
 * Never coarser than one triangle per equilateral triangle of this edge length (m).
 */
export const SIMPLIFY_MAX_EDGE = 0.012
export const ADJACENCY_THRESHOLD = 0.002 // 米 / m
export const ADJACENCY_SPACING = 0.002 // 米 / m
/**
 * 接触部件数超过此值的部件是包络（皮肤）；完全不给它们计邻接。
 * Parts touching more parts than this are envelopes (the skin); they get no adjacency at all.
 */
export const ADJACENCY_MAX_DEGREE = 250
/**
 * 概念相同且包围盒相差在此值（米）以内 = 同一结构的重新三角化。
 * Same concept + bounds equal within this (m) = a re-tessellation of the same structure.
 */
const NEAR_DUPLICATE_BBOX = 0.0005
/** 人工否决的 3.0 版候选：文件 id -> 原因。 / Release 3.0 candidates vetoed by hand: file id -> reason. */
// 这些结构与 4.0 中已有的部件是同一结构，但归在不同的概念 id 下（4.0 有各部分而这里是整体，
// 4.0 有各成员而这里是集合，或概念被改名），并且由于 4.0 对它们重新建模，
// 它们与 4.0 几何的重合程度不足以通过自动冗余检测。
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
/**
 * 从 3.0 版导入的部件的 id 前缀（其文件按概念命名，而非按 FJ id）。
 * Id prefix of parts imported from release 3.0 (whose files are named by concept, not FJ id).
 */
export const R3_PREFIX = 'R3_'
// 3.0 版早于 4.0 归档在 2025 年发布的重新授权声明；它自带的 README 和每个 OBJ 文件头
// 仍写明 CC BY-SA 2.1 JP，所以导入部件记录的就是这一许可。
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
/** 男性外部皮肤包的位置（相对项目根） / where the male external skin package lives (relative to the project root) */
const MALE_SKIN_PACKAGE_DIR = 'data/raw/bodyshape/out/male-skin'
let externalSkinSource: SourceInfo | null = null

/** 肩带姿势校正的目标：盂肱关节（肱骨头中心）间距、锁骨上抬角；形变场作用范围（米） / targets of the shoulder posture correction: glenohumeral (humeral head centre) separation, clavicle elevation; reach of the field (m) */
const SHOULDER_GH_SEPARATION = 0.35
const SHOULDER_ELEVATION_DEG = 6
const SHOULDER_RETRACTION_DEG = 16
const SHOULDER_REACH = 0.12

const SOURCE_DERIVED: SourceInfo = {
  name: 'soma (derived)',
  url: 'https://github.com/',
  license: 'CC BY-SA 4.0',
  attribution: 'Computed by this project from neighbouring structures of the model (closed envelopes of organs); not taken from any atlas or scan.',
}
/**
 * 清理之后，若神经长度中位于它不该进入的骨内的比例超过此值，则不发布该神经……
 * A nerve is not shipped when, after clean-up, more than this share of its length is in bone it has no business in …
 */
const NERVE_MAX_IN_BONE = 0.15
/** ……或深入肌腹内部的比例超过此值。 / … or deep inside muscle bellies. */
const NERVE_MAX_DEEP_IN_MUSCLE = 0.4
/**
 * Z-Anatomy 网格的表面位于现有实体内的比例超过此值时不发布。
 * A Z-Anatomy mesh is not shipped with more than this share of its surface inside existing solids.
 */
const ZA_MAX_INSIDE = 0.6
/**
 * 按所连骨拟合的关节结构，其表面位于骨或软骨内的比例不超过此值时才发布。
 * A joint structure fitted to its bones is shipped with at most this share of its surface inside bone or cartilage.
 */
const JOINT_MAX_IN_BONE = 0.25
/**
 * FMA 链未与 4.0 树相遇、或没有 FMA id 的 Z-Anatomy 条目所用的 IS-A 概念（按名称）。
 * IS-A concept (by name) for Z-Anatomy items whose FMA chain does not meet the 4.0 tree or that have no FMA id.
 */
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
  /** 焊接后的源网格，运行时坐标系 / welded source mesh, runtime frame */
  mesh: Mesh
  stats: MeshStats
  sourceTriangles: number
  cls: Classification
  isa: string[]
  partOf: string[]
  provenance: Provenance
  /** 从 3.0 版导入的部件才设置 / set for parts imported from release 3.0 */
  placement?: Placement
  /** 几何不是来自第一个数据源时的 `SourceInfo.name` / `SourceInfo.name` when the geometry is not from the first source */
  source?: string
  /** 从 Z-Anatomy 包导入的部件在树中的位置 / tree positions of parts imported from the Z-Anatomy package */
  tree?: { isa: TreePath; partOf: TreePath | null }
  /** 神经部件的最终中心线（写入 nerves.json） / final centrelines of nerve parts (written to nerves.json) */
  centrelines?: Polyline[]
  /**
   * 几何是按需定制生成的（神经管）：不要对它运行简化器
   * geometry was built to measure (nerve tubes): do not run the simplifier over it
   */
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

  // ── 1. 表与文件 / 1. Tables and files ─────────────────────────────────────────────────────────────────────
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

  // 源标签修正：`tableId(el)` 是其表行/文件头描述 `el` 的那个元素。
  // Source label corrections: `tableId(el)` is the element whose table rows / header describe `el`.
  const swap = new Map<string, string>()
  for (const [a, b] of SWAPPED_LABELS) {
    if (files.has(a) && files.has(b)) {
      swap.set(a, b)
      swap.set(b, a)
    }
  }
  const headers = new Map<string, ReturnType<typeof parseObj>['header']>()

  // ── 2. 加载、焊接、测量、分类 / 2. Load, weld, measure, classify ────────────────────────────────────────────────────────
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
    // 17 个文件的文件头为空（没有名称/概念）：退而采用最具体的概念。
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
  // 互换的元素对交换名称和概念 id（两个文件头到这时才都已知）
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

  // ── 3. 重复件 / 3. Duplicates ───────────────────────────────────────────────────────────────────────────
  // 别名：被丢弃的元素 id -> 保留的元素 id / alias: dropped element id -> kept element id
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

  // 表中的元素 id -> 现在代表它的保留部件的 id（标签互换、合并的重复件）
  // table element id -> id of the kept part that now stands for it (label swaps, merged duplicates)
  const resolve = (el: string) => {
    const sw = swap.get(el) ?? el
    return alias.get(sw) ?? sw
  }

  // ── 3b. 导入 3.0 版 / 3b. Release 3.0 import ──────────────────────────────────────────────────────────────────
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
    // 左右孪生件共用同一判定：一个结构不会只发布一侧
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

    // 坐标系差异，按 3.0 身体的区域 / frame difference, by region of the 3.0 body
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
    // 包含关系：归在候选自身概念下的 4.0 元素应位于候选内部
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
    // 从整个肺来看：肺叶边界有移动，所以 4.0 的某个肺段可能落在相邻肺叶内
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

  // ── 3c. 导入 Z-Anatomy / Open3DModel（神经、淋巴结、甲状腺、韧带、筋膜） / 3c. Z-Anatomy / Open3DModel import (nerves, lymph nodes, thyroid, ligaments, fasciae) ────
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
    // 两侧的导入条目都用到的 FMA id / FMA ids used by imported items of both sides
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
      const itFma = it.proxyFor?.fma ?? it.fma
      if (itFma) {
        fma = itFma
        isa = isaPathFromFma(fma, fmaNames?.label.get(fma) ?? it.fmaLabel ?? displayName(it.name, it.side), (id) => fmaNames?.parents.get(id), (id) => fmaNames?.label.get(id), inIsa, fallback)
        // 归在不分侧类下的分侧条目（FMA 没有它的左/右类，或两侧被映射到同一个 id）：
        // 每一侧各得一个自己的概念 `<id>_L` / `<id>_R`，作为不分侧概念的子概念，
        // 这样名称就可以按侧别索引。
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
        // 没有 FMA 类：用合成概念，分侧概念挂在不分侧概念之下
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
      // 该包把半月板胫骨韧带/半月板髌骨韧带归为软骨
      // the package files the meniscotibial / meniscopatellar ligaments as cartilage
      if (it.category === 'ligament-bursa-fascia' && it.tissue === 'cartilage') return { system: 'skeletal', tissue: 'ligament' }
      // 第 2 批没有确定膜和甲的组织类型
      // batch 2 leaves the tissue of membranes and nails open
      const g = it.batchGroup ?? ''
      if (/nail/.test(g)) return { system: 'integumentary', tissue: 'skin' }
      if (/meninges/.test(g)) return { system: 'nervous', tissue: 'fascia' }
      if (/peritoneum/.test(g)) return { system: 'digestive', tissue: 'fascia' }
      if (/spinal cord/.test(g)) return { system: 'nervous', tissue: 'brain' }
      return { system: it.system as SystemId, tissue: (it.tissue === 'other' ? 'fascia' : it.tissue) as TissueId }
    }
    const makeElement = (it: ZaItem, mesh: Mesh, extra: Partial<Element> = {}): Element => {
      const cls = classOf(it)
      const { fma, tree } = treeOf(it, cls.tissue)
      return {
        id: it.id, name: displayName(it.proxyFor?.name ?? it.name, it.side), fma, mesh, stats: measure(mesh), sourceTriangles: it.triangles,
        cls: { ...cls, rule: 'Z-Anatomy package', signal: 'isa' }, isa: [], partOf: [], provenance: 'curated', source: sourceName(it), tree, ...extra,
      }
    }

    // 神经 / nerves
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
      // BodyParts3D 已有这条神经：保留它的部件，丢弃导入件，但测量两者的吻合程度
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
        // 神经节（没有中心线）以及中心线不完整的 8 条神经：直接对网格做形变
        // ganglia (no centreline) and the 8 nerves whose centrelines are incomplete: warp the mesh
        if (!it.files?.mesh) continue
        const src = pkg.mesh(it.files.mesh)
        const w = weld(def.apply(src.positions), src.indices)
        const mesh: Mesh = { positions: w.positions, indices: w.indices }
        importedZa.push(makeElement(it, mesh, warpedLines ? { centrelines: warpedLines.branches } : {}))
      }
    }
    lap(`warped ${nerveItems.length} nerves`)

    // 网格 / meshes
    const isSolid = (i: number) => SOLID_TISSUES.includes(field.parts[i]!.tissue)
    const isHard = (i: number) => HARD_TISSUES.includes(field.parts[i]!.tissue)
    const warpMesh = (it: ZaItem) => {
      const src = pkg.mesh(it.files!.mesh!)
      const def = reg.deformation(it.frame, it.side)
      return settle(weld(def.apply(src.positions), src.indices))
    }
    /**
     * 针对硬组织做碰撞清理，然后评估部件在现有实体之间的位置
     * collision clean-up against hard tissue, then how the part sits among the existing solids
     */
    const settle = (w: Mesh) => {
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
    // 第 2 批：只导入被要求的结构；下肢关节结构若两个图谱都有，采用 Open3DModel 的
    // （封闭网格、带角的半月板），其他部位采用 Z-Anatomy 的
    // batch 2: only the structures that were asked for; where both atlases have a lower-limb joint
    // structure the Open3DModel one is used (closed meshes, menisci with horns), elsewhere Z-Anatomy
    const LOWER_JOINT = /menisc|cruciate|Infrapatellar fat pad|capsule of (knee|hip|ankle) joint/i
    const o3dNames = new Set(pkg.items.filter((i) => i.batch === 2 && i.source === 'open3dmodel' && /^requested/.test(i.batchGroup ?? '')).map((i) => `${i.name}|${i.side}`))
    const batch2Skip = (i: ZaItem): string | null => {
      if (/pleura/.test(i.batchGroup ?? '')) return 'both pleural layers are offsets of one lung-shaped atlas surface; the pleura is derived from our own lungs instead'
      if (i.name === 'Mesocolon') return 'duplicates the transverse mesocolon of BodyParts3D'
      if (i.name === 'Sigmoid colon') return 'duplicates the distal part of BodyParts3D "Descending colon"'
      if (i.source === 'z-anatomy' && LOWER_JOINT.test(i.name) && o3dNames.has(`${i.name}|${i.side}`)) return 'the Open3DModel version is used'
      if (i.source === 'open3dmodel' && i.alternateOf && !LOWER_JOINT.test(i.name)) return 'the Z-Anatomy version is used'
      return null
    }
    const meshItems = pkg.items.filter((i) => i.kind === 'mesh' && !i.candidate && i.files?.mesh && (['endocrine', 'lymph', 'ligament-bursa-fascia'].includes(i.category ?? '') || (i.batch === 2 && /^requested/.test(i.batchGroup ?? ''))))
    const meshRows: Record<string, unknown>[] = []
    const jointCache = new Map<string, JointCacheEntry>()
    const jointRows: { id: string; name: string; source: string; before: Record<string, number> | null; after: Record<string, unknown>; ends: { bone: string; gapMm: number; atlasGapMm: number }[]; shipped: boolean }[] = []
    const lymphRows: { id: string; name: string; insideBefore: number; in: string[]; movedMm: number | null; insideAfter: number | null }[] = []
    const DIRS26: number[][] = []
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      if (!x && !y && !z) continue
      const l = Math.hypot(x, y, z)
      DIRS26.push([x / l, y / l, z / l])
    }
    // 在体内 = 该点的前方和后方都能遇到皮肤
    // inside the body = the skin is met both in front of and behind the point
    const skinPart = existing.find((e) => e.name === 'Skin' && e.tissue === 'skin')
    const insideBody = (pts: Float32Array): number => {
      if (!skinPart) return 1
      const p = skinPart.mesh.positions
      const idx = skinPart.mesh.indices
      let b = [Infinity, Infinity, -Infinity, -Infinity]
      for (let i = 0; i < pts.length; i += 3) b = [Math.min(b[0]!, pts[i]!), Math.min(b[1]!, pts[i + 1]!), Math.max(b[2]!, pts[i]!), Math.max(b[3]!, pts[i + 1]!)]
      const tris: number[] = []
      for (let t = 0; t < idx.length; t += 3) {
        const a = 3 * idx[t]!
        const c = 3 * idx[t + 1]!
        const d = 3 * idx[t + 2]!
        if (Math.max(p[a]!, p[c]!, p[d]!) < b[0]! || Math.min(p[a]!, p[c]!, p[d]!) > b[2]! || Math.max(p[a + 1]!, p[c + 1]!, p[d + 1]!) < b[1]! || Math.min(p[a + 1]!, p[c + 1]!, p[d + 1]!) > b[3]!) continue
        tris.push(a, c, d)
      }
      let ok = 0
      for (let i = 0; i < pts.length; i += 3) {
        const x = pts[i]! + 1.3e-7
        const y = pts[i + 1]! + 0.7e-7
        const z = pts[i + 2]!
        let front = false
        let back = false
        for (let t = 0; t < tris.length && !(front && back); t += 3) {
          const a = tris[t]!
          const c = tris[t + 1]!
          const d = tris[t + 2]!
          const w0 = (p[c]! - x) * (p[d + 1]! - y) - (p[c + 1]! - y) * (p[d]! - x)
          const w1 = (p[d]! - x) * (p[a + 1]! - y) - (p[d + 1]! - y) * (p[a]! - x)
          const w2 = (p[a]! - x) * (p[c + 1]! - y) - (p[a + 1]! - y) * (p[c]! - x)
          if (!((w0 > 0 && w1 > 0 && w2 > 0) || (w0 < 0 && w1 < 0 && w2 < 0))) continue
          const hz = (w0 * p[a + 2]! + w1 * p[c + 2]! + w2 * p[d + 2]!) / (w0 + w1 + w2)
          if (hz > z) front = true
          else back = true
        }
        if (front && back) ok++
      }
      return pts.length ? ok / (pts.length / 3) : 1
    }
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
      const kind = it.category ?? it.batchGroup ?? 'mesh'
      if (it.batch === 2) {
        const skip = batch2Skip(it)
        if (skip) {
          dropped.push({ id: it.id, name, kind, reason: `not imported: ${skip}` })
          continue
        }
      } else if (it.source === 'z-anatomy' && LOWER_JOINT.test(it.name) && o3dNames.has(`${it.name}|${it.side}`)) {
        dropped.push({ id: it.id, name, kind, reason: 'not imported: the Open3DModel version is used' })
        continue
      }
      const jointish = classOf(it).system === 'skeletal'
      const tryJoint = (before: { inside: number; deep: number; byTissue: Record<string, number> } | null): boolean => {
        const src = pkg.mesh(it.files!.mesh!)
        const fit = localJointWarp(src, it.frame, it.side, pkg, field, jointCache)
        if (!fit) return false
        const j = settle(weld(fit.positions, src.indices))
        const ends = fit.bones.map((bn) => {
          const idx = bn.bp3dIds.map((id) => field.surfaceIndex(existing.findIndex((e) => e.id === id)))
          let d = Infinity
          for (let i = 0; i < j.mesh.positions.length; i += 3) for (const t of idx) d = Math.min(d, t.distance(j.mesh.positions[i]!, j.mesh.positions[i + 1]!, j.mesh.positions[i + 2]!, 0.03))
          return { bone: `${bn.side === 'M' ? '' : bn.side === 'L' ? 'left ' : 'right '}${bn.name.toLowerCase()}`, gapMm: round(d * 1000, 2), atlasGapMm: round(bn.sourceGap * 1000, 2) }
        })
        const inBone = (j.byTissue.bone ?? 0) + (j.byTissue.cartilage ?? 0) + (j.byTissue.tooth ?? 0)
        // 按它所属的骨来评判：大部分在骨外，两端各在图谱所示的位置
        // judged by the bones it belongs to: mostly outside them, each end where the atlas has it
        const ok = inBone <= JOINT_MAX_IN_BONE && ends.every((e) => e.gapMm <= e.atlasGapMm + 3)
        jointRows.push({ id: it.id, name, source: sourceName(it), before: before ? { inside: round(before.inside, 3), deep: round(before.deep, 3), inBone: round((before.byTissue.bone ?? 0) + (before.byTissue.cartilage ?? 0), 3) } : null, after: { inside: round(j.inside, 3), deep: round(j.deep, 3), inBone: round(inBone, 3), in: j.top }, ends, shipped: ok })
        if (ok) importedZa.push(makeElement(it, j.mesh))
        return ok
      }
      // 第 2 批的关节结构直接采用关节局部拟合
      // joint structures of batch 2 go straight to the joint-local fit
      if (jointish && it.batch === 2 && tryJoint(null)) continue
      const w = warpMesh(it)
      meshRows.push({ id: it.id, name, category: it.category, inside: round(w.inside, 4), deep: round(w.deep, 4), byTissue: w.byTissue, pushed: round(w.pushed, 4), top: w.top })
      if (w.deep > IMPORT3_DEFAULTS.maxDeepInside || w.inside > ZA_MAX_INSIDE) {
        // 第二次机会 (a)：跨骨的部件只按这些骨来拟合
        // second chance (a): a part that spans bones is fitted to those bones alone
        if (jointish && it.batch !== 2 && tryJoint(w)) continue
        // 第二次机会 (b)：淋巴结整体移到最近的空位
        // second chance (b): a lymph node is moved, whole, to the nearest free spot
        if (it.category === 'lymph') {
          const pts0 = thinPoints(surfacePoints(w.mesh, 0.002), 0.0015)
          const at = (t: number[]) => {
            const pts = Float32Array.from(pts0, (v, i) => v + t[i % 3]!)
            const bb = w.stats.bbox.map((v, i) => v + t[i % 3]!)
            const ov = overlapWith(pts, bb, field, IMPORT3_DEFAULTS.nearDistance, IMPORT3_DEFAULTS.deepDistance, isSolid)
            return { inside: ov.insideAny, deep: ov.deepAny, inBody: insideBody(pts) }
          }
          let best: { t: number[]; len: number; inside: number } | null = null
          for (let step = 1; step <= 15 && !best; step++) {
            const len = step * 0.002
            for (const d of DIRS26) {
              const t = d.map((v) => v * len)
              const r = at(t)
              if (r.inside <= 0.1 && r.deep <= 0.01 && r.inBody >= 0.99 && (!best || r.inside < best.inside)) best = { t, len, inside: r.inside }
            }
          }
          lymphRows.push({ id: it.id, name, insideBefore: round(w.inside, 3), in: w.top, movedMm: best ? round(best.len * 1000, 0) : null, insideAfter: best ? round(best.inside, 3) : null })
          if (best) {
            const moved: Mesh = { positions: Float32Array.from(w.mesh.positions, (v, i) => v + best!.t[i % 3]!), indices: w.mesh.indices }
            importedZa.push(makeElement(it, moved))
            continue
          }
        }
        dropped.push({ id: it.id, name, kind, reason: `misplaced: ${(w.inside * 100).toFixed(0)}% of its surface inside existing solids, ${(w.deep * 100).toFixed(0)}% deeper than ${IMPORT3_DEFAULTS.deepDistance * 1000} mm (${w.top.join(', ')})` })
        continue
      }
      importedZa.push(makeElement(it, w.mesh))
    }
    // 孪生件共用同一判定 / twins share a verdict
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

    console.log(`\nJoint-local registration (parts fitted to the bones they attach to; "in bone" before = with the body-wide field, where that was tried): ${jointRows.filter((r) => r.shipped).length} of ${jointRows.length} placed`)
    for (const r of jointRows) console.log(`  ${r.shipped ? 'ok  ' : 'DROP'} ${pad(r.name.slice(0, 50), 51)}in bone ${r.before ? (r.before.inBone! * 100).toFixed(0) + '% → ' : ''}${((r.after.inBone as number) * 100).toFixed(0)}%, in any solid ${r.before ? (r.before.inside! * 100).toFixed(0) + '% → ' : ''}${((r.after.inside as number) * 100).toFixed(0)}%; ends: ${r.ends.map((e) => `${e.bone} ${e.gapMm} (atlas ${e.atlasGapMm})`).join(', ')}`)
    console.log(`\nLymph nodes moved to free space: ${lymphRows.filter((r) => r.movedMm !== null).length} of ${lymphRows.length}: ${lymphRows.map((r) => `${r.name} ${r.movedMm === null ? 'NOT PLACED' : r.movedMm + ' mm'}`).join('; ')}`)
    // 报告 / report
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

    // 按要求做的备选比较：腹横肌（3.0 版对 Z-Anatomy）与胸膜
    // fallback comparisons asked for: transversus abdominis (3.0 vs Z-Anatomy) and the pleura
    const comparisons: Record<string, unknown>[] = []
    console.log('\nZ-Anatomy fallbacks compared (not imported unless stated)')
    for (const it of pkg.items.filter((i) => i.kind === 'mesh' && !i.candidate && i.files?.mesh && (/^Transversus abdominis/.test(i.name) || i.name === 'Pleura'))) {
      const name = displayName(it.name, it.side)
      // 与除它将要替换的 3.0 部件之外的所有部件比较
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

    // 脊髓：应位于椎管内，且各神经根仍与其相接
    // spinal cord: inside the vertebral canal, and the root units still meet it
    {
      let cordCaps = 0
      const cord = importedZa.find((e) => e.name === 'Spinal cord')
      if (cord) {
        // 图谱中的脊髓是两端开口的管，这里封口 / the atlas cord is a tube open at both ends: cap it
        const welded = weld(cord.mesh.positions, cord.mesh.indices)
        const capped = capHoles({ positions: welded.positions, indices: welded.indices })
        if (capped.holes) {
          cord.mesh = capped.mesh
          cord.stats = measure(capped.mesh)
          cord.sourceTriangles = capped.mesh.indices.length / 3
        }
        cordCaps = capped.holes
        const pts = thinPoints(surfacePoints(cord.mesh, 0.003), 0.002)
        const ov = overlapWith(pts, cord.stats.bbox, field, 0.002, 0.004, (i) => HARD_TISSUES.includes(field.parts[i]!.tissue))
        const idx = new PointIndex(thinPoints(surfacePoints(cord.mesh, 0.0015), 0.001), 0.004)
        const gaps: { name: string; mm: number }[] = []
        for (const e of importedZa) {
          if (!e.centrelines || !/(anterior|posterior) root of [CTL]\d+ spinal nerve/i.test(e.name)) continue
          let d = Infinity
          for (const l of e.centrelines) for (let i = 0; i < l.points.length; i += 3) d = Math.min(d, idx.distance(l.points[i]!, l.points[i + 1]!, l.points[i + 2]!))
          gaps.push({ name: e.name, mm: round(d * 1000, 2) })
        }
        const g = gaps.map((x) => x.mm).sort((a, b) => a - b)
        const worst = [...gaps].sort((a, b) => b.mm - a.mm).slice(0, 5)
        console.log(`\nSpinal cord (Z-Anatomy, procedural): ${(ov.insideAny * 100).toFixed(1)}% of its surface inside bone or cartilage (${[...ov.inside].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([i, f]) => `${field.parts[i]!.name} ${(f * 100).toFixed(1)}%`).join(', ') || '-'}); spans y ${cord.stats.bbox[1].toFixed(3)}…${cord.stats.bbox[4].toFixed(3)} m; ${gaps.length} spinal root units start ${g[Math.floor(g.length / 2)] ?? '-'} mm (median) from its surface, max ${g[g.length - 1] ?? '-'} mm (${worst.map((x) => `${x.name} ${x.mm}`).join(', ')})`)
        report.spinalCord = { openEndsCapped: cordCaps, closedVolumeMl: round(Math.abs(cord.stats.signedVolume) * 1e6, 1), surfaceInBone: round(ov.insideAny, 4), yRange: [round(cord.stats.bbox[1], 3), round(cord.stats.bbox[4], 3)], roots: gaps.length, rootGapMedianMm: g[Math.floor(g.length / 2)] ?? null, rootGapMaxMm: g[g.length - 1] ?? null, rootGaps: gaps }
      }
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
      meshes: meshRows, comparisons, jointRefits: jointRows, lymphMoved: lymphRows,
      placement: importedZa.map((e) => ({ id: e.id, fma: e.fma, isaHow: e.tree!.isa.how, isaAnchor: e.tree!.isa.anchor ? tables.isa.name.get(e.tree!.isa.anchor) : null, isaPath: e.tree!.isa.path.map(([, n]) => n), partOf: !!e.tree!.partOf })),
    }
  }

  // ── 3c′. 肩带姿势校正 / shoulder girdle posture correction ───────────────────────────────────
  // BodyParts3D 的锁骨长度正常，但姿势是仰卧成像时的样子：上抬约 15°、后缩约 33°，两侧肱骨头中心只相距约 327 mm。
  // 每侧锁骨绕其胸骨端向前、向下转（不缩放任何骨），使盂肱关节间距达到约 350 mm；肩胛骨和整条上肢的骨
  // 随锁骨肩峰端平移，周围的软组织（肩部肌、臂丛、腋血管和锁骨下血管、皮肤）随由骨表面锚点建立的局部形变场移动。
  // The BodyParts3D clavicles have a normal length but the posture of supine imaging: raised by about
  // 15° and drawn back by about 33°, the humeral head centres only about 327 mm apart. Each clavicle
  // is turned forwards and downwards about its sternal end (no bone is scaled) until the glenohumeral
  // separation is about 350 mm; the scapula and the bones of the whole upper limb are translated with
  // the acromial end of the clavicle, and the soft tissue around them (shoulder muscles, brachial
  // plexus, axillary and subclavian vessels, skin) follows a local field built from anchors on the bone surfaces.
  // 默认不启用：按现在的做法，肩胛骨会贴进肋骨（间距 p10 由 6–7 mm 降到约 2 mm），桡神经沟处的检查也不过；
  // 设 SOMA_SHOULDER_FIX=1 才执行。
  // Off by default: as it stands the scapula ends up against the ribs (p10 gap from 6–7 mm down to about
  // 2 mm) and the radial-groove landmark check fails; it runs only with SOMA_SHOULDER_FIX=1.
  if (process.env.SOMA_SHOULDER_FIX) {
    const bones = kept.filter((e) => e.cls.tissue === 'bone')
    const one = (name: string) => bones.find((e) => e.name === name)
    const headCentre = (e: Element): [number, number, number] => {
      // 肱骨头中心：取近端 14 % 的顶点质心（与校正前后的差值无关紧要，只要前后一致）
      // humeral head centre: centroid of the proximal 14 % of the vertices (the same definition before and after is what matters)
      const p = e.mesh.positions
      const top = e.stats.bbox[4] - 0.14 * (e.stats.bbox[4] - e.stats.bbox[1])
      const c: [number, number, number] = [0, 0, 0]
      let n = 0
      for (let i = 0; i < p.length; i += 3) if (p[i + 1]! > top) {
        c[0] += p[i]!
        c[1] += p[i + 1]!
        c[2] += p[i + 2]!
        n++
      }
      return [c[0] / n, c[1] / n, c[2] / n]
    }
    const hl = one('Left humerus')
    const hr = one('Right humerus')
    const row: Record<string, unknown> = {}
    if (hl && hr && one('Left clavicle') && one('Right clavicle')) {
      const sep0 = headCentre(hl)[0] - headCentre(hr)[0]
      const from: Float32Array[] = []
      const to: Float32Array[] = []
      const boneMap = new Map<string, (x: number, y: number, z: number) => [number, number, number]>()
      const sides: Record<string, unknown> = {}
      for (const [Name, sgn] of [['Left', 1], ['Right', -1]] as const) {
        const cl = one(`${Name} clavicle`)!
        const p = cl.mesh.positions
        let sc = 0
        let lat = 0
        for (let i = 0; i < p.length / 3; i++) {
          if (sgn * p[3 * i]! < sgn * p[3 * sc]!) sc = i
          if (sgn * p[3 * i]! > sgn * p[3 * lat]!) lat = i
        }
        const S0 = [p[3 * sc]!, p[3 * sc + 1]!, p[3 * sc + 2]!] as const
        const u = [p[3 * lat]! - S0[0], p[3 * lat + 1]! - S0[1], p[3 * lat + 2]! - S0[2]]
        const len = Math.hypot(u[0]!, u[1]!, u[2]!)
        const elev0 = Math.asin(u[1]! / len)
        const retr0 = Math.atan2(-u[2]!, sgn * u[0]!)
        // 上抬角降到目标值（原本更低则不动）；后缩角用二分法求，使肱骨头中心外移 dx。
        // 肩胛骨随锁骨绕胸骨端做同一个刚性旋转（前伸时肩胛骨绕胸廓滑向前外侧，而不是平移进肋骨）。
        // Elevation comes down to the target (left alone if already lower); retraction is found by
        // bisection so that the humeral head centre moves outwards by dx. The scapula takes the same
        // rigid rotation about the sternal end as the clavicle (in protraction the scapula glides
        // forwards and outwards round the rib cage instead of being pushed into the ribs).
        const elev1 = Math.min(elev0, (SHOULDER_ELEVATION_DEG * Math.PI) / 180)
        const e0 = u.map((v) => v / len)
        const rotationFor = (retr: number) => {
          const e1 = [sgn * Math.cos(elev1) * Math.cos(retr), Math.sin(elev1), -Math.cos(elev1) * Math.sin(retr)]
          const axr = [e0[1]! * e1[2]! - e0[2]! * e1[1]!, e0[2]! * e1[0]! - e0[0]! * e1[2]!, e0[0]! * e1[1]! - e0[1]! * e1[0]!]
          const sin = Math.hypot(axr[0]!, axr[1]!, axr[2]!)
          const cos = e0[0]! * e1[0]! + e0[1]! * e1[1]! + e0[2]! * e1[2]!
          const ax = sin > 1e-9 ? axr.map((v) => v / sin) : [0, 1, 0]
          return (x: number, y: number, z: number): [number, number, number] => {
            const q = [x - S0[0], y - S0[1], z - S0[2]]
            const cr = [ax[1]! * q[2]! - ax[2]! * q[1]!, ax[2]! * q[0]! - ax[0]! * q[2]!, ax[0]! * q[1]! - ax[1]! * q[0]!]
            const ad = (ax[0]! * q[0]! + ax[1]! * q[1]! + ax[2]! * q[2]!) * (1 - cos)
            return [S0[0] + q[0]! * cos + cr[0]! * sin + ax[0]! * ad, S0[1] + q[1]! * cos + cr[1]! * sin + ax[1]! * ad, S0[2] + q[2]! * cos + cr[2]! * sin + ax[2]! * ad]
          }
        }
        // 后缩角降到目标值（原本更小则不动）。只靠转动锁骨把盂肱间距加到 350 mm 需要把后缩角减到约 11°，
        // 肩会前移 3 cm 以上并把肩胛骨推进肋骨；这里取解剖上常见的站立位角度，达不到的部分如实报告。
        // Retraction comes down to the target (left alone if already smaller). Reaching 350 mm between
        // the glenohumeral joints by turning the clavicles alone would need a retraction of about 11°,
        // which carries the shoulders more than 3 cm forwards and pushes the scapulae into the ribs;
        // the usual standing angles are used instead and the shortfall is reported.
        const retr1 = Math.min(retr0, (SHOULDER_RETRACTION_DEG * Math.PI) / 180)
        const rot = rotationFor(retr1)
        // 肩胛骨随锁骨绕胸骨端做同一个刚性旋转（沿胸廓滑动，而不是平移进肋骨）；上肢各骨按肱骨头中心的位移平移
        // the scapula takes the clavicle's rigid rotation about the sternal end (gliding round the rib cage rather than being pushed into the ribs); the bones of the upper limb are translated by the displacement of the humeral head centre
        const hc = headCentre(one(`${Name} humerus`)!)
        const hc1 = rot(hc[0], hc[1], hc[2])
        const d: [number, number, number] = [hc1[0] - hc[0], hc1[1] - hc[1], hc1[2] - hc[2]]
        boneMap.set(cl.id, rot)
        const scap = one(`${Name} scapula`)
        if (scap) boneMap.set(scap.id, rot)
        const ARM = new RegExp(`^${Name} (humerus|radius|ulna|scaphoid|lunate|triquetral|pisiform|trapezium|trapezoid|capitate|hamate)$|${Name.toLowerCase()} (thumb|index finger|middle finger|ring finger|little finger)|^${Name} (first|second|third|fourth|fifth) metacarpal`, 'i')
        for (const e of bones) if (ARM.test(e.name)) boneMap.set(e.id, (x, y, z) => [x + d[0], y + d[1], z + d[2]])
        sides[Name.toLowerCase()] = { clavicleLengthMm: round(len * 1000, 1), elevationDeg: [round((elev0 * 180) / Math.PI, 1), round((elev1 * 180) / Math.PI, 1)], retractionDeg: [round((retr0 * 180) / Math.PI, 1), round((retr1 * 180) / Math.PI, 1)], humeralHeadMovedMm: d.map((v) => round(v * 1000, 1)) }
      }
      const apply = (f: (x: number, y: number, z: number) => [number, number, number], pts: Float32Array) => {
        const out = new Float32Array(pts.length)
        for (let i = 0; i < pts.length; i += 3) {
          const q = f(pts[i]!, pts[i + 1]!, pts[i + 2]!)
          out[i] = q[0]
          out[i + 1] = q[1]
          out[i + 2] = q[2]
        }
        return out
      }
      // 肩胛骨与肋骨的最小间距（校正前后） / smallest scapula-to-rib distance (before and after)
      const ribs = bones.filter((e) => /\brib$/i.test(e.name))
      const ribIndex = new PointIndex(Float32Array.from(ribs.flatMap((e) => Array.from(thinPoints(surfacePoints(e.mesh, 0.003), 0.003)))), 0.01)
      const scapGap = (name: string) => {
        const sp = thinPoints(surfacePoints(one(name)!.mesh, 0.004), 0.004)
        const dd: number[] = []
        for (let i = 0; i < sp.length; i += 3) dd.push(ribIndex.distance(sp[i]!, sp[i + 1]!, sp[i + 2]!, 0.1))
        dd.sort((a, b) => a - b)
        return { minMm: round(dd[0]! * 1000, 1), p10Mm: round(dd[Math.floor(dd.length / 10)]! * 1000, 1) }
      }
      const gapBefore = { left: scapGap('Left scapula'), right: scapGap('Right scapula') }
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
      for (const e of bones) {
        const a = thinPoints(surfacePoints(e.mesh, 0.006), 0.006)
        const f = boneMap.get(e.id)
        from.push(a)
        to.push(f ? apply(f, a) : a)
        if (f) for (let k = 0; k < 3; k++) {
          b[k] = Math.min(b[k]!, e.stats.bbox[k]! - SHOULDER_REACH)
          b[k + 3] = Math.max(b[k + 3]!, e.stats.bbox[k + 3]! + SHOULDER_REACH)
        }
      }
      const cat = (list: Float32Array[]) => {
        const out = new Float32Array(list.reduce((n, a) => n + a.length, 0))
        let o = 0
        for (const a of list) {
          out.set(a, o)
          o += a.length
        }
        return out
      }
      // 局部形变场：每个点取最近的“被移动的骨”表面点的位移，再按它到被移动的骨和到不动的骨的距离
      // 以 1/(d + 2 mm)⁴ 加权（贴着肱骨的桡神经完全随肱骨走，贴着肋骨的组织不动，腋窝处平滑过渡）。
      // The local field: a point takes the displacement of the nearest surface point of a moved bone,
      // weighted against the nearest unmoved bone by 1/(d + 2 mm)⁴ (the radial nerve on the humerus
      // follows the humerus entirely, tissue on the ribs stays, the axilla passes smoothly between).
      const allFrom = cat(from)
      const allTo = cat(to)
      const mv: number[] = []
      const mvD: number[] = []
      const st: number[] = []
      for (let i = 0; i < allFrom.length; i += 3) {
        const dxx = allTo[i]! - allFrom[i]!
        const dyy = allTo[i + 1]! - allFrom[i + 1]!
        const dzz = allTo[i + 2]! - allFrom[i + 2]!
        if (dxx || dyy || dzz) {
          mv.push(allFrom[i]!, allFrom[i + 1]!, allFrom[i + 2]!)
          mvD.push(dxx, dyy, dzz)
        } else st.push(allFrom[i]!, allFrom[i + 1]!, allFrom[i + 2]!)
      }
      const mvIndex = new PointIndex(Float32Array.from(mv), 0.02)
      const stIndex = new PointIndex(Float32Array.from(st), 0.02)
      const NI = new Int32Array(1)
      const ND = new Float64Array(1)
      const fieldG = {
        apply(pts: Float32Array): Float32Array {
          const out = Float32Array.from(pts)
          for (let i = 0; i < pts.length; i += 3) {
            if (!mvIndex.nearest(pts[i]!, pts[i + 1]!, pts[i + 2]!, 1, NI, ND, SHOULDER_REACH)) continue
            const q = 3 * NI[0]!
            const dm = Math.sqrt(ND[0]!)
            const ds = stIndex.distance(pts[i]!, pts[i + 1]!, pts[i + 2]!, 0.3)
            const wm = 1 / (dm + 0.002) ** 4
            const ws = 1 / (ds + 0.002) ** 4
            // 在作用范围边缘平滑收到零 / fades smoothly to zero at the edge of the reach
            const edge = Math.min(1, (SHOULDER_REACH - dm) / 0.02)
            const w = (wm / (wm + ws)) * edge
            out[i] = pts[i]! + w * mvD[q]!
            out[i + 1] = pts[i + 1]! + w * mvD[q + 1]!
            out[i + 2] = pts[i + 2]! + w * mvD[q + 2]!
          }
          return out
        },
      }
      let moved = 0
      for (const e of kept) {
        const f = boneMap.get(e.id)
        const eb = e.stats.bbox
        if (!f && (e.cls.tissue === 'bone' || eb[0] > b[3]! || eb[3] < b[0]! || eb[1] > b[4]! || eb[4] < b[1]! || eb[2] > b[5]! || eb[5] < b[2]!)) continue
        e.mesh = { positions: f ? apply(f, e.mesh.positions) : fieldG.apply(e.mesh.positions), indices: e.mesh.indices }
        e.stats = measure(e.mesh)
        if (e.centrelines) e.centrelines = e.centrelines.map((l) => ({ points: fieldG.apply(l.points), radius: l.radius }))
        moved++
      }
      const sep1 = headCentre(hl)[0] - headCentre(hr)[0]
      Object.assign(row, { glenohumeralSeparationMm: [round(sep0 * 1000, 1), round(sep1 * 1000, 1)], targetMm: SHOULDER_GH_SEPARATION * 1000, sides, scapulaToRibs: { before: gapBefore, after: { left: scapGap('Left scapula'), right: scapGap('Right scapula') } }, partsMoved: moved })
      console.log(`\nShoulder girdle: glenohumeral separation ${(sep0 * 1000).toFixed(1)} → ${(sep1 * 1000).toFixed(1)} mm; ${JSON.stringify(sides)}; scapula to ribs ${JSON.stringify(row.scapulaToRibs)}; ${moved} parts moved`)
    }
    report.shoulderGirdle = row
    lap('shoulder girdle posture')
  }

  // ── 3d. 由我们自身几何推导的结构 / 3d. Structures derived from our own geometry ────────────────────────────────────────────
  // 没有哪个图谱能与本体吻合的薄壳：按它们所覆盖器官的封闭包络计算。
  // 标记为 `curated`，数据源为 "soma (derived)"。
  // Thin shells that no atlas fits to this body: computed as closed envelopes of the organs they
  // cover. Labelled `curated`, source "soma (derived)".
  const derived: Element[] = []
  {
    const fmaNames = loadFmaNames()
    const isaIdByName = new Map<string, string>()
    for (const [id, n] of tables.isa.name) if (!isaIdByName.has(n)) isaIdByName.set(n, id)
    const make = (id: string, fma: string, name: string, system: SystemId, of: Element[], offset: number): Record<string, unknown> | null => {
      if (!of.length) return null
      const mesh = envelopeOf(of.map((e) => e.mesh), { voxel: 0.002, offset, smooth: 4 })
      if (!mesh.indices.length) return null
      const isa = isaPathFromFma(fma, fmaNames?.label.get(fma) ?? name, (c) => fmaNames?.parents.get(c), (c) => fmaNames?.label.get(c), (c) => tables.isa.name.has(c), isaIdByName.get('organ component') ?? null)
      derived.push({ id, name, fma, mesh, stats: measure(mesh), sourceTriangles: mesh.indices.length / 3, cls: { system, tissue: 'fascia', rule: 'derived', signal: 'none' }, isa: [], partOf: [], provenance: 'curated', source: SOURCE_DERIVED.name, tree: { isa, partOf: null } })
      // 检查：它所覆盖的结构在它内部；它不进入骨内
      // checks: what it covers is inside it; it stays out of bone
      const tester = new InsideTester(mesh, 96)
      let inside = 0
      let total = 0
      for (const e of of) {
        const pts = thinPoints(surfacePoints(e.mesh, 0.004), 0.003)
        inside += tester.fractionInside(pts) * pts.length
        total += pts.length
      }
      const sp = thinPoints(surfacePoints(mesh, 0.004), 0.003)
      let inBone = 0
      const b = measure(mesh).bbox
      for (const e of kept) {
        if (e.cls.tissue !== 'bone' && e.cls.tissue !== 'cartilage') continue
        const eb = e.stats.bbox
        if (eb[0] > b[3] || eb[3] < b[0] || eb[1] > b[4] || eb[4] < b[1] || eb[2] > b[5] || eb[5] < b[2]) continue
        inBone += new InsideTester(e.mesh, 48).fractionInside(sp)
      }
      const st = measure(mesh)
      return { id, name, from: of.map((e) => e.name), offsetMm: offset * 1000, triangles: mesh.indices.length / 3, areaCm2: round(st.area * 1e4, 0), volumeMl: round(Math.abs(st.signedVolume) * 1e6, 0), contentInside: round(total ? inside / total : 0, 4), surfaceInBone: round(inBone, 4) }
    }
    const rows = [
      make('SOMA_visceral_pleura_L', 'FMA27311', 'Left visceral pleura', 'respiratory', kept.filter((e) => /lobe of left lung/i.test(e.name)), 0.002),
      make('SOMA_visceral_pleura_R', 'FMA27310', 'Right visceral pleura', 'respiratory', kept.filter((e) => /lobe of right lung|^Middle lobe of lung$/i.test(e.name)), 0.002),
      make('SOMA_pericardium', 'FMA9868', 'Pericardial sac', 'cardiovascular', kept.filter((e) => e.cls.system === 'cardiovascular' && (e.cls.tissue === 'heart' || e.cls.tissue === 'space') && !/cusp|leaflet|papillary/i.test(e.name)), 0.004),
    ].filter((r): r is Record<string, unknown> => !!r)
    kept.push(...derived)
    if (rows.length) {
      console.log('\nDerived shells (closed envelopes of our own organs, 2 mm voxels)')
      for (const r of rows) console.log(`  ${pad(r.name as string, 24)}${r.offsetMm} mm outside ${(r.from as string[]).length} parts; ${r.triangles} triangles, ${r.areaCm2} cm², encloses ${r.volumeMl} ml; ${((r.contentInside as number) * 100).toFixed(1)}% of the covered organs' surface inside it; ${((r.surfaceInBone as number) * 100).toFixed(1)}% of its surface inside bone or cartilage`)
    }
    report.derived = rows

    // 皮下脂肪：皮肤内壁与深部包络（肌、骨、软骨、器官）之间的空间，按区域切分。见 fat.ts。
    // Subcutaneous fat: the space between the inner wall of the skin and the deep envelope
    // (muscle, bone, cartilage, organs), cut by region. See fat.ts.
    const skinEl = kept.find((e) => e.name === 'Skin' && e.cls.tissue === 'skin')
    // 外部皮肤包（见 skinPackage.ts）：只有当包声明它是按本次内部结构拟合的（fittedTo.key 与指纹一致）才装入。
    // 同时报告男性外生殖器各部件伸出骨盆前方多远，供拟合皮肤时把它们包在皮肤之内。
    // External skin package (see skinPackage.ts): installed only when the package says it was fitted to
    // these internals (fittedTo.key equals the fingerprint). Also reported: how far the male external
    // genital parts reach in front of the pelvis, so that a fitted skin can enclose them.
    if (skinEl) {
      const key = internalsKey(kept.filter((e) => e.cls.tissue === 'bone').map((e) => ({ name: e.name, bbox: e.stats.bbox })))
      const pkg = loadSkinPackage(join(ROOT, MALE_SKIN_PACKAGE_DIR))
      const row: Record<string, unknown> = { dir: MALE_SKIN_PACKAGE_DIR, internalsKey: key, present: !!pkg, fittedTo: pkg?.fittedTo ?? null, installed: false }
      if (pkg && pkg.fittedTo?.body === 'male' && pkg.fittedTo.key === key) {
        skinEl.mesh = pkg.mesh
        skinEl.stats = measure(pkg.mesh)
        skinEl.sourceTriangles = pkg.mesh.indices.length / 3
        skinEl.provenance = 'curated'
        skinEl.source = pkg.source.name
        externalSkinSource = pkg.source
        const fit = checkSkinFit(pkg.mesh, kept.filter((e) => FAT_DEEP_TISSUES.has(e.cls.tissue) && e.cls.system !== 'integumentary').map((e) => ({ name: e.name, mesh: e.mesh })))
        Object.assign(row, { installed: true, triangles: pkg.mesh.indices.length / 3, fit })
        console.log(`\nSkin package ${MALE_SKIN_PACKAGE_DIR} installed (${pkg.source.name}); deep-part surface outside the skin ${(fit.outside * 100).toFixed(1)}%`)
      } else {
        row.reason = !pkg ? 'no package' : !pkg.fittedTo ? 'the package does not say which internals it was fitted to (manifest.fittedTo missing)' : 'fitted to other internals'
        console.log(`\nSkin: BodyParts3D skin kept (${row.reason}); a skin package for these internals must carry "fittedTo": {"body": "male", "key": "${key}"} in its manifest.json`)
      }
      const genital = kept.filter((e) => /penis|scrotum|testis|epididymis/i.test(e.name))
      const pubis = kept.filter((e) => /hip bone/i.test(e.name))
      if (genital.length && pubis.length) {
        const front = Math.max(...pubis.map((e) => e.stats.bbox[5]))
        const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
        for (const e of genital) for (let k = 0; k < 3; k++) {
          b[k] = Math.min(b[k]!, e.stats.bbox[k]!)
          b[k + 3] = Math.max(b[k + 3]!, e.stats.bbox[k + 3]!)
        }
        row.externalGenitalia = { parts: genital.map((e) => e.name), bbox: b.map((v) => round(v, 4)), reachInFrontOfPubisMm: round((b[5]! - front) * 1000, 1), lowestBelowPubicSymphysisMm: round((Math.min(...pubis.map((e) => e.stats.bbox[1])) - b[1]!) * 1000, 1) }
        console.log(`  external genital parts kept (${genital.length}); they reach ${((b[5]! - front) * 1000).toFixed(0)} mm in front of the pubis — a fitted skin must enclose bbox ${b.map((v) => v.toFixed(3)).join(', ')}`)
      }
      report.skinPackage = row
    }
    if (skinEl) {
      const deep = kept.filter((e) => FAT_DEEP_TISSUES.has(e.cls.tissue) && e.cls.system !== 'integumentary')
      const byRegion = new Map<string, number[]>()
      for (const e of kept) {
        if (e.cls.tissue !== 'bone') continue
        const r = fatRegionOfBone(e.name)
        const a = byRegion.get(r) ?? []
        for (const v of thinPoints(surfacePoints(e.mesh, 0.006), 0.006)) a.push(v)
        byRegion.set(r, a)
      }
      const regionInputs = FAT_REGIONS.filter((r) => byRegion.has(r.key)).map((r) => ({ region: r.key, bonePoints: Float32Array.from(byRegion.get(r.key)!) }))
      const fat = deriveFat(skinEl.mesh, deep.map((e) => e.mesh), regionInputs, FAT_OPTIONS)
      const fatRows: Record<string, unknown>[] = []
      for (const r of fat.regions) {
        const def = FAT_REGIONS.find((x) => x.key === r.region)!
        if (r.mesh.indices.length < 300) continue
        const isa = isaPathFromFma(def.fma, fmaNames?.label.get(def.fma) ?? def.name, (c) => fmaNames?.parents.get(c), (c) => fmaNames?.label.get(c), (c) => tables.isa.name.has(c), isaIdByName.get('organ component') ?? null)
        const st = measure(r.mesh)
        const el: Element = { id: `SOMA_fat_${r.region}`, name: def.name, fma: def.fma, mesh: r.mesh, stats: st, sourceTriangles: r.mesh.indices.length / 3, cls: { system: 'integumentary', tissue: 'fat', rule: 'derived', signal: 'none' }, isa: [], partOf: [], provenance: 'curated', source: SOURCE_DERIVED.name, tree: { isa, partOf: null } }
        derived.push(el)
        kept.push(el)
        fatRows.push({ id: el.id, name: el.name, fma: el.fma, sourceTriangles: el.sourceTriangles, areaCm2: round(st.area * 1e4, 0), volumeMl: round(r.volume * 1e6, 0), thicknessMm: { p10: round(r.thickness.p10 * 1000, 0), median: round(r.thickness.median * 1000, 0), p90: round(r.thickness.p90 * 1000, 0), max: round(r.thickness.max * 1000, 0) }, skinCovered: round(r.skinCovered, 3), verticesPulledIn: round(r.verticesPulledIn, 4) })
      }
      console.log(`\nSubcutaneous fat (derived; ${FAT_OPTIONS.voxel * 1000} mm voxels, deep envelope closed by ${FAT_OPTIONS.closing * 1000} mm, at most ${FAT_OPTIONS.maxDepth * 1000} mm below the skin); volume inside the skin ${(fat.bodyVolume * 1000).toFixed(1)} l, fat ${(fat.regions.reduce((a, r) => a + r.volume, 0) * 1000).toFixed(1)} l`)
      for (const r of fatRows) {
        const t = r.thicknessMm as Record<string, number>
        console.log(`  ${pad(r.name as string, 44)}${pad(`${r.volumeMl} ml`, 10)}${pad(`${r.areaCm2} cm²`, 11)}thickness p10 ${t.p10} / median ${t.median} / p90 ${t.p90} / max ${t.max} mm (steps of ${FAT_OPTIONS.voxel * 1000} mm); fat under ${((r.skinCovered as number) * 100).toFixed(0)}% of the region's skin`)
      }
      report.fat = { options: FAT_OPTIONS, bodyVolumeL: round(fat.bodyVolume * 1000, 1), fatVolumeL: round(fat.regions.reduce((a, r) => a + r.volume, 0) * 1000, 1), deepParts: deep.length, regions: fatRows }
    }
    lap(`derived ${derived.length} parts`)
  }

  // ── 4. 分类报告 / 4. Classification report ────────────────────────────────────────────────────────────────
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

  // ── 5. 侧别 / 5. Side ─────────────────────────────────────────────────────────────────────────────────
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

  // ── 6. 暴露度 -> 深度 / 6. Exposure -> depth ────────────────────────────────────────────────────────────────────
  const sourceMeshes = kept.map((e) => e.mesh)
  const roles: ExposureRole[] = kept.map((e) => {
    const { system, tissue } = e.cls
    if (system === 'integumentary') return e.isa.includes('skin') ? 'skin' : 'ignore'
    // 淋巴结太小，遮不住肌 / lymph nodes are too small to hide a muscle
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
    // 左右孪生件共用均值 / left/right twins share the mean
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

  // ── 7. 邻接（在未简化的表面上计算） / 7. Adjacency (on the unsimplified surfaces) ─────────────────────────────────────────────
  const adj = computeAdjacency(sourceMeshes, { threshold: ADJACENCY_THRESHOLD, spacing: ADJACENCY_SPACING })
  // 皮下脂肪与皮肤一样是包络，一律不计邻接 / the subcutaneous fat is an envelope like the skin: never in the adjacency
  const envelopes = adj.neighbours.map((l, i) => (l.length > ADJACENCY_MAX_DEGREE || isFatPart(kept[i]!.id) ? i : -1)).filter((i) => i >= 0)
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

  // ── 8. 简化、法线、最终测量 / 8. Simplify, normals, final measurements ────────────────────────────────────────────────
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

  // ── 9. 树 / 9. Trees ────────────────────────────────────────────────────────────────────────────────
  // 合并的重复件仍然可达：保留的元素取代被丢弃元素的位置。
  // Merged duplicates stay reachable: the kept element takes the dropped one's place.
  const keepIds = new Set(kept.map((e) => e.id))
  const withAliases = (onto: Ontology, which: 'isa' | 'partOf'): Ontology => {
    const elementsMap = new Map<string, Set<string>>()
    for (const [c, set] of onto.elements) elementsMap.set(c, new Set([...set].map(resolve)))
    // 重新标注的元素离开旧概念，移到正确的概念下（上方的祖先相同）
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
    // 导入的部件：树中有其自身概念时挂在该概念下，否则作为新的叶概念挂在安置概念之下
    // （没有安置概念时挂在树根，仅限 isa）
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
    // 来自 Z-Anatomy 包的部件：创建其路径上缺失的概念，子概念在前
    // parts from the Z-Anatomy package: create the missing concepts of their path, child first
    for (const e of [...importedZa, ...derived]) {
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

  // ── 10. 写出 / 10. Write ───────────────────────────────────────────────────────────────────────────────
  // 所有内容先写到目标旁边的临时目录，再逐个文件移入（rename 是原子操作），先 GLB、
  // 最后 anatomy.json，这样读取方永远不会看到写了一半的文件。在第一次和最后一次 rename
  // 之间，读取方仍可能把旧的 anatomy.json 与新的 GLB 配在一起；这个窗口只有几毫秒。
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
  // 概念审计：仅凭其概念无法单独描述的部件
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
    sources: [SOURCE, ...(imported.length ? [SOURCE3] : []), ...(importedZa.some((e) => e.source === SOURCE_ZA.name) ? [SOURCE_ZA] : []), ...(importedZa.some((e) => e.source === SOURCE_O3D.name) ? [SOURCE_O3D] : []), ...(derived.length ? [SOURCE_DERIVED] : []), ...(externalSkinSource ? [externalSkinSource] : [])],
    systems,
    layers: LAYERS.map((l) => ({ name: l.name })),
    parts,
    trees: { isa: isaTree, partOf: partOfTree },
  }
  const json = JSON.stringify(data)
  writeFileSync(join(stage, 'anatomy.json'), json)
  // nerves.json：生成神经管所依据的中心线
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

/**
 * 用户不应信任男性身体中的哪些内容，最重要的排在最前。
 * What a user should not trust in the male body, most important first.
 */
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
    en: 'The pleura and the pericardium are not anatomical models: they are closed envelopes computed 2 mm (pleura) and 4 mm (pericardium) outside our own lungs and heart. Only the visceral pleura is shown; there is no parietal pleura, pleural recess or pericardial reflection.',
    zh: '胸膜和心包不是解剖建模：它们是在本模型的肺和心脏外侧 2 mm（胸膜）和 4 mm（心包）处计算出的封闭包络面。目前只有脏胸膜，没有壁胸膜、胸膜隐窝和心包返折。',
  })
  out.push({
    zh: '皮下脂肪层不是扫描或建模所得：它是把皮肤内壁与肌肉、骨骼、器官外包络之间的空隙按 3 mm 体素填充后得到的，按头、颈、躯干和四肢分区，最深只算到皮下 3 cm。其厚度反映的是本模型皮肤与肌肉之间的间距，不代表真实的脂肪分布；腋窝、腘窝等凹陷处的深部脂肪与皮下脂肪没有区分，浅筋膜的膜性层也未单独表示。',
    en: 'The subcutaneous fat layer is neither scanned nor modelled: it is the gap between the inner wall of the skin and the outer envelope of muscles, bones and organs, filled at 3 mm voxels, cut into head, neck, trunk and limbs, and followed no deeper than 3 cm below the skin. Its thickness shows the spacing between skin and muscle in this model, not a real fat distribution; deep fat in hollows such as the axilla and the popliteal fossa is not separated from it, and the membranous layer of the superficial fascia is not shown.',
  })
  out.push({
    en: 'The spinal cord is a schematic tube that ends at L2/L3 together with its dura (a real dural sac reaches S2); there are no cranial meninges except the falx and tentorium. The parotid gland is about a quarter of real size (5.6 cm³). Joint capsules, menisci and cruciate ligaments were fitted to our bones joint by joint and often overlap the muscles around them.',
    zh: '脊髓是示意性的管状模型，与硬脊膜一同止于 L2/L3（真实硬膜囊可达 S2）；除大脑镰和小脑幕外没有颅内脑膜。腮腺体积约为真实大小的四分之一（5.6 cm³）。关节囊、半月板和交叉韧带是逐个关节贴合到本模型骨骼上的，常与周围肌肉重叠。',
  })
  out.push({
    en: 'Missing structures: phrenic nerve, cervical plexus branches, great auricular and occipital nerves, splanchnic nerves; parietal pleura and parietal peritoneum; ligamenta flava; lymphatic vessels and thoracic duct; cecum, sigmoid colon and anal canal as separate parts; inferior parathyroids; middle and inner ear; subcutaneous fat. The liver exists only as its eight segments, the heart only as chamber walls and valves.',
    zh: '缺失的结构：膈神经、颈丛分支、耳大神经和枕神经、内脏神经；壁胸膜和壁腹膜；黄韧带；淋巴管和胸导管；盲肠、乙状结肠和肛管未单独成件；下甲状旁腺；中耳和内耳；皮下脂肪。肝脏只以肝段形式存在，心脏只有心腔壁和瓣膜。',
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
    en: 'Meshes were simplified (largest deviation 0.8 mm) and the feet point downwards as in the scanner. About 30 lymph node groups were shifted by up to 3 cm to the nearest free space, and a few nodes and ligaments were left out because they did not fit this body.',
    zh: '网格经过简化（最大偏差 0.8 mm）；双足呈扫描时的跖屈姿势。约 30 组淋巴结被整体平移到最近的空隙处（最多约 3 cm），少数淋巴结和韧带因无法贴合本模型而未收录。',
  })
  return out
}

if (import.meta.main) await main()
