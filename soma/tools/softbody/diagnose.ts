// 诊断（第三阶段）：验证算例为什么与文献不符。逐项改一个因素，看结果怎么变（不写报告，只打印）。只读男性身体。
// Diagnosis (phase 3): why validation cases disagree with the literature. Changes one factor at a time and prints the
// result (writes no report). Reads the male body only.
//
//   bun tools/softbody/diagnose.ts layers            沿压入方向的组织层 / tissue layers along the pressing direction
//   bun tools/softbody/diagnose.ts converge [site] [depthMm]   求解收敛（容差、子步、体积上限）/ convergence of the solve (tolerance, substeps, volume cap)
//   bun tools/softbody/diagnose.ts mass [site]       质量缩放对稳态的影响 / effect of mass scaling on the steady state
//   bun tools/softbody/diagnose.ts fields [cell]     前臂上脂肪、肌肉厚度的分布 / fat and muscle thickness over the forearm
//   bun tools/softbody/diagnose.ts sens [site] [depthMm]       材料和单元的灵敏度 / sensitivity to materials and cell
//   bun tools/softbody/diagnose.ts forearm [cell] [mihaiFat]   两个前臂点、三个深度 / both forearm sites at three depths
//   bun tools/softbody/diagnose.ts pain              疼痛工具的球形压头 / the pain tool's spherical probe
//   bun tools/softbody/diagnose.ts abdomen [cells]   腹部 R2 的网格依赖 / mesh dependence at abdominal R2

import type { MixOptions } from '../../src/softbody/body.ts'
import { press } from '../../src/softbody/press.ts'
import { computeNormals } from '../pipeline/geometry.ts'
import { loadBody } from './build.ts'
import { bodyInside } from './cage.ts'
import { buildSite } from './site.ts'

const which = process.argv[2] ?? 'all'
const { body, rig, rigBin } = await loadBody('male')
const skin = body.meshes.get(body.data.parts.find((p) => p.tissue === 'skin')?.id ?? '')!
const normals = computeNormals(skin)
const inBody = bodyInside(skin)
const c = (id: string): [number, number, number] => rig.joints.find((j) => j.id === id)!.center
const e = c('elbow_L'), w = c('wrist_L')
const at = (t: number): [number, number, number] => [e[0] + (w[0] - e[0]) * t, e[1] + (w[1] - e[1]) * t, e[2] + (w[2] - e[2]) * t]
function nearest(t: [number, number, number]): number {
  let best = -1, bd = Infinity
  const p = skin.positions
  for (let i = 0; i < p.length / 3; i++) {
    if (normals[i * 3 + 2]! < 0.7) continue
    const d = Math.hypot(p[i * 3]! - t[0], p[i * 3 + 1]! - t[1], p[i * 3 + 2]! - t[2])
    if (d < bd) (bd = d), (best = i)
  }
  return best
}
const sites = { proximalThird: nearest(at(0.3)), middle: nearest(at(0.5)) }
const siteOf = (v: number): { site: [number, number, number]; normal: [number, number, number] } => ({ site: [skin.positions[v * 3]!, skin.positions[v * 3 + 1]!, skin.positions[v * 3 + 2]!], normal: [normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!] })

if (which === 'layers' || which === 'all') {
  // 沿压入方向逐毫米看是什么部件 / what part lies at every millimetre along the pressing direction
  for (const [name, v] of Object.entries(sites)) {
    const { site, normal } = siteOf(v)
    const S = buildSite(body, rig, rigBin, site, normal, 0.013, { cell: 0.0043, inBody })
    const mats = S.soft.data.materials
    const prof: string[] = []
    for (let z = 0; z < 0.05; z += 0.001) {
      const em = S.domain.embed([site[0] - normal[0] * z, site[1] - normal[1] * z, site[2] - normal[2] * z])
      prof.push(em.inside[0] ? `${(z * 1000).toFixed(0)}:${mats[S.soft.tetMaterial[em.tet[0]!]!]!.id}` : `${(z * 1000).toFixed(0)}:-`)
    }
    console.log(name, 'site', site.map((x) => x.toFixed(4)).join(','), 'normal', normal.map((x) => x.toFixed(2)).join(','), 'thickness', S.domain.thickness)
    console.log(prof.join(' '))
    console.log('byMaterial', JSON.stringify(S.stats.byMaterial))
  }
}

