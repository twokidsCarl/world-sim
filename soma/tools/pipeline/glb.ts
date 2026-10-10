// GLB output: one file per system, one node + one mesh per part, node name = part id.
// EXT_meshopt_compression + KHR_mesh_quantization.
//
// Quantisation is per mesh (14-bit positions over the part's own bounds, 10-bit normals), so
// every node carries a translation + scale that maps the stored integers back to metres. Apply
// the node transform (any standard glTF loader does) to get the contract's coordinates.

import { writeFileSync } from 'node:fs'
import { Document, Logger, NodeIO } from '@gltf-transform/core'
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import { meshopt } from '@gltf-transform/functions'
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer'

export interface GlbPart {
  id: string
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
}

export const POSITION_BITS = 14
export const NORMAL_BITS = 10

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

export async function writeSystemGlb(path: string, systemId: string, color: string, parts: GlbPart[]): Promise<number> {
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
  await doc.transform(
    meshopt({
      encoder: MeshoptEncoder,
      level: 'medium',
      quantizePosition: POSITION_BITS,
      quantizeNormal: NORMAL_BITS,
      quantizationVolume: 'mesh',
    }),
  )
  const bytes = await (await io()).writeBinary(doc)
  writeFileSync(path, bytes)
  return bytes.byteLength
}

export async function readGlb(path: string): Promise<Document> {
  return (await io()).read(path)
}
