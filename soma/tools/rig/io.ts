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
  /** 皮肤的下标对照（没有该文件时为 null）。 The skin's index sidecar (null when the file is absent). */
  skinSource: Uint32Array | null
  /** 构建绑定所用每个输入文件的 sha256（前 16 位十六进制），按文件名索引。 sha256 (first 16 hex) of every input file the rig was built from, by file name. */
  inputs: Record<string, string>
}

const sha = (buf: Uint8Array | string): string => createHash('sha256').update(buf).digest('hex').slice(0, 16)

// ── 输入哈希 / input hashes ───────────────────────────────────────────────────────────────────
// 报告里记录的输入哈希只应反映绑定真正依赖的内容：几何文件按字节；JSON 文件只取实际读到的字段，
// 以规范形式（固定的字段和顺序）求哈希。这样改一句说明文字不会让绑定“过期”，改一个顶点或部件 id 才会。
// 记录的键为“文件名”或“文件名#方式”：
//   （无后缀）   文件的全部字节（GLB、nerves.json、.bin、.obj、.f32 …）
//   #parts       anatomy.json：body、各系统的 id 与 glb、各部件的 id/name/fma/system/tissue/side/source/
//                bbox/centroid/triangles/adjacent（按原顺序）、两棵概念树的 id/parent/parts
//   #attachments relations.json：kind 为 origin / insertion 且有 object 的关系的 (subject, kind, object)
//   #data        整理过的 JSON：去掉纯说明性的键（_doc、why、note、description …）之后的内容
//   #package     皮肤包的 manifest.json：source.name、fittedTo.body、statureM
// The input hashes recorded in the reports must reflect only what the rig really depends on:
// geometry files by their bytes; of JSON files only the fields actually read, hashed in a canonical
// form (fixed fields in a fixed order). Rewording a caution then no longer makes a rig "stale";
// changing a vertex or a part id does. Recorded keys are "file" or "file#mode" as listed above.

const PROSE_KEYS = new Set(['_doc', 'why', 'genericWhy', 'note', 'description', 'apply', 'restBasis', 'basis', 'formulas', 'quality'])

function stripProse(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripProse)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !PROSE_KEYS.has(k)).map(([k, x]) => [k, stripProse(x)]))
  return v
}

/** anatomy.json 中绑定所依赖的部分，规范形式。 The part of anatomy.json the rig depends on, in canonical form. */
export function canonicalAnatomy(data: AnatomyData): string {
  const tree = (t: AnatomyData['trees']['isa'] | undefined): unknown => (t ?? []).map((c) => [c.id, c.parent, c.parts])
  return JSON.stringify({
    body: data.body,
    systems: data.systems.map((s) => [s.id, s.glb]),
    parts: data.parts.map((p) => [p.id, p.name, p.fma, p.system, p.tissue, p.side, p.source ?? null, p.bbox, p.centroid, p.triangles, p.adjacent]),
    isa: tree(data.trees?.isa),
    partOf: tree(data.trees?.partOf),
  })
}

/** 按记录的键求某个输入的哈希；`path` 是该文件的实际路径。 Hash of one input by its recorded key; `path` is where the file is. */
export function hashInput(key: string, path: string): string {
  const mode = key.includes('#') ? key.slice(key.indexOf('#') + 1) : ''
  const bytes = new Uint8Array(readFileSync(path))
  if (!mode) return sha(bytes)
  const json = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  switch (mode) {
    case 'parts': return sha(canonicalAnatomy(json as AnatomyData))
    case 'attachments': return sha(JSON.stringify((json as Relation[]).filter((r) => (r.kind === 'origin' || r.kind === 'insertion') && r.object).map((r) => [r.subject, r.kind, r.object])))
    case 'data': return sha(JSON.stringify(stripProse(json)))
    case 'package': {
      const m = json as { source?: { name?: string }; fittedTo?: { body?: string }; statureM?: number }
      return sha(JSON.stringify([m.source?.name ?? null, m.fittedTo?.body ?? null, m.statureM ?? null]))
    }
  }
  throw new Error(`rig: unknown input hash mode "${mode}" in "${key}"`)
}

/** 记录的键对应的文件名（去掉“#方式”）。 The file a recorded key refers to (without its "#mode"). */
export const inputFile = (key: string): string => (key.includes('#') ? key.slice(0, key.indexOf('#')) : key)

/**
 * 下标对照文件名：小端 uint32，每个发布的皮肤顶点一个，值为（开口后的）皮肤包 skin.obj 的顶点下标。
 * Name of the index sidecar: little-endian uint32, one per shipped skin vertex, the vertex index in the (opened) skin package's skin.obj.
 */
export const SKIN_SOURCE_FILE = 'skin-source.u32'

export async function readBody(dir: string): Promise<Body> {
  await MeshoptDecoder.ready
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
  const inputs: Record<string, string> = {}
  const read = (name: string): Uint8Array => {
    const b = new Uint8Array(readFileSync(join(dir, name)))
    const key = name === 'anatomy.json' ? 'anatomy.json#parts' : name
    inputs[key] = hashInput(key, join(dir, name))
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
    inputs['../knowledge/relations.json#attachments'] = hashInput('../knowledge/relations.json#attachments', relPath)
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
  // 皮肤的下标对照文件（可选）：发布的皮肤的每个顶点（GLB 解码顺序）对应皮肤包里的哪个顶点
  // the skin's index sidecar (optional): for every vertex of the shipped skin (GLB decode order), the vertex of the skin package it is
  let skinSource: Uint32Array | null = null
  if (existsSync(join(dir, SKIN_SOURCE_FILE))) {
    const b = read(SKIN_SOURCE_FILE)
    skinSource = new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.byteLength & ~3)))
  }
  return { dir, data, byId: new Map(data.parts.map((p) => [p.id, p])), meshes, nerves, relations, patches, skinSource, inputs }
}
