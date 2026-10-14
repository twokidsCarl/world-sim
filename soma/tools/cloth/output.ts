// 穿好的衣服 → 发布的数据：public/anatomy/<body>/cloth/<garment>.{json,bin}，外加检查指标。
// A dressed garment → the published data: public/anatomy/<body>/cloth/<garment>.{json,bin}, plus check metrics.
//
// <garment>.bin 里依次是（每段 4 字节对齐）/ <garment>.bin holds, in order (each block 4-byte aligned):
//   position   f32 × 3 · n   静止姿势下穿好的位置（米）/ dressed positions at rest (metres)
//   uv         f32 × 2 · n   裁片坐标（米），u = 纬向，v = 经向 / pattern coordinates (m), u = weft, v = warp
//   index      u16|u32 × 3 · t
//   stitch     u16|u32 × 2 · s   缝合顶点对 / stitched vertex pairs
//   bindVert   u32 × 3 · n   最近的皮肤三角形的三个顶点（皮肤顶点下标，GLB 解码顺序；不依赖三角形的次序）
//                            the three corners of the nearest skin triangle (skin vertex indices in GLB decode order;
//                            independent of the triangle order)
//   bindBary   f32 × 2 · n   投影到该三角形平面的重心坐标 (b1, b2)，b0 = 1 − b1 − b2（可略出界）
//                            barycentrics (b1, b2) of the projection onto that triangle's plane, b0 = 1 − b1 − b2 (may lie slightly outside)
//   bindOffset f32 × n       沿该三角形面法线的距离（米）/ distance along that triangle's face normal (metres)
//   edgeKind   i8 × n        边类型（json 的 edgeKinds 下标，内部点 −1）/ edge kind (index into the json's edgeKinds, −1 inside)
//   panel      u8 × n        所属裁片（json 的 panels 下标）/ panel (index into the json's panels)
// 由绑定重建位置：p = Σ b_i·v_i + h·n̂，n̂ 为三角形 (v0, v1, v2) 的单位面法线 (v1 − v0) × (v2 − v0)。
// Rebuilding a position from the binding: p = Σ b_i·v_i + h·n̂, n̂ the unit face normal (v1 − v0) × (v2 − v0) of the triangle.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MeshCollider, type Closest } from '../../src/cloth/collider.ts'
import { planeBinding } from '../../src/cloth/attach.ts'
import type { ClothSolver, FabricMechanics } from '../../src/cloth/solver.ts'
import type { SkinBody } from './body.ts'
import { EDGE_KINDS, type GarmentMesh, type GcSpec } from './pattern.ts'

export interface DressReport {
  garment: string
  vertices: number
  triangles: number
  stitchPairs: number
  /** 毫米 / millimetres */
  maxPenetrationMm: number
  p99PenetrationMm: number
  verticesInsideOver1mm: number
  maxStitchGapMm: number
  /** 面积加权的经、纬向应变（%）/ Area-weighted warp and weft strain (%). */
  strain: { weftMeanPct: number; warpMeanPct: number; weftP95Pct: number; warpP95Pct: number; weftMaxPct: number; warpMaxPct: number }
  bytes: number
}

/** 皮肤上离点最近的三角形（先查哈希，查不到就全扫）/ The skin triangle nearest a point (hash first, a full scan when that misses). */
export class SkinQuery {
  readonly near: MeshCollider
  constructor(readonly skin: Float32Array, readonly index: Uint32Array) {
    this.near = new MeshCollider(skin, index, 0.03, 0.04)
  }
  closest(x: number, y: number, z: number, out: Closest): void {
    if (this.near.closest(x, y, z, out)) return
    // 全扫：只看三角形重心最近的一批 / full scan over the triangles with the nearest centroids
    const P = this.skin, I = this.index
    let best = Infinity, bt = 0
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t]! * 3, b = I[t + 1]! * 3, c = I[t + 2]! * 3
      const d = ((P[a]! + P[b]! + P[c]!) / 3 - x) ** 2 + ((P[a + 1]! + P[b + 1]! + P[c + 1]!) / 3 - y) ** 2 + ((P[a + 2]! + P[b + 2]! + P[c + 2]!) / 3 - z) ** 2
      if (d < best) {
        best = d
        bt = t / 3
      }
    }
    // 用一个只含附近三角形的临时碰撞体求精确最近点 / exact closest point from a temporary collider holding the nearby triangles
    const r = Math.sqrt(best) + 0.03
    const keep: number[] = []
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t]! * 3
      if ((P[a]! - x) ** 2 + (P[a + 1]! - y) ** 2 + (P[a + 2]! - z) ** 2 < r * r) keep.push(I[t]!, I[t + 1]!, I[t + 2]!)
    }
    const tmp = new MeshCollider(P, keep, r * 2.2, r * 2.2)
    if (!tmp.closest(x, y, z, out)) {
      out.tri = bt
      out.b0 = out.b1 = out.b2 = 1 / 3
      out.signed = Math.sqrt(best)
      return
    }
    // tmp 的三角形下标是 keep 里的，换回皮肤的 / tmp's triangle index is into `keep`; map back to the skin's
    const ta = keep[out.tri * 3]!, tb = keep[out.tri * 3 + 1]!, tc = keep[out.tri * 3 + 2]!
    for (let t = 0; t < I.length; t += 3) if (I[t] === ta && I[t + 1] === tb && I[t + 2] === tc) out.tri = t / 3
  }
}

