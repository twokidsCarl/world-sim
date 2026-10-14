// 发布的衣服数据（public/anatomy/<body>/cloth/）的检查：下标、绑定、缝线、穿透、大小。
// Checks of the shipped garment data (public/anatomy/<body>/cloth/): indices, binding, seams, penetration, size.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bindingPosition } from '../src/cloth/attach.ts'
import { MeshCollider, type Closest } from '../src/cloth/collider.ts'
import { decodeCloth, type ClothData } from '../src/cloth/load.ts'
import { readGlbParts } from '../tools/skinmaps/io.ts'
import { meshGarment, type GcSpec } from '../tools/cloth/pattern.ts'
import { parseWear } from '../src/cloth/garments.ts'
import { formatUrl, parseUrl } from '../src/state/urlState.ts'

const ROOT = join(import.meta.dirname, '..', 'public', 'anatomy')
const SKIN: Record<string, string> = { male: 'FJ2810', female: 'SOMA_skin' }
/** 每副人体衣服数据的总大小上限 / Size budget of a body's garment data. */
const BUDGET = 4 * 1024 * 1024
/** 每件衣服的顶点上限 / Vertex limit per garment. */
const MAX_VERTICES = 10000

for (const body of ['male', 'female']) {
  const dir = join(ROOT, body, 'cloth')
  describe.skipIf(!existsSync(join(dir, 'index.json')))(`garments of the ${body} body`, () => {
    const index = existsSync(join(dir, 'index.json')) ? (JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { garments: Record<string, { file: string }> }) : { garments: {} }
    const garments = Object.keys(index.garments)

    it('stays within the size budget', () => {
      let total = 0
      for (const g of garments) total += statSync(join(dir, `${g}.json`)).size + statSync(join(dir, `${g}.bin`)).size
      expect(total).toBeLessThanOrEqual(BUDGET)
    })

    it('has valid meshes, closed seams, a binding that rebuilds the rest positions and no vertex inside the skin', async () => {
      const skin = (await readGlbParts(join(ROOT, body, 'integumentary.glb'), new Set([SKIN[body]!]))).get(SKIN[body]!)!
      const collider = new MeshCollider(skin.positions, skin.indices, 0.02, 0.03)
      const c: Closest = { tri: 0, b0: 0, b1: 0, b2: 0, signed: 0, qx: 0, qy: 0, qz: 0, nx: 0, ny: 0, nz: 0 }
      for (const g of garments) {
        const data = JSON.parse(readFileSync(join(dir, `${g}.json`), 'utf8')) as ClothData
        const bin = readFileSync(join(dir, `${g}.bin`))
        const cloth = decodeCloth(data, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength))
        const n = data.vertexCount
        expect(n, g).toBeLessThanOrEqual(MAX_VERTICES)
        expect(data.skinVertexCount * 3, g).toBe(skin.positions.length)
        // 三角形不退化 / no degenerate triangles
        for (let t = 0; t < cloth.index.length; t += 3) {
          const [a, b, d] = [cloth.index[t]!, cloth.index[t + 1]!, cloth.index[t + 2]!]
          expect(a !== b && b !== d && a !== d, `${g} triangle ${t / 3}`).toBe(true)
        }
        // 缝线闭合 / seams closed
        let gap = 0
        for (let s = 0; s < cloth.stitch.length; s += 2) {
          const a = cloth.stitch[s]! * 3, b = cloth.stitch[s + 1]! * 3
          expect(cloth.stitch[s]! < n && cloth.stitch[s + 1]! < n, g).toBe(true)
          gap = Math.max(gap, Math.hypot(cloth.position[a]! - cloth.position[b]!, cloth.position[a + 1]! - cloth.position[b + 1]!, cloth.position[a + 2]! - cloth.position[b + 2]!))
        }
        expect(gap, `${g}: largest stitch gap (m)`).toBeLessThanOrEqual(0.001)
        // 绑定重建静止位置 / the binding rebuilds the rest positions
        const p = new Float32Array(3)
        let err = 0, inside = 0
        for (let i = 0; i < n; i++) {
          bindingPosition(skin.positions, cloth.bindVert, i, cloth.bindBary[i * 2]!, cloth.bindBary[i * 2 + 1]!, cloth.bindOffset[i]!, p, 0)
          err = Math.max(err, Math.hypot(p[0]! - cloth.position[i * 3]!, p[1]! - cloth.position[i * 3 + 1]!, p[2]! - cloth.position[i * 3 + 2]!))
          if (collider.closest(cloth.position[i * 3]!, cloth.position[i * 3 + 1]!, cloth.position[i * 3 + 2]!, c)) inside = Math.max(inside, -c.signed)
        }
        expect(err, `${g}: binding error (m)`).toBeLessThan(1e-4)
        expect(inside, `${g}: deepest vertex inside the skin (m)`).toBeLessThanOrEqual(0.001)
      }
    }, 120_000)
  })
}

describe('garment patterns and the wear= parameter', () => {
  it('meshes every committed pattern with its seams paired and its boundary intact', () => {
    const dir = join(import.meta.dirname, '..', 'data', 'curated', 'cloth', 'patterns')
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const spec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as GcSpec
      const m = meshGarment(spec, 0.012)
      expect(m.missingSegments, f).toBe(0)
      expect(m.stitches.length, f).toBeGreaterThan(0)
      for (let i = 0; i < m.stitches.length; i++) expect(m.stitches[i]!, f).toBeLessThan(m.uv.length / 2)
    }
  })

  it('round-trips wear= through the URL and drops unknown garments', () => {
    expect(parseUrl('?wear=tee,pants').state.wear).toEqual(['tee', 'pants'])
    expect(formatUrl(parseUrl('?wear=sports-bra,tights').state)).toBe('wear=sports-bra,tights')
    expect(parseWear('tee,cape,tee')).toEqual(['tee'])
    expect(parseUrl('?wear=cape').warnings.length).toBe(1)
  })
})
