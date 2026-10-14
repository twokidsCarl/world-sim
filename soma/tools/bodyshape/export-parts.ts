// 把一个人体（public/anatomy/<body>/）的皮肤、骨和肌肉解码成 Python 工具可用 numpy 读取的中性二进制。
// 顶点已应用 GLB 节点变换（网格是量化存储的）。
// Decode the skin, bones and muscles of one body (public/anatomy/<body>/) to a neutral binary
// that the Python tools read with numpy:
//
//   data/raw/bodyshape/bodies/<body>/<system>.f32   flat xyz float32, metres, body frame
//   data/raw/bodyshape/bodies/<body>/<system>.u32   triangle indices, local to each part
//   data/raw/bodyshape/bodies/<body>/index.json     per part: id, name, system, tissue, side,
//                                                   v0, nv (vertex range), i0, ni (index range)
//
// Positions have the GLB node transform applied (meshes are stored quantised).
//
//   bun tools/bodyshape/export-parts.ts male female

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'

// 全部系统都导出：皮肤要包住所有深部结构（肌、骨、软骨、器官等）
// every system is exported: the skin has to enclose all deep parts (muscle, bone, cartilage, organs ...)
const SYSTEMS: string[] = data0Systems()

function data0Systems(): string[] {
  const body = process.argv[2] ?? 'male'
  const d = JSON.parse(readFileSync(join(process.env.SOMA_EXPORT_FROM ?? join('public/anatomy', body), 'anatomy.json'), 'utf8'))
  return d.systems.filter((s: any) => s.glb && s.partCount > 0).map((s: any) => s.id)
}

await MeshoptDecoder.ready
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })

for (const body of process.argv.slice(2)) {
  // SOMA_EXPORT_FROM=<构建目录>：不读 public/anatomy/<body>/，改读一次试建的输出（只给一个身体时用）；
  // SOMA_EXPORT_TO=<目录>：导出写到 <目录>/<body>/，不写 data/raw/bodyshape/bodies/。都不设时与原来相同。
  // SOMA_EXPORT_FROM=<build directory>: reads a scratch build instead of public/anatomy/<body>/ (for one body at a time);
  // SOMA_EXPORT_TO=<directory>: writes <directory>/<body>/ instead of data/raw/bodyshape/bodies/. Unset, nothing changes.
  const dir = process.env.SOMA_EXPORT_FROM ?? join('public/anatomy', body)
  const out = join(process.env.SOMA_EXPORT_TO ?? 'data/raw/bodyshape/bodies', body)
  mkdirSync(out, { recursive: true })
  const data = JSON.parse(readFileSync(join(dir, 'anatomy.json'), 'utf8'))
  const byId = new Map<string, any>(data.parts.map((p: any) => [p.id, p]))
  const index: any[] = []
  for (const system of SYSTEMS) {
    const doc = await io.read(join(dir, `${system}.glb`))
    const pos: Float32Array[] = []
    const idx: Uint32Array[] = []
    let v0 = 0
    let i0 = 0
    for (const node of doc.getRoot().listNodes()) {
      const prim = node.getMesh()?.listPrimitives()[0]
      const part = byId.get(node.getName())
      if (!prim || !part) continue
      const acc = prim.getAttribute('POSITION')!
      const m = node.getWorldMatrix()
      const n = acc.getCount()
      const p = new Float32Array(n * 3)
      const e = [0, 0, 0]
      for (let i = 0; i < n; i++) {
        acc.getElement(i, e)
        const x = e[0]!, y = e[1]!, z = e[2]!
        p[i * 3] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
        p[i * 3 + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
        p[i * 3 + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
      }
      const ia = prim.getIndices()
      const t = ia ? Uint32Array.from(ia.getArray()!) : Uint32Array.from({ length: n }, (_, i) => i)
      pos.push(p)
      idx.push(t)
      index.push({
        id: part.id, name: part.name, system, tissue: part.tissue, side: part.side,
        provenance: part.provenance, bbox: part.bbox, v0, nv: n, i0, ni: t.length,
      })
      v0 += n
      i0 += t.length
    }
    const P = new Float32Array(v0 * 3)
    const I = new Uint32Array(i0)
    let a = 0
    for (const p of pos) { P.set(p, a); a += p.length }
    a = 0
    for (const t of idx) { I.set(t, a); a += t.length }
    writeFileSync(join(out, `${system}.f32`), new Uint8Array(P.buffer))
    writeFileSync(join(out, `${system}.u32`), new Uint8Array(I.buffer))
    console.log(body, system, pos.length, 'parts', v0, 'vertices', i0 / 3, 'triangles')
  }
  writeFileSync(join(out, 'index.json'), JSON.stringify({ body, systems: SYSTEMS, parts: index }))
}
