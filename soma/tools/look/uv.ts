// 入口：bun tools/look/uv.ts [male|female] — 给写实皮肤生成 UV 网格。
// Entry point: bun tools/look/uv.ts [male|female] — build the UV mesh of the lifelike skin.
//
// 输入 / inputs
//   data/raw/look/mhr-lod0-uv.bin            MHR LOD0 的 UV（tools/look/mhr_uv.py 生成，不入库）/ MHR LOD0's UVs (from mhr_uv.py, not in git)
//   <皮肤包>/skin.obj                          pipeline-report.json 的 skinPackage.dir（不入库）/ skinPackage.dir of pipeline-report.json (not in git)
//   public/anatomy/<body>/integumentary GLB、skin-source.u32、display.json
// 输出 / outputs
//   public/anatomy/<body>/look/skin-uv.json、skin-uv.bin（格式见 src/look/types.ts 的 SkinUvData）
//   tools/look/out/<body>/uv-layout.png        UV 布局图（不入库）/ the UV layout drawn (not in git)

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'
import type { AnatomyData } from '../../src/anatomy/types.ts'
import { type SkinUvData, UV_SCALE } from '../../src/look/types.ts'
import { Image } from '../rig/render.ts'
import { type MhrUv, mapUv } from './uvmap.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 16)

export function readMhrUv(path: string): MhrUv {
  const b = readFileSync(path)
  const head = new Uint32Array(b.buffer, b.byteOffset, 3)
  const [nV, nF, nT] = [head[0]!, head[1]!, head[2]!]
  let o = b.byteOffset + 12
  const u32 = (n: number): Uint32Array => {
    const a = new Uint32Array(b.buffer.slice(o, o + n * 4))
    o += n * 4
    return a
  }
  const faces = u32(nF * 3)
  const uvFaces = u32(nF * 3)
  const uv = new Float32Array(b.buffer.slice(o, o + nT * 8))
  return { nV, faces, uvFaces, uv }
}

export function readObjPositions(path: string): Float32Array {
  const out: number[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/)
      out.push(+p[1]!, +p[2]!, +p[3]!)
    }
  }
  return Float32Array.from(out)
}

async function readSkinMesh(bodyDir: string, partId: string): Promise<{ positions: Float32Array; indices: Uint32Array; glb: string; glbBytes: Uint8Array }> {
  await MeshoptDecoder.ready
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
  const data = JSON.parse(readFileSync(join(bodyDir, 'anatomy.json'), 'utf8')) as AnatomyData
  const part = data.parts.find((p) => p.id === partId)
  const sys = part && data.systems.find((s) => s.id === part.system)
  if (!sys?.glb) throw new Error(`skin part ${partId} or its system GLB not found`)
  const glbBytes = new Uint8Array(readFileSync(join(bodyDir, sys.glb)))
  const doc = await io.readBinary(glbBytes)
  for (const node of doc.getRoot().listNodes()) {
    if (node.getName() !== partId) continue
    const prim = node.getMesh()!.listPrimitives()[0]!
    const acc = prim.getAttribute('POSITION')!
    const m = node.getWorldMatrix()
    const n = acc.getCount()
    const positions = new Float32Array(n * 3)
    const e = [0, 0, 0]
    for (let i = 0; i < n; i++) {
      acc.getElement(i, e)
      const [x, y, z] = e as [number, number, number]
      positions[i * 3] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
      positions[i * 3 + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
      positions[i * 3 + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
    }
    return { positions, indices: Uint32Array.from(prim.getIndices()!.getArray()!), glb: sys.glb, glbBytes }
  }
  throw new Error(`skin part ${partId} has no node in ${sys.glb}`)
}

function drawLayout(path: string, uv: Float32Array, index: Uint32Array, size = 2048): void {
  const img = new Image(size, size)
  const line = (x0: number, y0: number, x1: number, y1: number): void => {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) + 1
    for (let i = 0; i <= n; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / n), y = Math.round(y0 + ((y1 - y0) * i) / n)
      if (x >= 0 && y >= 0 && x < size && y < size) img.data.fill(0, (y * size + x) * 3, (y * size + x) * 3 + 3)
    }
  }
  const P = (i: number): [number, number] => [uv[i * 2]! * size, (1 - uv[i * 2 + 1]!) * size]
  for (let t = 0; t < index.length; t += 3) {
    const a = P(index[t]!), b = P(index[t + 1]!), c = P(index[t + 2]!)
    line(...a, ...b)
    line(...b, ...c)
    line(...c, ...a)
  }
  img.save(path)
}