if (which === 'converge' || which === 'all') {
  const name = (process.argv[3] ?? 'proximalThird') as keyof typeof sites
  const depth = Number(process.argv[4] ?? 3.2)
  const { site, normal } = siteOf(sites[name])
  const variants: [string, { cell?: number; substeps?: number; mix?: MixOptions; tol?: number; frames?: number; cap?: number }][] = [
    ['baseline cell 4.3 sub 8', { cell: 0.0043 }],
    ['tight tolerance 1e-5, 3000 frames', { cell: 0.0043, tol: 1e-5, frames: 3000 }],
    ['substeps 32', { cell: 0.0043, substeps: 32 }],
    ['volumeCap 8, substeps 32', { cell: 0.0043, substeps: 32, cap: 8 }],
  ]
  for (const [label, o] of variants) {
    const t0 = performance.now()
    const S = buildSite(body, rig, rigBin, site, normal, 0.013, { cell: o.cell ?? 0.0043, inBody, ...(o.substeps ? { substeps: o.substeps } : {}), ...(o.mix ? { mix: o.mix } : {}), ...(o.cap ? { solver: { volumeCap: o.cap } } : {}) })
    const r = press(S.domain, { kind: 'flat', radiusMm: 13 }, { depthMm: depth }, { ...(o.tol ? { tolerance: o.tol } : {}), ...(o.frames ? { maxFrames: o.frames } : {}) })
    console.log(name, depth, label, 'F', r.forceN, 'frames', r.frames, 'conv', r.converged, 'area', r.contactAreaMm2, 'massScale', S.massScale.toFixed(1), 's', ((performance.now() - t0) / 1000).toFixed(1))
  }
}

if (which === 'mass') {
  // 质量再放大 k 倍：XPBD 的偏量约束每步重置乘子，稳态刚度按 1/(1 + h²·μ·V·Σw‖∇C‖²) 打折；质量越大折扣越小
  // mass scaled up by a further k: the deviatoric constraints reset their multiplier every step, so the steady stiffness is discounted by 1/(1 + h²·μ·V·Σw‖∇C‖²); more mass, less discount
  const name = (process.argv[3] ?? 'proximalThird') as keyof typeof sites
  const { site, normal } = siteOf(sites[name])
  for (const k of [1, 10, 100]) {
    const S = buildSite(body, rig, rigBin, site, normal, 0.013, { cell: 0.0043, inBody })
    const s = S.domain.solver as unknown as { mass: Float64Array; invMass: Float64Array; invMass0: Float64Array; damping: number }
    for (let i = 0; i < s.mass.length; i++) (s.mass[i] = s.mass[i]! * k), (s.invMass[i] = s.invMass[i]! / k), (s.invMass0[i] = s.invMass0[i]! / k)
    s.damping = s.damping / Math.sqrt(k)
    const t0 = performance.now()
    const r = press(S.domain, { kind: 'flat', radiusMm: 13 }, { depthMm: 3.2 }, { tolerance: 1e-4, maxFrames: 6000 })
    console.log(name, 'mass x', k, 'F', r.forceN, 'frames', r.frames, 'conv', r.converged, 's', ((performance.now() - t0) / 1000).toFixed(1))
  }
}

