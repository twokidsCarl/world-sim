// 读取已生成的解剖数据：GLB 部件解码为米制坐标，以及 anatomy.json、nerves.json。
// 自成一体（不引用 tools/pipeline），皮肤分区图可单独重建。
// Reading the generated anatomy data: GLB parts decoded to metres, anatomy.json, nerves.json.
// Self-contained (does not import tools/pipeline) so the skin maps can be rebuilt on their own.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'
import type { AnatomyData, NervePath, Part } from '../../src/anatomy/types.ts'

export interface RawMesh {
  /**
   * 展平的 xyz，单位米（已应用节点变换），顺序与 GLB 顶点顺序一致。
   * Flat xyz in metres (node transform applied), in the GLB's vertex order.
   */
  positions: Float32Array
  indices: Uint32Array
}

async function io(): Promise<NodeIO> {
  await MeshoptDecoder.ready
  return new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
}

/**
 * 解码某一系统 GLB 中指定名称的节点（省略 ids 时解码全部）。
 * Decodes the named nodes (all when `ids` is omitted) of one system GLB.
 */
export async function readGlbParts(path: string, ids?: Set<string>): Promise<Map<string, RawMesh>> {
  const doc = await (await io()).read(path)
  const out = new Map<string, RawMesh>()
  for (const node of doc.getRoot().listNodes()) {
    const id = node.getName()
    if (ids && !ids.has(id)) continue
    const prim = node.getMesh()?.listPrimitives()[0]
    if (!prim) continue
    const acc = prim.getAttribute('POSITION')!
    const m = node.getWorldMatrix()
    const n = acc.getCount()
    const positions = new Float32Array(n * 3)
    const e = [0, 0, 0]
    for (let i = 0; i < n; i++) {
      acc.getElement(i, e)
      const x = e[0]!, y = e[1]!, z = e[2]!
      positions[i * 3] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
      positions[i * 3 + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
      positions[i * 3 + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
    }
    const idx = prim.getIndices()
    const indices = idx ? Uint32Array.from(idx.getArray()!) : Uint32Array.from({ length: n }, (_, i) => i)
    out.set(id, { positions, indices })
  }
  return out
}

export interface Body {
  dir: string
  data: AnatomyData
  byId: Map<string, Part>
  nerves: NervePath[]
}

export function readBody(dir: string): Body {
  const data = JSON.parse(readFileSync(join(dir, 'anatomy.json'), 'utf8')) as AnatomyData
  const nerves = JSON.parse(readFileSync(join(dir, 'nerves.json'), 'utf8')) as NervePath[]
  return { dir, data, byId: new Map(data.parts.map((p) => [p.id, p])), nerves }
}

/**
 * 解码后皮肤顶点坐标（取整到 0.01 mm）与索引的哈希，用于发现皮肤网格是否变动。
 * Hash of the decoded skin positions (rounded to 0.01 mm) and indices; used to detect a changed skin.
 */
export function meshHash(m: RawMesh): string {
  const q = new Int32Array(m.positions.length)
  for (let i = 0; i < q.length; i++) q[i] = Math.round(m.positions[i]! * 1e5)
  return createHash('sha256').update(new Uint8Array(q.buffer)).update(new Uint8Array(m.indices.buffer)).digest('hex').slice(0, 16)
}
