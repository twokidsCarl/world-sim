// Loading a built body (public/anatomy/<body>) back into memory: anatomy.json, world-space
// meshes from the GLBs, nerve centrelines.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AnatomyData, NervePath, Part } from '../../src/anatomy/types.ts'
import type { Mesh } from './geometry.ts'
import { readGlb } from './glb.ts'
import type { Polyline } from './tube.ts'

export interface BuiltBody {
  data: AnatomyData
  parts: Map<string, Part>
  /** world-space meshes (node transforms applied), by part id */
  meshes: Map<string, Mesh>
  /** centrelines by part id */
  nerves: Map<string, Polyline[]>
}

export async function loadBuiltBody(dir: string, only?: (part: Part) => boolean): Promise<BuiltBody> {
  const data = JSON.parse(readFileSync(join(dir, 'anatomy.json'), 'utf8')) as AnatomyData
  const parts = new Map(data.parts.map((p) => [p.id, p]))
  const meshes = new Map<string, Mesh>()
  for (const s of data.systems) {
    if (!s.glb) continue
    if (only && !data.parts.some((p) => p.system === s.id && only(p))) continue
    const doc = await readGlb(join(dir, s.glb))
    for (const node of doc.getRoot().listNodes()) {
      const part = parts.get(node.getName())
      if (!part || (only && !only(part))) continue
      const prim = node.getMesh()!.listPrimitives()[0]!
      const pos = prim.getAttribute('POSITION')!
      const m = node.getWorldMatrix()
      const positions = new Float32Array(pos.getCount() * 3)
      const v = [0, 0, 0]
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v)
        positions[3 * i] = v[0]! * m[0]! + m[12]!
        positions[3 * i + 1] = v[1]! * m[5]! + m[13]!
        positions[3 * i + 2] = v[2]! * m[10]! + m[14]!
      }
      meshes.set(part.id, { positions, indices: Uint32Array.from(prim.getIndices()!.getArray()!) })
    }
  }
  const nerves = new Map<string, Polyline[]>()
  const nervesFile = join(dir, 'nerves.json')
  if (existsSync(nervesFile)) {
    for (const n of JSON.parse(readFileSync(nervesFile, 'utf8')) as NervePath[]) {
      nerves.set(n.part, n.branches.map((b) => ({ points: Float32Array.from(b.points), radius: Float32Array.from(b.radius) })))
    }
  }
  return { data, parts, meshes, nerves }
}