if (which === 'fields') {
  // 按该文的选点准则在本模型的左前臂上找点：P2 = 脂肪最厚处，P3 = 肌肉最厚处（沿皮肤法线向内量各层厚度）
  // sites chosen on this model's left forearm by the paper's own criteria: P2 = thickest fat, P3 = thickest muscle (layer thicknesses measured inward along the skin normal)
  const cell = Number(process.argv[3] ?? 0.003)
  const ax = [w[0] - e[0], w[1] - e[1], w[2] - e[2]], L2 = ax[0]! ** 2 + ax[1]! ** 2 + ax[2]! ** 2
  const p = skin.positions
  const cand: number[] = []
  for (let i = 0; i < p.length / 3; i++) {
    const t = ((p[i * 3]! - e[0]) * ax[0]! + (p[i * 3 + 1]! - e[1]) * ax[1]! + (p[i * 3 + 2]! - e[2]) * ax[2]!) / L2
    const r = Math.hypot(p[i * 3]! - (e[0] + ax[0]! * t), p[i * 3 + 1]! - (e[1] + ax[1]! * t), p[i * 3 + 2]! - (e[2] + ax[2]! * t))
    if (t > 0.15 && t < 0.85 && r < 0.07) cand.push(i)
  }
  const box: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (const i of cand) for (let k = 0; k < 3; k++) (box[k] = Math.min(box[k]!, p[i * 3 + k]! - 0.06)), (box[k + 3] = Math.max(box[k + 3]!, p[i * 3 + k]! + 0.06))
  const { buildCage } = await import('./cage.ts')
  const { readMaterials, solverMaterials } = await import('./build.ts')
  const { decodeSoft, embedPoints } = await import('../../src/softbody/body.ts')
  const file = readMaterials()
  const r = buildCage(body, rig, rigBin, { cell, region: box, regionPin: cell, gravity: file.gravity, materials: solverMaterials(file), skinThickness: 0.00113, inBody })
  const soft = decodeSoft(r.json, r.bin)
  const ids = soft.data.materials.map((m) => m.id)
  const rows: { v: number; t: number; fat: number; muscle: number; total: number; nz: number }[] = []
  const step = 0.0005
  for (const i of cand) {
    const pts: number[] = []
    for (let z = step / 2; z < 0.06; z += step) pts.push(p[i * 3]! - normals[i * 3]! * z, p[i * 3 + 1]! - normals[i * 3 + 1]! * z, p[i * 3 + 2]! - normals[i * 3 + 2]! * z)
    const em = embedPoints(soft.data.lattice, soft.slotTet, soft.nodes, soft.tets, pts)
    let fat = 0, muscle = 0, total = 0
    for (let k = 0; k < pts.length / 3; k++) {
      if (!em.inside[k] || !inBody(pts[k * 3]!, pts[k * 3 + 1]!, pts[k * 3 + 2]!)) break
      const id = ids[soft.tetMaterial[em.tet[k]!]!]
      if (id === 'bone') break
      total += step
      if (id === 'fat') fat += step
      if (id === 'muscle') muscle += step
    }
    const t = ((p[i * 3]! - e[0]) * ax[0]! + (p[i * 3 + 1]! - e[1]) * ax[1]! + (p[i * 3 + 2]! - e[2]) * ax[2]!) / L2
    rows.push({ v: i, t, fat, muscle, total, nz: normals[i * 3 + 2]! })
  }
  const show = (q: (typeof rows)[number]): string => `v${q.v} t=${q.t.toFixed(2)} fat=${(q.fat * 1000).toFixed(1)} muscle=${(q.muscle * 1000).toFixed(1)} toBone=${(q.total * 1000).toFixed(1)} nz=${q.nz.toFixed(2)}`
  console.log('candidates', rows.length)
  console.log('thickest fat:'); for (const q of [...rows].sort((a, b) => b.fat - a.fat).slice(0, 5)) console.log(' ', show(q))
  console.log('thickest muscle:'); for (const q of [...rows].sort((a, b) => b.muscle - a.muscle).slice(0, 5)) console.log(' ', show(q))
  for (const [k, v] of Object.entries(sites)) console.log('current', k, show(rows.find((q) => q.v === v) ?? rows[0]!))
  const hist = (f: (q: (typeof rows)[number]) => number): string => { const s = rows.map(f).sort((a, b) => a - b); return [0.1, 0.5, 0.9].map((x) => (s[Math.floor(x * (s.length - 1))]! * 1000).toFixed(1)).join('/') }
  console.log('fat p10/p50/p90 mm', hist((q) => q.fat), 'muscle', hist((q) => q.muscle))
}

if (which === 'sens') {
  // 灵敏度：脂肪刚度、皮肤刚度、单元大小 / sensitivity: fat stiffness, skin stiffness, cell size
  const name = (process.argv[3] ?? 'proximalThird') as keyof typeof sites
  const depth = Number(process.argv[4] ?? 3.2)
  const { site, normal } = siteOf(sites[name])
  const variants: [string, number, MixOptions][] = [
    ['fat x4.3 (= muscle E)', 0.0043, { scale: { fat: 4.34 } }],
    ['fat x11 (17 kPa)', 0.0043, { scale: { fat: 10.9 } }],
    ['skin x3', 0.0043, { scale: { skin: 3 } }],
    ['other = muscle E', 0.0043, { scale: { other: 6900 / 5000 } }],
    ['muscle x2', 0.0043, { scale: { muscle: 2 } }],
    ['baseline cell 3 mm', 0.003, {}],
  ]
  for (const [label, cell, mix] of variants) {
    const t0 = performance.now()
    const S = buildSite(body, rig, rigBin, site, normal, 0.013, { cell, inBody, mix })
    const r = press(S.domain, { kind: 'flat', radiusMm: 13 }, { depthMm: depth })
    console.log(name, depth, label, 'F', r.forceN, 'conv', r.converged, 'nodes', S.stats.nodes, 's', ((performance.now() - t0) / 1000).toFixed(1))
  }
}

