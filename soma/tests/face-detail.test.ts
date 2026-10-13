// 校验皱纹细节层（public/anatomy/<body>/face/detail.json、uv.bin、wrinkles.png）和合成的参考实现。
// 尚未生成时跳过：请先运行 `bun tools/face/run.ts male`。
// Validates the wrinkle detail layer (public/anatomy/<body>/face/detail.json, uv.bin, wrinkles.png) and the compositing
// reference. Skipped when it has not been built: run `bun tools/face/run.ts male` first.
//
// 这里陈述的界限 / Bounds stated here
//   · 图集每个体型 ≤ 2 MB；UV 在 [0, 1]；展开的线性拉伸中位数在 0.8–1.4 之间，翻转的三角形 ≤ 5%。
//     The atlas is ≤ 2 MB per body; UVs lie in [0, 1]; the median linear stretch of the unwrap is within 0.8–1.4 and at most 5% of triangles are flipped.
//   · 左右对称：每层左右两半“非平”纹素数之比在 0.7–1.43 之间（皮肤本身不对称）。
//     Left–right symmetry: per layer the counts of non-flat texels in the two halves are within a ratio of 0.7–1.43 (the skin itself is not symmetric).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FaceData, FaceDetail } from '../src/face/types.ts'
import { compositeNormal, decodeAtlas, layerWeights, readUv } from '../tools/face/detail.ts'
import { painAUs } from '../tools/face/model.ts'
import { staleDetail } from '../tools/face/run.ts'

