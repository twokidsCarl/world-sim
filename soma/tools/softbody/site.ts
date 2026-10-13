// 在一个部位按需建一块细笼子，并组成 press() 要的求解域（src/softbody/press.ts）。
// Builds a fine cage at a site on demand and assembles the domain press() needs (src/softbody/press.ts).

import type { Rig } from '../../src/anatomy/types.ts'
import { type LoadedSoft, type MixOptions, decodeSoft, embedPoints, solverInput } from '../../src/softbody/body.ts'
import { type Coupling, type PressDomain, massScale, surfaceSamples } from '../../src/softbody/press.ts'
import { type PointSet, type SolverOptions, SoftSolver, type Vec3 } from '../../src/softbody/solver.ts'
import type { Body } from '../rig/io.ts'
import { readMaterials, solverMaterials } from './build.ts'
import { type CageStats, buildCage } from './cage.ts'

export interface SiteOptions {
  /** 单元边长，米；缺省 = 压头半径的三分之一，限制在 2–6 mm / cell edge, metres; default = a third of the probe radius, kept within 2–6 mm */
  cell?: number
  /** 区域的半边长，米；缺省 = max(3a, a + 5 个单元) / half-size of the region, metres; default = max(3a, a + 5 cells) */
  extent?: number
  substeps?: number
  mix?: MixOptions
  solver?: SolverOptions
  inBody?: (x: number, y: number, z: number) => boolean
}

export interface Site {
  soft: LoadedSoft
  domain: PressDomain
  stats: CageStats
  region: [number, number, number, number, number, number]
  /** 建笼子、建求解器各用了多少毫秒 / milliseconds spent building the cage and the solver */
  ms: { cage: number; solver: number }
  massScale: number
}

export function buildSite(body: Body, rig: Rig, rigBin: Uint8Array, site: Vec3, outward: Vec3, probeRadius: number, o: SiteOptions = {}): Site {
  const t0 = performance.now()
  const a = probeRadius
  const cell = o.cell ?? Math.min(0.006, Math.max(0.002, a / 3))
  const ext = o.extent ?? Math.max(3 * a, a + 5 * cell)
  const region: Site['region'] = [site[0] - ext, site[1] - ext, site[2] - ext, site[0] + ext, site[1] + ext, site[2] + ext]
  const file = readMaterials()
  const r = buildCage(body, rig, rigBin, { cell, region, regionPin: cell, gravity: file.gravity, materials: solverMaterials(file), skinThickness: file.materials.find((m) => m.id === 'skin')?.basis.thickness?.value ?? 0.0015, ...(o.inBody ? { inBody: o.inBody } : {}) })
  const soft = decodeSoft(r.json, r.bin)
  const t1 = performance.now()
  const input = solverInput(soft, o.mix ?? {})
  const substeps = o.substeps ?? 8, h = 1 / 60 / substeps
  // 质量缩放（准静态）：按最硬的四面体定 / mass scaling (quasi-static), set by the stiffest tetrahedron
  let lamMax = 0, rho = Infinity
  for (let e = 0; e < soft.data.tetCount; e++) if (input.mu[e]! > 0) (lamMax = Math.max(lamMax, input.lambda[e]!)), (rho = Math.min(rho, input.density[e]!))
  // 取 λ 的 90 百分位而不是最大值：个别皮肤占比高的四面体由求解器的刚度上限处理 / the 90th percentile of λ rather than the maximum: the few skin-rich tetrahedra are left to the solver's stiffness cap
  const lams = Float32Array.from(input.lambda).filter((v) => v > 0).sort()
  const lam90 = lams.length ? lams[Math.floor(lams.length * 0.9)]! : lamMax
  const scale = massScale(lam90, 1000, cell, h, 1.5)
  const density = Float32Array.from(input.density as ArrayLike<number>, (v) => v * scale)
  const solver = new SoftSolver({ ...input, density }, { substeps, damping: 15 / Math.sqrt(scale), gravity: [0, 0, 0], prestressGravity: null, ...(o.solver ?? {}) })
  const skin = body.meshes.get(soft.data.skin.part)!
  const sp = surfaceSamples(skin.positions, skin.indices, site, 1.6 * a + cell, Math.min(cell / 3, a / 6))
  const embed = (positions: ArrayLike<number>): PointSet & { inside: Uint8Array } => embedPoints(soft.data.lattice, soft.slotTet, soft.nodes, soft.tets, positions)
  const inward: Vec3 = [-outward[0], -outward[1], -outward[2]]
  // 厚度：沿压入方向走，直到碰到钉住的结点所在的四面体、骨或笼子之外 / thickness: marching inward until a tetrahedron with a pinned node, bone, or the outside of the cage
  let thickness = ext
  const bone = soft.data.materials.findIndex((m) => m.rigid)
  for (let z = cell / 2; z < ext; z += cell / 4) {
    const em = embed([site[0] + inward[0] * z, site[1] + inward[1] * z, site[2] + inward[2] * z])
    let hit = !em.inside[0]
    if (!hit) {
      const e = em.tet[0]!
      if (soft.tetMaterial[e] === bone) hit = true
      // 权重最大的结点被钉住，就算到了骨 / the node of largest weight being pinned counts as reaching bone
      let best = 0
      for (let k = 1; k < 4; k++) if (em.bary[k]! > em.bary[best]!) best = k
      if (soft.nodePin[soft.tets[e * 4 + best]!]! >= 0) hit = true
    }
    if (hit) {
      thickness = z
      break
    }
  }
  const domain: PressDomain = { solver, cell, site, inward, samples: { points: embed(sp.positions), area: sp.area, positions: sp.positions }, embed, thickness }
  return { soft, domain, stats: r.stats, region, ms: { cage: Math.round(t1 - t0), solver: Math.round(performance.now() - t1) }, massScale: scale }
}

/** 细笼子切口上的结点在粗笼子里的嵌入（两级耦合用）。 Embedding of the fine cage's cut nodes in the coarse cage (for the two-level coupling). */
export function linkToCoarse(s: Site, coarse: LoadedSoft): Coupling {
  const { soft, region, domain } = s
  const d = domain.cell * 1.01
  const nodes: number[] = [], pos: number[] = []
  for (let i = 0; i < soft.data.nodeCount; i++) {
    if (soft.nodePin[i]! < 0) continue
    const x = soft.nodes[i * 3]!, y = soft.nodes[i * 3 + 1]!, z = soft.nodes[i * 3 + 2]!
    if (x < region[0] + d || x > region[3] - d || y < region[1] + d || y > region[4] - d || z < region[2] + d || z > region[5] - d) (nodes.push(i), pos.push(x, y, z))
  }
  const emb = embedPoints(coarse.data.lattice, coarse.slotTet, coarse.nodes, coarse.tets, pos)
  // 压入点往里半个粗单元处，免得落在粗笼子的体外部分 / the site moved inward by half a coarse cell, to stay clear of the part of the coarse cage outside the body
  const q = coarse.data.lattice.cell / 2
  const st = embedPoints(coarse.data.lattice, coarse.slotTet, coarse.nodes, coarse.tets, [domain.site[0] + domain.inward[0] * q, domain.site[1] + domain.inward[1] * q, domain.site[2] + domain.inward[2] * q])
  return { nodes: Uint32Array.from(nodes), inCoarse: emb, siteInCoarse: st }
}