if (which === 'forearm') {
  // 两个点、三个深度，当前材料表；可选 ogden=false 退回第二阶段的脂肪 / both sites, three depths, the current table; ogden=false falls back to the fat of phase 2
  const cell = Number(process.argv[3] ?? 0.0043)
  const mix: MixOptions = process.argv[4] === 'mihaiFat' ? { ogden: { fat: { c: [2342, 4083, -418, -1337], m: [1, -1, 2, -2] } } } : {}
  for (const [name, v] of Object.entries(sites)) {
    const { site, normal } = siteOf(v)
    const S = buildSite(body, rig, rigBin, site, normal, 0.013, { cell, inBody, mix })
    const t0 = performance.now()
    const rows = [1.6, 3.2, 4.5].map((d) => {
      const r = press(S.domain, { kind: 'flat', radiusMm: 13 }, { depthMm: d })
      return `${d}mm ${r.forceN}N${r.converged ? '' : '*'} strain ${r.peakStrain}`
    })
    console.log(name, `cell ${cell * 1000}mm`, rows.join(' | '), 's', ((performance.now() - t0) / 1000).toFixed(1))
  }
}

if (which === 'abdomen') {
  // 腹部 R2：单元从 7 mm 细到 3.5 mm，半球头 10 mm，看浅处偏软、深处偏硬是不是网格造成的
  // abdomen R2: cell from 7 mm down to 3.5 mm, hemispherical tip 10 mm: is "too soft shallow, too stiff deep" a matter of the mesh?
  const yUmb = (c('L3')[1] + c('L5')[1]) / 2
  const target: [number, number, number] = [-0.04, yUmb, c('L3')[2] + 0.15]
  let v = -1, bd = Infinity
  for (let i = 0; i < skin.positions.length / 3; i++) {
    if (normals[i * 3 + 2]! < 0.7) continue
    const d = Math.hypot(skin.positions[i * 3]! - target[0], skin.positions[i * 3 + 1]! - target[1], skin.positions[i * 3 + 2]! - target[2])
    if (d < bd) (bd = d), (v = i)
  }
  const { site, normal } = siteOf(v)
  const f = (d: number): number => -2.937e-6 * d ** 4 + 2.59e-4 * d ** 3 + 2.479e-3 * d * d + 0.2163 * d
  for (const cell of (process.argv[3] ?? '0.007,0.0035').split(',').map(Number)) {
    const S = buildSite(body, rig, rigBin, site, normal, 0.01, { cell, extent: 0.065, inBody })
    const t0 = performance.now()
    const rows = [5, 10, 15, 20].map((d) => {
      const r = press(S.domain, { kind: 'hemisphere', radiusMm: 10 }, { depthMm: d }, { maxFrames: 300 })
      return `${d}mm ${r.forceN}N (pub ${f(d).toFixed(2)}, x${(r.forceN / f(d)).toFixed(2)}) area ${r.contactAreaMm2} strain ${r.peakStrain}`
    })
    console.log('R2 cell', cell * 1000, 'thickness', S.domain.thickness, rows.join(' | '), 's', ((performance.now() - t0) / 1000).toFixed(0))
  }
}

if (which === 'pain') {
  // 疼痛工具的球形压头（半径 5 mm）在前臂上：第二阶段脂肪对 Mihai 的 Ogden 脂肪 / the pain tool's spherical probe (radius 5 mm) on the forearm: phase-2 fat against Mihai's Ogden fat
  const { site, normal } = siteOf(sites.proximalThird)
  for (const [label, mix] of [['phase-2 fat', {}], ['Mihai Ogden fat', { ogden: { fat: { c: [2342, 4083, -418, -1337], m: [1, -1, 2, -2] } } }]] as [string, MixOptions][]) {
    const S = buildSite(body, rig, rigBin, site, normal, 0.005, { inBody, mix })
    const t0 = performance.now()
    const rows = [1, 2, 5].map((f) => {
      const r = press(S.domain, { kind: 'sphere', radiusMm: 5 }, { forceN: f })
      return `${f}N: ${r.depthMm}mm ${r.forceN}N peak ${r.peakPressureKPa}kPa strain ${r.peakStrain} ${r.flags.join('+')}`
    })
    console.log(label, 'cell', S.domain.cell, rows.join(' | '), 's', ((performance.now() - t0) / 1000).toFixed(0))
  }
}