function percentile(values: number[], weights: number[], p: number): number {
  const idx = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!)
  const total = weights.reduce((s, w) => s + w, 0)
  let acc = 0
  for (const i of idx) {
    acc += weights[i]!
    if (acc >= p * total) return values[i]!
  }
  return values[idx[idx.length - 1]!]!
}

export function clothDir(b: SkinBody): string {
  return join(b.dir, 'cloth')
}

export function writeGarment(b: SkinBody, garment: string, spec: GcSpec, mesh: GarmentMesh, solver: ClothSolver, fabric: FabricMechanics): DressReport {
  const n = solver.n
  const x = solver.x
  const q = new SkinQuery(b.rest, b.indices)
  const c: Closest = { tri: 0, b0: 0, b1: 0, b2: 0, signed: 0, qx: 0, qy: 0, qz: 0, nx: 0, ny: 0, nz: 0 }
  const bindVert = new Uint32Array(n * 3), bindBary = new Float32Array(n * 2), bindOffset = new Float32Array(n)
  const pen: number[] = []
  for (let i = 0; i < n; i++) {
    q.closest(x[i * 3]!, x[i * 3 + 1]!, x[i * 3 + 2]!, c)
    pen.push(Math.max(0, -c.signed))
    const [b1, b2, h] = planeBinding(b.rest, b.indices, c.tri, x[i * 3]!, x[i * 3 + 1]!, x[i * 3 + 2]!)
    for (let k = 0; k < 3; k++) bindVert[i * 3 + k] = b.indices[c.tri * 3 + k]!
    bindBary[i * 2] = b1
    bindBary[i * 2 + 1] = b2
    bindOffset[i] = h
  }
  const st = solver.strains()
  const areas = Array.from(solver.triArea)
  const weft = Array.from(st.weft), warp = Array.from(st.warp)
  const mean = (v: number[]): number => v.reduce((s, x, i) => s + x * areas[i]!, 0) / areas.reduce((s, a) => s + a, 0)
  const sortedPen = pen.slice().sort((a, b) => a - b)
  const report: DressReport = {
    garment,
    vertices: n,
    triangles: mesh.triangles.length / 3,
    stitchPairs: mesh.stitches.length / 2,
    maxPenetrationMm: +(sortedPen[n - 1]! * 1000).toFixed(2),
    p99PenetrationMm: +(sortedPen[Math.floor(0.99 * (n - 1))]! * 1000).toFixed(2),
    verticesInsideOver1mm: pen.filter((p) => p > 0.001).length,
    maxStitchGapMm: +(solver.maxStitchGap() * 1000).toFixed(2),
    strain: {
      weftMeanPct: +(mean(weft) * 100).toFixed(1),
      warpMeanPct: +(mean(warp) * 100).toFixed(1),
      weftP95Pct: +(percentile(weft, areas, 0.95) * 100).toFixed(1),
      warpP95Pct: +(percentile(warp, areas, 0.95) * 100).toFixed(1),
      weftMaxPct: +(Math.max(...weft) * 100).toFixed(1),
      warpMaxPct: +(Math.max(...warp) * 100).toFixed(1),
    },
    bytes: 0,
  }

  // 二进制 / binary
  const wide = n > 65535
  const blocks: { name: string; data: ArrayBufferView; type: string; itemSize: number }[] = [
    { name: 'position', data: Float32Array.from(x), type: 'f32', itemSize: 3 },
    { name: 'uv', data: Float32Array.from(mesh.uv), type: 'f32', itemSize: 2 },
    { name: 'index', data: wide ? Uint32Array.from(mesh.triangles) : Uint16Array.from(mesh.triangles), type: wide ? 'u32' : 'u16', itemSize: 3 },
    { name: 'stitch', data: wide ? Uint32Array.from(mesh.stitches) : Uint16Array.from(mesh.stitches), type: wide ? 'u32' : 'u16', itemSize: 2 },
    { name: 'bindVert', data: bindVert, type: 'u32', itemSize: 3 },
    { name: 'bindBary', data: bindBary, type: 'f32', itemSize: 2 },
    { name: 'bindOffset', data: bindOffset, type: 'f32', itemSize: 1 },
    { name: 'edgeKind', data: Int8Array.from(mesh.edgeKind), type: 'i8', itemSize: 1 },
    { name: 'panel', data: Uint8Array.from(mesh.panelOf), type: 'u8', itemSize: 1 },
  ]
  let off = 0
  const layout: Record<string, { offset: number; count: number; type: string; itemSize: number }> = {}
  const parts: Uint8Array[] = []
  for (const blk of blocks) {
    const bytes = new Uint8Array(blk.data.buffer, blk.data.byteOffset, blk.data.byteLength)
    layout[blk.name] = { offset: off, count: bytes.byteLength / (blk.type.endsWith('32') ? 4 : blk.type.endsWith('16') ? 2 : 1), type: blk.type, itemSize: blk.itemSize }
    parts.push(bytes)
    off += bytes.byteLength
    const pad = (4 - (off % 4)) % 4
    if (pad) {
      parts.push(new Uint8Array(pad))
      off += pad
    }
  }
  const bin = new Uint8Array(off)
  let o = 0
  for (const p of parts) {
    bin.set(p, o)
    o += p.byteLength
  }
  const doc = {
    schema: 1,
    body: b.id,
    garment,
    skin: b.skinId,
    skinVertexCount: b.rest.length / 3,
    skinTriangleCount: b.indices.length / 3,
    vertexCount: n,
    triangleCount: mesh.triangles.length / 3,
    fabric: { id: spec.soma.fabric, ...fabric },
    ease: spec.soma.ease,
    lengthScale: spec.soma.lengthScale,
    panels: mesh.panels.map((p) => ({ name: p.name, part: p.part, front: p.front, offset: p.offset, count: p.count })),
    edgeKinds: EDGE_KINDS,
    buffers: layout,
    checks: report,
    source: {
      pattern: `data/curated/cloth/patterns/${b.id}-${garment}.json`,
      generator: 'GarmentCode (pygarment), MIT; dressed by tools/cloth/dress.ts',
    },
  }
  const dir = clothDir(b)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${garment}.bin`), bin)
  const json = JSON.stringify(doc, null, 1)
  writeFileSync(join(dir, `${garment}.json`), json)
  report.bytes = bin.byteLength + json.length
  // 再写一次，带上大小 / once more, with the size
  doc.checks = report
  writeFileSync(join(dir, `${garment}.json`), JSON.stringify(doc, null, 1))
  updateIndex(b)
  writeDebugObj(b, garment, mesh, x)
  return report
}

function updateIndex(b: SkinBody): void {
  // 按目录里现有的衣服重写（几件衣服可以并行生成）/ rewritten from the garments in the directory (several may be built in parallel)
  const dir = clothDir(b)
  const garments: Record<string, unknown> = {}
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json').sort()) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { garment: string; fabric: { id: string }; vertexCount: number; triangleCount: number; checks: DressReport }
    garments[d.garment] = { file: f, fabric: d.fabric.id, vertices: d.vertexCount, triangles: d.triangleCount, bytes: d.checks.bytes }
  }
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ schema: 1, body: b.id, garments }, null, 1))
}

/** 调试用的 OBJ（不提交）/ A debug OBJ (not committed). */
function writeDebugObj(b: SkinBody, garment: string, mesh: GarmentMesh, x: Float64Array): void {
  const dir = join(b.dir, '..', '..', '..', 'data', 'raw', 'cloth', 'work', 'obj')
  mkdirSync(dir, { recursive: true })
  const lines: string[] = []
  for (let i = 0; i < x.length; i += 3) lines.push(`v ${x[i]!.toFixed(5)} ${x[i + 1]!.toFixed(5)} ${x[i + 2]!.toFixed(5)}`)
  for (let t = 0; t < mesh.triangles.length; t += 3) lines.push(`f ${mesh.triangles[t]! + 1} ${mesh.triangles[t + 1]! + 1} ${mesh.triangles[t + 2]! + 1}`)
  writeFileSync(join(dir, `${b.id}-${garment}.obj`), lines.join('\n'))
}
