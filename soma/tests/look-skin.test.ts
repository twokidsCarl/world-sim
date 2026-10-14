// 写实皮肤：UV 网格数据（look/skin-uv.*）与发布的皮肤对得上；解码拒绝坏文件；地址里的 look 参数。
// The lifelike skin: the UV mesh (look/skin-uv.*) fits the shipped skin; decoding refuses bad files; the look URL parameter.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeSkinUv } from '../src/look/load.ts'
import { closestOnTriangle, uvIslands } from '../tools/look/uvmap.ts'
import type { SkinUvData } from '../src/look/types.ts'
import type { AnatomyData } from '../src/anatomy/types.ts'
import { readGlbParts } from '../tools/skinmaps/io.ts'
import { formatUrl, parseUrl } from '../src/state/urlState.ts'

const ROOT = resolve(import.meta.dirname, '..')
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 16)

describe('lifelike skin helpers', () => {
  it('closest point on a triangle: inside, on an edge, at a corner, and degenerate', () => {
    const a = [0, 0, 0], b = [1, 0, 0], c = [0, 1, 0]
    const inside = closestOnTriangle([0.25, 0.25, 0.5], a, b, c)
    expect(inside.d2).toBeCloseTo(0.25)
    expect(inside.v).toBeCloseTo(0.25)
    expect(inside.w).toBeCloseTo(0.25)
    expect(closestOnTriangle([0.5, -1, 0], a, b, c).d2).toBeCloseTo(1)
    expect(closestOnTriangle([-1, -1, 0], a, b, c)).toMatchObject({ u: 1, v: 0, w: 0 })
    // 三点共线：结果有限，取到最近的点 / collinear corners: the result is finite and reaches the nearest point
    const deg = closestOnTriangle([2, 1, 0], [0, 0, 0], [1, 0, 0], [2, 0, 0])
    expect(Number.isFinite(deg.d2)).toBe(true)
    expect(deg.d2).toBeCloseTo(1)
  })

  it('UV islands follow triangle connectivity', () => {
    const r = uvIslands({ nV: 6, faces: new Uint32Array(6), uvFaces: Uint32Array.from([0, 1, 2, 2, 1, 3, 4, 5, 6]), uv: new Float32Array(14) })
    expect(r.count).toBe(2)
    expect(r.island[0]).toBe(r.island[3])
    expect(r.island[4]).not.toBe(r.island[0])
  })

  it('decoding refuses a wrong length and out-of-range indices', () => {
    const data = { schema: 1, skin: 's', skinVertexCount: 3, skinTriangleCount: 1, vertexCount: 3, triangleCount: 1 } as SkinUvData
    const bin = (sv: number[], idx: number[]): Uint8Array => {
      const b = new Uint8Array(3 * 8 + 12)
      const dv = new DataView(b.buffer)
      sv.forEach((v, i) => dv.setUint32(i * 4, v, true))
      idx.forEach((v, i) => dv.setUint32(24 + i * 4, v, true))
      dv.setUint16(12, 65535, true)
      return b
    }
    const ok = decodeSkinUv(data, bin([0, 1, 2], [0, 1, 2]))
    expect(ok.uv[0]).toBe(1)
    expect(() => decodeSkinUv(data, bin([0, 1, 2], [0, 1, 2]).subarray(0, 30))).toThrow()
    expect(() => decodeSkinUv(data, bin([0, 1, 5], [0, 1, 2]))).toThrow()
    expect(() => decodeSkinUv(data, bin([0, 1, 2], [0, 1, 3]))).toThrow()
  })
})

for (const body of ['male', 'female']) {
  const dir = resolve(ROOT, 'public', 'anatomy', body)
  const metaPath = resolve(dir, 'look', 'skin-uv.json')
  describe.skipIf(!existsSync(metaPath))(`lifelike skin UVs (${body})`, () => {
    it('fit the shipped skin: every vertex and triangle covered, UVs in [0, 1], inputs current', async () => {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as SkinUvData
      const uv = decodeSkinUv(meta, new Uint8Array(readFileSync(resolve(dir, 'look', 'skin-uv.bin'))))
      const anatomy = JSON.parse(readFileSync(resolve(dir, 'anatomy.json'), 'utf8')) as AnatomyData
      const part = anatomy.parts.find((p) => p.id === meta.skin)!
      const glb = anatomy.systems.find((s) => s.id === part.system)!.glb!
      const mesh = (await readGlbParts(resolve(dir, glb), new Set([meta.skin]))).get(meta.skin)!
      expect(mesh.positions.length / 3).toBe(meta.skinVertexCount)
      expect(mesh.indices.length / 3).toBe(meta.skinTriangleCount)
      // 输入哈希与仓库里的文件一致（几何改了就要重跑 tools/look/uv.ts）/ input hashes match the files in the repository (rerun tools/look/uv.ts after the geometry changes)
      expect(meta.inputs[glb]).toBe(sha(new Uint8Array(readFileSync(resolve(dir, glb)))))
      expect(meta.inputs['skin-source.u32']).toBe(sha(new Uint8Array(readFileSync(resolve(dir, 'skin-source.u32')))))
      // 每个皮肤顶点至少有一个副本；三角形逐个对应同一组皮肤顶点 / every skin vertex has at least one copy; triangle t uses the same skin vertices as skin triangle t
      const seen = new Uint8Array(meta.skinVertexCount)
      for (const s of uv.skinVertex) seen[s] = 1
      expect(seen.every((x) => x === 1)).toBe(true)
      for (let i = 0; i < uv.index.length; i++) expect(uv.skinVertex[uv.index[i]!]).toBe(mesh.indices[i])
      for (const x of uv.uv) expect(x >= 0 && x <= 1).toBe(true)
      // 由 MHR 顶点构成的三角形几乎都不翻面 / triangles made of MHR vertices are almost never flipped
      expect(meta.stats.flippedMhrTriangles! / meta.triangleCount).toBeLessThan(0.005)
    })
  })
}

describe('look URL parameter', () => {
  it('look=0 turns the lifelike look off and is the only value written', () => {
    expect(parseUrl('?skin=1&look=0').state.look).toBe(false)
    expect(parseUrl('?skin=1&look=1').state.look).toBeUndefined()
    expect(parseUrl('?look=x').warnings.length).toBe(1)
    expect(formatUrl({ skin: true, look: false })).toContain('look=0')
    expect(formatUrl({ skin: true })).not.toContain('look')
  })
})
