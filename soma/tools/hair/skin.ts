// 读毛发生成要用的人体数据：发布的皮肤（位置、三角形、法线）、写实皮肤的 UV、头发和眉毛外壳、睑缘链。
// Reads the body data the groom generator needs: the shipped skin (positions, triangles, normals), the
// lifelike skin's UVs, the hair and eyebrow shells, and the lid-margin chains.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'
import type { AnatomyData } from '../../src/anatomy/types.ts'
import { decodeSkinUv } from '../../src/look/load.ts'
import type { SkinUvData } from '../../src/look/types.ts'

export const ROOT = join(import.meta.dirname, '..', '..')

export interface Mesh {
  id: string
  positions: Float32Array
  indices: Uint32Array
}

export interface BodyData {
  body: 'male' | 'female'
  skin: Mesh
  /** 每个皮肤顶点的面积加权法线（单位长）/ area-weighted normal per skin vertex (unit) */
  normals: Float32Array
  /** 每个皮肤顶点的 UV（接缝处取第一个副本；没有为 −1）/ UV per skin vertex (first copy at a seam; −1 when none) */
  uv: Float32Array
  /** 头发外壳、眉毛外壳（发布的，女性的头发是男性的占位）/ hair shell and eyebrow shell (as shipped; the female hair is the male's placeholder) */
  hairShell: Mesh
  browShell: Mesh
  /** 睑缘链：内眦 → 外眦，发布皮肤的顶点下标 / lid-margin chains, medial → lateral, as shipped skin vertex indices */
  lids: { upperL: number[]; lowerL: number[]; upperR: number[]; lowerR: number[] }
  /** 睑缘内卷（睑缘往眼球里卷的那几圈顶点）/ the lid rims (the rings of vertices rolling into the eye) */
  lidRims: number[]
  points: Record<string, number>
}

async function readParts(bodyDir: string, ids: string[]): Promise<Map<string, Mesh>> {
  await MeshoptDecoder.ready
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
  const data = JSON.parse(readFileSync(join(bodyDir, 'anatomy.json'), 'utf8')) as AnatomyData
  const out = new Map<string, Mesh>()
  const glbs = new Set<string>()
  for (const id of ids) {
    const part = data.parts.find((p) => p.id === id)
    const sys = part && data.systems.find((s) => s.id === part.system)
    if (!sys?.glb) throw new Error(`part ${id} or its system GLB not found`)
    glbs.add(sys.glb)
  }
  for (const glb of glbs) {
    const doc = await io.readBinary(new Uint8Array(readFileSync(join(bodyDir, glb))))
    for (const node of doc.getRoot().listNodes()) {
      const id = node.getName()
      if (!ids.includes(id) || !node.getMesh()) continue
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
      out.set(id, { id, positions, indices: Uint32Array.from(prim.getIndices()!.getArray()!) })
    }
  }
  for (const id of ids) if (!out.has(id)) throw new Error(`part ${id} has no node`)
  return out
}

/** 面积加权顶点法线 / area-weighted vertex normals */
export function vertexNormals(p: Float32Array, idx: Uint32Array): Float32Array {
  const n = new Float32Array(p.length)
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    for (const k of [a, b, c]) {
      n[k] = n[k]! + nx
      n[k + 1] = n[k + 1]! + ny
      n[k + 2] = n[k + 2]! + nz
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!) || 1
    n[i] = n[i]! / l
    n[i + 1] = n[i + 1]! / l
    n[i + 2] = n[i + 2]! / l
  }
  return n
}

export async function loadBody(body: 'male' | 'female'): Promise<BodyData> {
  const bodyDir = join(ROOT, 'public', 'anatomy', body)
  const display = JSON.parse(readFileSync(join(bodyDir, 'display.json'), 'utf8')) as { skin: { part: string } }
  const pre = body === 'female' ? 'W_' : ''
  const skinId = display.skin.part
  const parts = await readParts(bodyDir, [skinId, `${pre}FJ2813`, `${pre}FJ2812`])
  const skin = parts.get(skinId)!
  const uvMeta = JSON.parse(readFileSync(join(bodyDir, 'look', 'skin-uv.json'), 'utf8')) as SkinUvData
  const uvBin = new Uint8Array(readFileSync(join(bodyDir, 'look', 'skin-uv.bin')))
  const lu = decodeSkinUv(uvMeta, uvBin)
  const nSkin = skin.positions.length / 3
  if (uvMeta.skinVertexCount !== nSkin) throw new Error(`skin-uv is for ${uvMeta.skinVertexCount} vertices, the skin has ${nSkin}`)
  const uv = new Float32Array(nSkin * 2).fill(-1)
  for (let i = lu.skinVertex.length - 1; i >= 0; i--) {
    const s = lu.skinVertex[i]!
    uv[s * 2] = lu.uv[i * 2]!
    uv[s * 2 + 1] = lu.uv[i * 2 + 1]!
  }
  const open = JSON.parse(readFileSync(join(bodyDir, 'face', 'openings.json'), 'utf8')) as {
    vertexCount: number
    margins: Record<string, number[]>
    lidRims: { vertices: number[] }[]
    points: Record<string, number>
  }
  if (open.vertexCount !== nSkin) throw new Error(`openings.json is for ${open.vertexCount} vertices`)
  return {
    body,
    skin,
    normals: vertexNormals(skin.positions, skin.indices),
    uv,
    hairShell: parts.get(`${pre}FJ2813`)!,
    browShell: parts.get(`${pre}FJ2812`)!,
    lids: { upperL: open.margins.upperLidL!, lowerL: open.margins.lowerLidL!, upperR: open.margins.upperLidR!, lowerR: open.margins.lowerLidR! },
    lidRims: open.lidRims.flatMap((r) => r.vertices),
    points: open.points,
  }
}
