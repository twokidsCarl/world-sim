// 命令行：建一副身体（或一个区域）的软组织笼子，写出 soft.json + soft.bin + cage-report.json。
// Command line: builds the soft-tissue cage of a body (or of one region) and writes soft.json + soft.bin + cage-report.json.
//
//   bun tools/softbody/build.ts <male|female> [--cell 0.027] [--region forearm_L|thigh_L|abdomen|chest] [--rest0] [--out <dir>]
//
// 输出目录缺省为 data/raw/softbody/out/<body>[-<region>]/（不入库）。几何还会再改一次，所以现在不往 public/ 写；
// 改完以后重跑这条命令即可。--rest0 另外反解零重力参考形状并存进 soft.bin（慢，建议只对区域笼子用）。
// The output directory defaults to data/raw/softbody/out/<body>[-<region>]/ (not committed). The geometry will change
// once more, so nothing is written under public/ yet; rerun this command afterwards. --rest0 also solves the
// zero-gravity reference and stores it in soft.bin (slow; meant for regional cages).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Rig } from '../../src/anatomy/types.ts'
import { type LoadedSoft, decodeSoft, encodeSoft, solverInput } from '../../src/softbody/body.ts'
import { solveZeroGravityRest } from '../../src/softbody/rest.ts'
import { SoftSolver } from '../../src/softbody/solver.ts'
import type { SoftData, SoftMaterial } from '../../src/softbody/types.ts'
import { type Body, readBody } from '../rig/io.ts'
import { type CageOptions, type CageStats, buildCage } from './cage.ts'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const OUT = join(ROOT, 'data', 'raw', 'softbody', 'out')

export interface MaterialsFile {
  damping: { rate: number }
  gravity: [number, number, number]
  materials: (SoftMaterial & { basis: { thickness?: { value: number }; activeStrain?: { value: number } } })[]
}

export function readMaterials(): MaterialsFile {
  return JSON.parse(readFileSync(join(ROOT, 'data', 'curated', 'softbody', 'materials.json'), 'utf8')) as MaterialsFile
}

/** 求解器用的材料：去掉出处说明，只留数值 / the materials as the solver uses them: numbers only, without the provenance notes */
export function solverMaterials(file: MaterialsFile): SoftMaterial[] {
  return file.materials.map(({ id, name, young, poisson, density, youngActive, fibreYoung, rigid, stiffening, branchRatio, branchTau }) => ({ id, name, young, poisson, density, ...(youngActive ? { youngActive } : {}), ...(fibreYoung ? { fibreYoung } : {}), ...(rigid ? { rigid } : {}), ...(stiffening ? { stiffening } : {}), ...(branchRatio ? { branchRatio, branchTau } : {}) }))
}

/** 具名区域的盒子，由关节中心定出 / the box of a named region, from joint centres */
export function regionBox(rig: Rig, name: string): [number, number, number, number, number, number] {
  const c = (id: string): [number, number, number] => {
    const j = rig.joints.find((x) => x.id === id)
    if (!j) throw new Error(`softbody: the rig has no joint "${id}"`)
    return j.center
  }
  const span = (ids: string[], pad: [number, number, number]): [number, number, number, number, number, number] => {
    const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (const id of ids) for (let k = 0; k < 3; k++) {
      b[k] = Math.min(b[k]!, c(id)[k]! - pad[k]!)
      b[k + 3] = Math.max(b[k + 3]!, c(id)[k]! + pad[k]!)
    }
    return b
  }
  switch (name) {
    case 'forearm_L': return span(['elbow_L', 'wrist_L'], [0.07, -0.02, 0.07])
    case 'thigh_L': return span(['hip_L', 'knee_L'], [0.12, -0.05, 0.14])
    case 'abdomen': { const b = span(['pelvis', 'T10'], [0.22, 0, 0.3]); b[1] -= 0.04; return b }
    case 'chest': {
      // T10–T2 只有约 17 cm 高，下切口正好穿过乳房下缘，切口上钉住的结点把乳房拴住了（第一阶段乳房位移小一个量级的主要原因）。
      // 向下多留 14 cm、向上多留 8 cm。
      // T10–T2 is only about 17 cm tall and its lower cut passed right through the lower breast, whose pinned cut nodes
      // tied the breast down (the main reason the breast moved an order of magnitude too little in phase 1). 14 cm
      // more below and 8 cm more above.
      const b = span(['T10', 'T2'], [0.24, 0, 0.3])
      b[1] -= 0.14
      b[4] += 0.08
      return b
    }
  }
  throw new Error(`softbody: unknown region "${name}" (forearm_L, thigh_L, abdomen, chest)`)
}