for (const bodyId of ['male', 'female'] as const) {
  const DIR = join(import.meta.dirname, '../public/anatomy', bodyId)
  const present = existsSync(join(DIR, 'face', 'detail.json')) && existsSync(join(DIR, 'face', 'uv.bin')) && existsSync(join(DIR, 'face', 'wrinkles.png')) && existsSync(join(DIR, 'face.json'))

  describe.skipIf(!present)(`face detail (public/anatomy/${bodyId}/face)`, () => {
    const raw = present ? readFileSync(join(DIR, 'face', 'detail.json'), 'utf8') : '{}'
    const detail = JSON.parse(raw) as FaceDetail
    const face = (present ? JSON.parse(readFileSync(join(DIR, 'face.json'), 'utf8')) : {}) as FaceData
    const uvBin = present ? new Uint8Array(readFileSync(join(DIR, 'face', 'uv.bin'))) : new Uint8Array(0)
    const png = present ? new Uint8Array(readFileSync(join(DIR, 'face', 'wrinkles.png'))) : new Uint8Array(0)
    const layers = present ? decodeAtlas(detail, png) : { tile: 0, slopes: [] }

    it('is built from the face layer on disk and says what it is', () => {
      expect(staleDetail(DIR)).toEqual([])
      expect(detail.body).toBe(bodyId)
      expect(detail.skin).toBe(face.skin)
      expect(detail.vertexCount).toBe(face.parts[0]!.vertexCount)
      expect(detail.note.en).toMatch(/no photograph/)
      expect(detail.note.en).toMatch(/no subjective experience/)
      expect(raw).not.toMatch(/\/Users\/|\/home\/|\/private\//)
      expect(raw).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[a-z]{2,}/)
    })

    it('has UVs for the face vertices, within the tile and with bounded stretch', () => {
      expect(uvBin.length).toBe(detail.uv.count * 8)
      expect(detail.uv.count).toBeGreaterThan(5000)
      const uv = readUv(detail, uvBin)
      const dv = new DataView(uvBin.buffer, uvBin.byteOffset, uvBin.byteLength)
      let prev = -1, n = 0
      for (let i = 0; i < detail.uv.count; i++) {
        const v = dv.getUint32(i * 4, true)
        if (v <= prev || v >= detail.vertexCount) throw new Error(`bad vertex index ${v} after ${prev}`)
        prev = v
        if (!(uv[v * 2]! >= 0 && uv[v * 2]! <= 1 && uv[v * 2 + 1]! >= 0 && uv[v * 2 + 1]! <= 1)) throw new Error(`uv out of range at ${v}`)
        n++
      }
      expect(n).toBe(detail.uv.count)
      const s = detail.uv.stretch
      expect(s.median).toBeGreaterThan(0.8)
      expect(s.median).toBeLessThan(1.4)
      expect(s.flipped).toBeLessThanOrEqual(0.05)
      expect(detail.uv.texel).toBeLessThan(0.0004)
    })

    it('has an atlas of the stated size, at most 2 MB, with one tile per layer', () => {
      expect(png.length).toBe(detail.atlas.bytes)
      expect(png.length).toBeLessThanOrEqual(2_000_000)
      expect(detail.atlas.width).toBe(detail.atlas.columns * detail.atlas.tile)
      expect(detail.atlas.height).toBe(detail.atlas.rows * detail.atlas.tile)
      expect(detail.layers.map((l) => l.id)).toEqual(['glabella', 'crowsfeet', 'lowerlid', 'nose', 'nasolabial', 'lipcorner', 'forehead'])
      expect(new Set(detail.layers.map((l) => l.tile.join(','))).size).toBe(detail.layers.length)
      const aus = new Set(face.aus.map((a) => a.id))
      for (const l of detail.layers) {
        expect(l.wrinkles, l.id).toBeGreaterThan(0)
        expect(l.maxDepth, l.id).toBeLessThanOrEqual(0.002)
        for (const au of Object.keys(l.drivers)) expect(aus.has(au), `${l.id}: ${au}`).toBe(true)
        if (l.basis.source === null) expect(l.basis.note.en).toMatch(/[Aa]ssumption/)
        else expect(face.sources.some((s) => s.id === l.basis.source), l.basis.source).toBe(true)
      }
    })

    it('draws every layer on both sides, with finite slopes', () => {
      const T = layers.tile
      layers.slopes.forEach((s, li) => {
        let left = 0, right = 0
        for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
          const gx = s[(y * T + x) * 2]!, gy = s[(y * T + x) * 2 + 1]!
          if (!Number.isFinite(gx) || !Number.isFinite(gy)) throw new Error('non-finite slope')
          if (gx !== 0 || gy !== 0) x < T / 2 ? left++ : right++
        }
        const id = detail.layers[li]!.id
        expect(left + right, id).toBeGreaterThan(500)
        expect(left / right, id).toBeGreaterThan(0.7)
        expect(left / right, id).toBeLessThan(1.43)
      })
    })

    it('weights layers by AU intensity: nothing at rest, monotone, each pain-defining AU drives a layer', () => {
      expect(layerWeights(detail, {})).toEqual(detail.layers.map(() => 0))
      const of = (id: string, aus: Record<string, number>): number => layerWeights(detail, aus)[detail.layers.findIndex((l) => l.id === id)]!
      expect(of('glabella', { AU4: 5 })).toBe(1)
      expect(of('crowsfeet', { AU6: 5 })).toBe(1)
      expect(of('lowerlid', { AU7: 5 })).toBe(1)
      expect(of('nose', { AU9: 5 })).toBe(1)
      expect(of('nasolabial', { AU10: 5 })).toBe(1)
      expect(of('lipcorner', { AU20: 5 })).toBe(1)
      expect(of('glabella', { AU4: 3 })).toBeCloseTo(0.6 ** detail.curve.gamma, 9)
      expect(of('glabella', { AU43: 5, AU26: 5 })).toBe(0)
      let prev = layerWeights(detail, painAUs(face.pain, 0))
      for (let l = 0.5; l <= 10; l += 0.5) {
        const cur = layerWeights(detail, painAUs(face.pain, l))
        cur.forEach((w, i) => expect(w, `${detail.layers[i]!.id} at ${l}`).toBeGreaterThanOrEqual(prev[i]! - 1e-12))
        prev = cur
      }
      // 低强度就有东西可看 / something shows already at low levels
      expect(of('glabella', painAUs(face.pain, 2))).toBeGreaterThan(0.25)
      expect(of('lowerlid', painAUs(face.pain, 2))).toBeGreaterThan(0.25)
    })

    it('composites to the flat normal at zero weight and to unit normals otherwise, linearly in the slopes', () => {
      const zero = detail.layers.map(() => 0), one = detail.layers.map(() => 1), half = detail.layers.map(() => 0.5)
      let bent = 0
      for (let i = 0; i < 4000; i++) {
        const u = ((i * 7919) % 1000) / 999, v = ((i * 104729) % 1000) / 999
        expect(compositeNormal(layers, zero, u, v)).toEqual([0, 0, 1])
        const n = compositeNormal(layers, one, u, v), h = compositeNormal(layers, half, u, v)
        expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 9)
        expect(n[2]).toBeGreaterThan(0)
        // 斜率与权重成正比 / slopes are proportional to the weight
        expect(h[0] / h[2]).toBeCloseTo(n[0] / n[2] / 2, 9)
        expect(h[1] / h[2]).toBeCloseTo(n[1] / n[2] / 2, 9)
        if (n[2] < 0.999) bent++
      }
      expect(bent).toBeGreaterThan(20)
    })
  })
}
