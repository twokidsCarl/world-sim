// GLB 输出：每个系统一个文件，每个部件一个节点和一张网格，节点名 = 部件 id。
// EXT_meshopt_compression + KHR_mesh_quantization。
//
// 量化按网格进行（位置在部件自己的包围盒内取 14 位，法线 10 位），所以每个节点都带一个平移和缩放，
// 把存下来的整数变回米。应用节点变换（任何标准 glTF 加载器都会做）即得约定的坐标。
// 个别部件可以要求更多的位置位数（GlbPart.positionBits）：开口后的皮肤用 16 位，因为唇内面两壁只相距
// 0.05–0.5 mm，而 14 位在整张皮肤上的步长约 0.1 mm。其余部件的写法不变。
// 写出时顶点会被重排（顶点缓存优化），但不会按位置合并：位置重合的顶点仍是各自的顶点。
//
// GLB output: one file per system, one node + one mesh per part, node name = part id.
// EXT_meshopt_compression + KHR_mesh_quantization.
//
// Quantisation is per mesh (14-bit positions over the part's own bounds, 10-bit normals), so
// every node carries a translation + scale that maps the stored integers back to metres. Apply
// the node transform (any standard glTF loader does) to get the contract's coordinates.
// A part may ask for more position bits (GlbPart.positionBits): the opened skin takes 16, because
// its inner-lip walls lie only 0.05–0.5 mm apart while 14 bits over the whole skin step by about
// 0.1 mm. Every other part is written as before.
// Writing reorders the vertices (vertex cache optimisation) but never merges them by position:
// coincident vertices stay separate vertices.

import { writeFileSync } from 'node:fs'
import { Document, Logger, NodeIO, PropertyType, type Scene } from '@gltf-transform/core'
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import { dedup, mergeDocuments, meshopt, unpartition } from '@gltf-transform/functions'
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer'

export interface GlbPart {
  id: string
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  /**
   * 这个部件的位置量化位数（8–16）；缺省为 POSITION_BITS
   * position quantisation bits for this part (8–16); POSITION_BITS when absent
   */
  positionBits?: number
}

export const POSITION_BITS = 14
export const NORMAL_BITS = 10
/** 开口后的皮肤的位置位数 / position bits of an opened skin */
export const OPENED_SKIN_POSITION_BITS = 16

/**
 * 位置量化的步长（米）：部件包围盒最长边的一半除以 2^(bits−1) − 1。重建误差每轴不超过半步。
 * The step of the position quantisation (metres): half the longest side of the part's bounding box
 * divided by 2^(bits−1) − 1. The reconstruction error is at most half a step per axis.
 */
export function positionStep(positions: Float32Array, bits: number): number {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) {
    b[k] = Math.min(b[k]!, positions[i + k]!)
    b[k + 3] = Math.max(b[k + 3]!, positions[i + k]!)
  }
  return Math.max(b[3]! - b[0]!, b[4]! - b[1]!, b[5]! - b[2]!) / 2 / (2 ** (bits - 1) - 1)
}

/**
 * writeSystemGlb 写出一张网格时顶点的新次序：remap[v] 是输入顶点 v 在 GLB 里的下标（没有三角形用到的
 * 顶点为 0xffffffff，它们不会被写出），indices 是重排后的索引，vertices 是写出的顶点数。
 * 这里调用的正是写出时所用的同一个函数（meshoptimizer 的 reorderMesh，按“体积优先”），输入相同则结果相同；
 * 调用方应当读回 GLB 核对（见 skinOpened.ts 的 skinSourceSidecar）。
 * The order in which writeSystemGlb writes the vertices of a mesh: remap[v] is the index input vertex v
 * gets in the GLB (0xffffffff for a vertex no triangle uses; those are not written), `indices` the
 * reordered index buffer and `vertices` the number of vertices written. This calls the very function
 * the writer uses (meshoptimizer's reorderMesh, optimising for size), which gives the same result for
 * the same input; the caller should read the GLB back and check (skinSourceSidecar in skinOpened.ts).
 */
