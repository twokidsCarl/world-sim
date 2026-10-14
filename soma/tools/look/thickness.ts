// 入口：bun tools/look/thickness.ts [male|female ...] — 皮肤每处"往里有多厚"：从每个 MHR 顶点沿内法线方向的一个小锥里射九条线，
// 取穿出身体处距离的中位数（耳廓、鼻翼、指蹼薄，躯干厚）。透光项用它，只让薄处透红光。
// Entry point: bun tools/look/thickness.ts [male|female ...] — how thick the body is under each patch of skin: nine
// rays per MHR vertex in a small cone around the inward normal, the median distance to where they leave the body
// (thin at the auricle, nasal alae and finger webs; thick on the trunk). The transmission term uses it so only thin parts let red light through.
//
// 输入 / inputs: data/raw/look/mhr-lod0-uv.bin，皮肤包的 skin.obj（前 nV 个顶点是 MHR 的）/ the skin package's skin.obj (its first nV vertices are MHR's)
// 输出 / output: data/raw/skin/thickness-<body>.f32（每个 MHR 顶点一个，毫米；不入库，tools/look/skin_regions.py 读）
//                one per MHR vertex, in mm; not in git, read by tools/look/skin_regions.py

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { readMhrUv, readObjPositions } from './uv.ts'

const ROOT = join(import.meta.dirname, '..', '..')
/** 射线没有穿出时记的厚度（毫米）/ the thickness recorded when a ray does not come out (mm) */
export const MAX_MM = 60
const CONE = (25 * Math.PI) / 180
const MIN_HIT_MM = 0.5

export function vertexNormals(P: Float32Array, F: Uint32Array, nV: number): Float32Array {
  const N = new Float32Array(nV * 3)
  for (let t = 0; t < F.length; t += 3) {
    const a = F[t]! * 3, b = F[t + 1]! * 3, c = F[t + 2]! * 3
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!
    const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    for (const i of [a, b, c]) {
      N[i] = N[i]! + nx
      N[i + 1] = N[i + 1]! + ny
      N[i + 2] = N[i + 2]! + nz
    }
  }
  for (let i = 0; i < nV; i++) {
    const l = Math.hypot(N[i * 3]!, N[i * 3 + 1]!, N[i * 3 + 2]!) || 1
    N[i * 3] = N[i * 3]! / l
    N[i * 3 + 1] = N[i * 3 + 1]! / l
    N[i * 3 + 2] = N[i * 3 + 2]! / l
  }
  return N
}

/** 每个顶点的厚度（毫米）/ thickness per vertex (mm) */
export function thickness(P: Float32Array, F: Uint32Array, nV: number): Float32Array {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(P, 3))
  g.setIndex(new BufferAttribute(F, 1))
  const bvh = new MeshBVH(g)
  const N = vertexNormals(P, F, nV)
  const out = new Float32Array(nV)
  const ray = new Ray()
  const n = new Vector3(), t1 = new Vector3(), t2 = new Vector3(), d = new Vector3()
  const dists: number[] = []
  for (let i = 0; i < nV; i++) {
    n.set(-N[i * 3]!, -N[i * 3 + 1]!, -N[i * 3 + 2]!)
    t1.set(Math.abs(n.x) < 0.9 ? 1 : 0, Math.abs(n.x) < 0.9 ? 0 : 1, 0).cross(n).normalize()
    t2.crossVectors(n, t1)
    dists.length = 0
    for (let k = 0; k < 9; k++) {
      if (k === 0) d.copy(n)
      else {
        const a = ((k - 1) / 8) * Math.PI * 2
        d.copy(n).multiplyScalar(Math.cos(CONE)).addScaledVector(t1, Math.sin(CONE) * Math.cos(a)).addScaledVector(t2, Math.sin(CONE) * Math.sin(a)).normalize()
      }
      ray.origin.set(P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!).addScaledVector(n, 0.0002)
      ray.direction.copy(d)
      let best = MAX_MM
      for (const h of bvh.raycast(ray, DoubleSide)) {
        const mm = (h.distance + 0.0002) * 1000
        if (mm > MIN_HIT_MM && mm < best) best = mm
      }
      dists.push(best)
    }
    dists.sort((a, b) => a - b)
    out[i] = dists[4]!
  }
  return out
}

function main(): void {
  const bodies = process.argv.slice(2).length ? process.argv.slice(2) : ['male', 'female']
  const mhr = readMhrUv(join(ROOT, 'data', 'raw', 'look', 'mhr-lod0-uv.bin'))
  for (const body of bodies) {
    const report = JSON.parse(readFileSync(join(ROOT, 'public', 'anatomy', body, 'pipeline-report.json'), 'utf8')) as { skinPackage: { dir: string } }
    const all = readObjPositions(join(ROOT, report.skinPackage.dir, 'skin.obj'))
    const P = all.slice(0, mhr.nV * 3)
    const t0 = performance.now()
    const th = thickness(P, mhr.faces, mhr.nV)
    const outDir = join(ROOT, 'data', 'raw', 'skin')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, `thickness-${body}.f32`), new Uint8Array(th.buffer))
    const sorted = Float32Array.from(th).sort()
    console.log(`${body}: ${mhr.nV} vertices, thickness median ${sorted[sorted.length >> 1]!.toFixed(1)} mm, 5% ${sorted[Math.floor(sorted.length * 0.05)]!.toFixed(1)} mm, ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  }
}

if (import.meta.main) main()
