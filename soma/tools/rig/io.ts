// 为绑定构建读取已生成的人体（anatomy.json、各系统的 GLB、nerves.json）。
// 有意保持自包含：绑定是独立、可重复运行的一步，作用于几何管线最近一次写出的结果，
// 因此只依赖已发布的文件和共享的契约。
// Reading a generated body (anatomy.json, per-system GLBs, nerves.json) for the rig build.
// Self-contained on purpose: the rig is a separate, re-runnable step over whatever the geometry
// pipeline last wrote, so it only depends on the published files and the shared contract.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'
import type { AnatomyData, NervePath, Part, Relation } from '../../src/anatomy/types.ts'

export interface RawMesh {
  /** 以米为单位的扁平 xyz（已应用节点变换），按 GLB 的顶点顺序。 Flat xyz in metres (node transform applied), in the GLB's vertex order. */
  positions: Float32Array
  indices: Uint32Array
}

export interface Body {
  dir: string
  data: AnatomyData
  byId: Map<string, Part>
  meshes: Map<string, RawMesh>
  nerves: Map<string, NervePath>
  relations: Relation[]
  /** Z-Anatomy 附着斑块记录（可能为空）。 Z-Anatomy attachment patch records (possibly empty). */
  patches: unknown[]
  /** 构建绑定所用每个输入文件的 sha256（前 16 位十六进制），按文件名索引。 sha256 (first 16 hex) of every input file the rig was built from, by file name. */
  inputs: Record<string, string>
}

const sha = (buf: Uint8Array): string => createHash('sha256').update(buf).digest('hex').slice(0, 16)

export async function readBody(dir: string): Promise<Body> {
  await MeshoptDecoder.ready
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
  const inputs: Record<string, string> = {}
  const read = (name: string): Uint8Array => {
    const b = new Uint8Array(readFileSync(join(dir, name)))
    inputs[name] = sha(b)
    return b
  }
  const data = JSON.parse(new TextDecoder().decode(read('anatomy.json'))) as AnatomyData
  const meshes = new Map<string, RawMesh>()
  for (const sys of data.systems) {
    if (!sys.glb) continue
    const doc = await io.readBinary(read(sys.glb))
    for (const node of doc.getRoot().listNodes()) {
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
      meshes.set(node.getName(), { positions, indices })
    }
  }
  const nerves = new Map<string, NervePath>()
  if (existsSync(join(dir, 'nerves.json'))) {
    for (const n of JSON.parse(new TextDecoder().decode(read('nerves.json'))) as NervePath[]) nerves.set(n.part, n)
  }
  let relations: Relation[] = []
  const relPath = join(dir, '..', 'knowledge', 'relations.json')
  if (existsSync(relPath)) {
    const b = new Uint8Array(readFileSync(relPath))
    inputs['../knowledge/relations.json'] = sha(b)
    relations = JSON.parse(new TextDecoder().decode(b)) as Relation[]
  }
  // Z-Anatomy 附着斑块：原始数据目录下的可选输入（不随仓库分发）
  // Z-Anatomy attachment patches: an optional input under the raw data directory (not distributed with the repository)
  let patches: unknown[] = []
  const patchPath = join(dir, '..', '..', '..', 'data', 'raw', 'z-anatomy', 'out', 'import', 'attachments.json')
  if (existsSync(patchPath)) {
    const b = new Uint8Array(readFileSync(patchPath))
    inputs['data/raw/z-anatomy/out/import/attachments.json'] = sha(b)
    const j = JSON.parse(new TextDecoder().decode(b)) as unknown
    patches = Array.isArray(j) ? j : []
  }
  return { dir, data, byId: new Map(data.parts.map((p) => [p.id, p])), meshes, nerves, relations, patches, inputs }
}
