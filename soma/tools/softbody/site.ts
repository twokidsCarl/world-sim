// 在一个部位按需建一块细笼子，并组成 press() 要的求解域（src/softbody/press.ts）。
// Builds a fine cage at a site on demand and assembles the domain press() needs (src/softbody/press.ts).
//
// 建笼子的代码在 src/softbody/site.ts（浏览器也用）；这里从磁盘读材料表，并保留两级耦合用的 linkToCoarse。
// The cage-building code lives in src/softbody/site.ts (the browser uses it too); here the material table is read from
// disk, and linkToCoarse for the two-level coupling stays.

import type { Rig } from '../../src/anatomy/types.ts'
import { type LoadedSoft, embedPoints } from '../../src/softbody/body.ts'
import type { Coupling } from '../../src/softbody/press.ts'
import { type Site, type SiteOptions, buildSiteFrom } from '../../src/softbody/site.ts'
import type { Vec3 } from '../../src/softbody/solver.ts'
import type { Body } from '../rig/io.ts'
import { readMaterials } from './build.ts'

export type { Site, SiteOptions }

export function buildSite(body: Body, rig: Rig, rigBin: Uint8Array, site: Vec3, outward: Vec3, probeRadius: number, o: SiteOptions = {}): Site {
  return buildSiteFrom(readMaterials(), body, rig, rigBin, site, outward, probeRadius, o)
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