async function main(): Promise<void> {
  const body = process.argv[2] ?? 'male'
  const bodyDir = join(ROOT, 'public', 'anatomy', body)
  const display = JSON.parse(readFileSync(join(bodyDir, 'display.json'), 'utf8')) as { skin: { part: string; opened: boolean } }
  const report = JSON.parse(readFileSync(join(bodyDir, 'pipeline-report.json'), 'utf8')) as { skinPackage: { dir: string } }
  const mhrPath = join(ROOT, 'data', 'raw', 'look', 'mhr-lod0-uv.bin')
  if (!existsSync(mhrPath)) throw new Error(`${mhrPath} is missing: run data/raw/bodyshape/.venv/bin/python -I tools/look/mhr_uv.py first`)
  const pkgObj = join(ROOT, report.skinPackage.dir, 'skin.obj')
  const sourceBytes = new Uint8Array(readFileSync(join(bodyDir, 'skin-source.u32')))
  const skinSource = new Uint32Array(sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength))
  const skin = await readSkinMesh(bodyDir, display.skin.part)
  if (skinSource.length * 3 !== skin.positions.length) throw new Error(`skin-source.u32 has ${skinSource.length} entries, the skin ${skin.positions.length / 3} vertices`)
  const mhr = readMhrUv(mhrPath)
  const packagePositions = readObjPositions(pkgObj)

  // 发布的皮肤与包内位置应当重合（量化误差内）；不重合说明包和发布的皮肤不是同一版
  // shipped and package positions must coincide (to quantisation); otherwise package and shipped skin differ in version
  let maxOff = 0
  for (let s = 0; s < skinSource.length; s++) {
    const p = skinSource[s]! * 3
    maxOff = Math.max(maxOff, Math.hypot(packagePositions[p]! - skin.positions[s * 3]!, packagePositions[p + 1]! - skin.positions[s * 3 + 1]!, packagePositions[p + 2]! - skin.positions[s * 3 + 2]!))
  }
  if (maxOff > 0.002) throw new Error(`the skin package ${report.skinPackage.dir} does not match the shipped skin (largest offset ${(maxOff * 1000).toFixed(1)} mm)`)

  const r = mapUv({ mhr, packagePositions, skinSource, skinIndex: skin.indices })
  const n = r.skinVertex.length
  const quant = new Uint16Array(n * 2)
  for (let i = 0; i < n * 2; i++) quant[i] = Math.round(Math.min(1, Math.max(0, r.uv[i]!)) * UV_SCALE)
  const bin = new Uint8Array(n * 4 + n * 4 + r.index.length * 4)
  bin.set(new Uint8Array(r.skinVertex.buffer), 0)
  bin.set(new Uint8Array(quant.buffer), n * 4)
  bin.set(new Uint8Array(r.index.buffer), n * 8)
  const meta: SkinUvData = {
    schema: 1,
    skin: display.skin.part,
    skinVertexCount: skinSource.length,
    skinTriangleCount: skin.indices.length / 3,
    vertexCount: n,
    triangleCount: r.index.length / 3,
    inputs: { [skin.glb]: sha(skin.glbBytes), 'skin-source.u32': sha(sourceBytes), 'mhr-lod0-uv': sha(new Uint8Array(readFileSync(mhrPath))) },
    islands: r.islands,
    stats: { ...r.stats, packageOffsetMaxMm: Math.round(maxOff * 1e5) / 100 },
    source: {
      zh: 'UV 布局取自 Meta MHR v1.0.1 的 LOD0 网格（Apache-2.0），经 skin-source.u32 搬到发布的皮肤上；移植片和开口构造追加的顶点按最近的 MHR 面投影取 UV。由 tools/look/uv.ts 生成。',
      en: "The UV layout is MHR v1.0.1's LOD0 mesh (Meta, Apache-2.0), carried over to the shipped skin through skin-source.u32; vertices appended by grafts and the construction of the openings take the UV of the nearest MHR face. Built by tools/look/uv.ts.",
    },
  }
  mkdirSync(join(bodyDir, 'look'), { recursive: true })
  writeFileSync(join(bodyDir, 'look', 'skin-uv.bin'), bin)
  writeFileSync(join(bodyDir, 'look', 'skin-uv.json'), JSON.stringify(meta, null, 1) + '\n')
  const outDir = join(ROOT, 'tools', 'look', 'out', body)
  mkdirSync(outDir, { recursive: true })
  drawLayout(join(outDir, 'uv-layout.png'), r.uv, r.index)
  console.log(`${body}: ${n} vertices (${skinSource.length} skin vertices), ${r.index.length / 3} triangles, ${r.islands} islands, ${(bin.byteLength / 1e6).toFixed(2)} MB`)
  console.log(JSON.stringify(meta.stats))
}

if (import.meta.main) await main()