export interface BuildResult {
  json: SoftData
  bin: Uint8Array
  stats: CageStats
}

export function build(body: Body, rig: Rig, rigBin: Uint8Array, cell: number, region?: string): BuildResult {
  const file = readMaterials()
  const opts: CageOptions = {
    cell,
    gravity: file.gravity,
    materials: solverMaterials(file),
    skinThickness: file.materials.find((m) => m.id === 'skin')?.basis.thickness?.value ?? 0.0015,
    ...(region ? { region: regionBox(rig, region), regionPin: cell } : {}),
  }
  return buildCage(body, rig, rigBin, opts)
}

/** 反解零重力参考形状并重新编码 / solves the zero-gravity reference and encodes again */
export function withRest0(r: BuildResult, log: (s: string) => void = () => {}): { result: BuildResult; residuals: number[]; converged: boolean } {
  const soft = decodeSoft(r.json, r.bin)
  const file = readMaterials()
  const solver = new SoftSolver(solverInput(soft), { gravity: soft.data.gravity, prestressGravity: null, substeps: 12, damping: 12 })
  const res = solveZeroGravityRest(solver, soft.nodes, { iterations: 10, tolerance: 2e-4, maxFrames: 1500, speedTolerance: 1e-4 })
  log(`rest0 residuals (mm): ${res.residuals.map((x) => (x * 1000).toFixed(3)).join(' ')}`)
  void file
  return { result: { ...reencode(soft, Float32Array.from(res.rest)), stats: r.stats }, residuals: res.residuals, converged: res.converged }
}

export function reencode(soft: LoadedSoft, rest0: Float32Array | null): { json: SoftData; bin: Uint8Array } {
  const { sections: _s, embedded: _e, nodeCount: _n, tetCount: _t, anchorCount: _a, ...head } = soft.data
  void _s, _e, _n, _t, _a
  return encodeSoft(head, { nodes: soft.nodes, tets: soft.tets, tetSlot: soft.tetSlot, tetMaterial: soft.tetMaterial, tetFill: soft.tetFill, tetSkin: soft.tetSkin, tetMuscle: soft.tetMuscle, nodePin: soft.nodePin, nodeInfluence: soft.nodeInfluence, anchors: soft.anchors, anchorWeight: soft.anchorWeight, rest0, embedded: [...soft.embedded].map(([part, points]) => ({ part, points })) })
}

export async function loadBody(bodyId: string): Promise<{ body: Body; rig: Rig; rigBin: Uint8Array }> {
  const dir = join(ROOT, 'public', 'anatomy', bodyId)
  const body = await readBody(dir)
  const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as Rig
  const rigBin = new Uint8Array(readFileSync(join(dir, 'rig.bin')))
  return { body, rig, rigBin }
}

export function write(dir: string, r: BuildResult, extra: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'soft.json'), JSON.stringify(r.json))
  writeFileSync(join(dir, 'soft.bin'), r.bin)
  writeFileSync(join(dir, 'cage-report.json'), JSON.stringify({ ...r.stats, bytes: { json: JSON.stringify(r.json).length, bin: r.bin.length }, ...extra }, null, 1))
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const bodyId = args[0]
  if (bodyId !== 'male' && bodyId !== 'female') {
    console.error('usage: bun tools/softbody/build.ts <male|female> [--cell 0.027] [--region forearm_L|thigh_L|abdomen|chest] [--rest0] [--out <dir>]')
    process.exit(1)
  }
  const region = flag('region')
  const cell = Number(flag('cell') ?? (region ? 0.012 : 0.027))
  const { body, rig, rigBin } = await loadBody(bodyId)
  let r = build(body, rig, rigBin, cell, region)
  const extra: Record<string, unknown> = {}
  if (args.includes('--rest0')) {
    const z = withRest0(r, console.log)
    r = z.result
    extra.rest0 = { residualsMm: z.residuals.map((x) => Math.round(x * 1e6) / 1000), converged: z.converged }
  }
  const dir = flag('out') ?? join(OUT, region ? `${bodyId}-${region}` : bodyId)
  write(dir, r, extra)
  console.log(JSON.stringify({ ...r.stats, bytes: { json: JSON.stringify(r.json).length, bin: r.bin.length } }, null, 1))
}