export async function glbVertexOrder(indices: Uint32Array): Promise<{ remap: Uint32Array; indices: Uint32Array; vertices: number }> {
  await MeshoptEncoder.ready
  const copy = indices.slice()
  const [remap, vertices] = MeshoptEncoder.reorderMesh(copy, true, true)
  return { remap, indices: copy, vertices }
}

async function io(): Promise<NodeIO> {
  await MeshoptEncoder.ready
  await MeshoptDecoder.ready
  return new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder })
}

const hexToLinear = (hex: string): [number, number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`bad colour ${hex}`)
  const v = parseInt(m[1]!, 16)
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return [lin((v >> 16) & 255), lin((v >> 8) & 255), lin(v & 255), 1]
}

function buildDocument(systemId: string, color: string, parts: GlbPart[]): Document {
  const doc = new Document()
  doc.setLogger(new Logger(Logger.Verbosity.WARN))
  doc.getRoot().getAsset().generator = 'soma pipeline'
  const buffer = doc.createBuffer()
  const scene = doc.createScene(systemId)
  doc.getRoot().setDefaultScene(scene)
  const material = doc
    .createMaterial(systemId)
    .setBaseColorFactor(hexToLinear(color))
    .setRoughnessFactor(0.75)
    .setMetallicFactor(0)
  for (const p of parts) {
    const nv = p.positions.length / 3
    const position = doc.createAccessor().setType('VEC3').setArray(p.positions as Float32Array<ArrayBuffer>).setBuffer(buffer)
    const normal = doc.createAccessor().setType('VEC3').setArray(p.normals as Float32Array<ArrayBuffer>).setBuffer(buffer)
    const indices = doc
      .createAccessor()
      .setType('SCALAR')
      .setArray(nv <= 0xffff ? Uint16Array.from(p.indices) : (p.indices as Uint32Array<ArrayBuffer>))
      .setBuffer(buffer)
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', position)
      .setAttribute('NORMAL', normal)
      .setIndices(indices)
      .setMaterial(material)
    const mesh = doc.createMesh(p.id).addPrimitive(prim)
    scene.addChild(doc.createNode(p.id).setMesh(mesh))
  }
  return doc
}

const compress = (doc: Document, positionBits: number): Promise<Document> =>
  doc.transform(
    meshopt({
      encoder: MeshoptEncoder,
      level: 'medium',
      quantizePosition: positionBits,
      quantizeNormal: NORMAL_BITS,
      quantizationVolume: 'mesh',
    }),
  )

export async function writeSystemGlb(path: string, systemId: string, color: string, parts: GlbPart[]): Promise<number> {
  // 要求别的位数的部件各自成组、单独量化，再并入主文档；没有这样的部件时走的是原来那一条路，输出逐字节不变
  // parts asking for other bit counts are quantised in groups of their own and merged into the main document; with no such part the path is the original one and the output is byte for byte what it was
  const bitsOf = (p: GlbPart): number => p.positionBits ?? POSITION_BITS
  const special = parts.filter((p) => bitsOf(p) !== POSITION_BITS)
  const doc = buildDocument(systemId, color, special.length ? parts.filter((p) => bitsOf(p) === POSITION_BITS) : parts)
  await compress(doc, POSITION_BITS)
  if (special.length) {
    const scene = doc.getRoot().listScenes()[0]!
    for (const bits of [...new Set(special.map(bitsOf))].sort((a, b) => a - b)) {
      const extra = buildDocument(systemId, color, special.filter((p) => bitsOf(p) === bits))
      await compress(extra, bits)
      const map = mergeDocuments(doc, extra)
      const other = map.get(extra.getRoot().listScenes()[0]!) as Scene
      for (const node of other.listChildren()) scene.addChild(node)
      other.dispose()
    }
    doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE })
    // 合并带来的重复材质并成一个，几个缓冲并成一个；不碰网格和访问器 / the duplicate materials of the merge become one and the buffers one; meshes and accessors are not touched
    await doc.transform(dedup({ propertyTypes: [PropertyType.MATERIAL] }), unpartition())
  }
  const bytes = await (await io()).writeBinary(doc)
  writeFileSync(path, bytes)
  return bytes.byteLength
}

export async function readGlb(path: string): Promise<Document> {
  return (await io()).read(path)
}
