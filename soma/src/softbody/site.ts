// 在一个部位按需建一块细笼子，并组成 press() 要的求解域。不依赖 node：命令行（tools/softbody/site.ts）和
// 浏览器的 Web Worker（src/softbody/engine.ts）走同一段代码，所以界面里的按压就是验证过的那个设置。
// Builds a fine cage at a site on demand and assembles the domain press() needs. No node dependency: the command line
// (tools/softbody/site.ts) and the browser's Web Worker (src/softbody/engine.ts) run the same code, so a press in the UI
// is the very set-up that was validated.

import type { Rig } from '../anatomy/types.ts'
import type { Body } from '../../tools/rig/io.ts'
import { type CageStats, buildCage } from '../../tools/softbody/cage.ts'
import { type LoadedSoft, type MixOptions, decodeSoft, embedPoints, solverInput } from './body.ts'
import { type MaterialsFile, skinThickness, solverMaterials } from './materials.ts'
import { type PressDomain, massScale, surfaceSamples } from './press.ts'
import { siteGeometry } from './protocol.ts'
import { type PointSet, type SolverOptions, SoftSolver, type Vec3 } from './solver.ts'

export { siteGeometry }

export interface SiteOptions {
  /** 单元边长，米；缺省 = 压头半径的三分之一，限制在 2–6 mm / cell edge, metres; default = a third of the probe radius, kept within 2–6 mm */
  cell?: number
  /** 区域的半边长，米；缺省 = max(3a, a + 5 个单元) / half-size of the region, metres; default = max(3a, a + 5 cells) */
  extent?: number
  substeps?: number
  mix?: MixOptions
  solver?: SolverOptions
  inBody?: (x: number, y: number, z: number) => boolean
  /** 皮肤层怎么分到四面体（见 cage.ts 的 CageOptions.skinShare）/ how the skin layer is shared out (see CageOptions.skinShare in cage.ts) */
  skinShare?: 'area' | 'vertex'
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

export function buildSiteFrom(file: MaterialsFile, body: Body, rig: Rig, rigBin: Uint8Array, site: Vec3, outward: Vec3, probeRadius: number, o: SiteOptions = {}): Site {
  const t0 = performance.now()
  const a = probeRadius
  const { cell, extent: ext } = siteGeometry(a, o)
  const region: Site['region'] = [site[0] - ext, site[1] - ext, site[2] - ext, site[0] + ext, site[1] + ext, site[2] + ext]
  const r = buildCage(body, rig, rigBin, { cell, region, regionPin: cell, gravity: file.gravity, materials: solverMaterials(file), skinThickness: skinThickness(file), ...(o.inBody ? { inBody: o.inBody } : {}), ...(o.skinShare ? { skinShare: o.skinShare } : {}) })
  const soft = decodeSoft(r.json, r.bin)
  const t1 = performance.now()
  const skin = body.meshes.get(soft.data.skin.part)!
  const { domain, massScale } = siteDomain(file, soft, skin, site, outward, probeRadius, o)
  return { soft, domain, stats: r.stats, region, ms: { cage: Math.round(t1 - t0), solver: Math.round(performance.now() - t1) }, massScale }
}

/**
 * 由建好的细笼子组出 press() 的求解域（buildSiteFrom 的后半；GPU 的对照页面拿到的是笼子数据，从这里接着走）。
 * Assembles press()'s domain from a fine cage already built (the second half of buildSiteFrom; the GPU comparison page
 * receives the cage as data and continues from here).
 */
export function siteDomain(file: MaterialsFile, soft: LoadedSoft, skin: { positions: ArrayLike<number>; indices: ArrayLike<number> }, site: Vec3, outward: Vec3, probeRadius: number, o: SiteOptions = {}): { domain: PressDomain; massScale: number } {
  const a = probeRadius
  const { cell, extent: ext } = siteGeometry(a, o)
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
  return { domain, massScale: scale }
}
