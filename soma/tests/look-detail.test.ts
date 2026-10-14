// 写实皮肤的细节和光的传播：微细起伏贴图和预积分表能逐字节重新生成；细节贴图覆盖每个覆盖网格顶点、值有界、部位对得上；新增文件的大小。
// The lifelike skin's detail and light transport: the micro-relief tile and the pre-integrated table regenerate byte
// for byte; the detail map covers every overlay vertex with bounded values that match the regions; the size of the added files.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { DataUtils } from 'three'
import { describe, expect, it } from 'vitest'
import { checkSkinDetail, decodeSkinUv } from '../src/look/load.ts'
import { decodePngRgba } from '../src/look/png.ts'
import type { SkinColourData, SkinUvData } from '../src/look/types.ts'
import { MICRO_SIZE, buildMicro, packMicro } from '../tools/look/micro.ts'
import { KAPPA_MAX, PREINT_H, PREINT_W, buildPreint, preintegrate } from '../tools/look/preintegrated.ts'

const ROOT = resolve(import.meta.dirname, '..')
const look = (body: string, file: string): string => resolve(ROOT, 'public/anatomy', body, 'look', file)

describe('pre-integrated skin scattering', () => {
  it('is Lambert on a flat surface and softens, reddening, the terminator on a curved one', () => {
    for (const c of [-0.5, 0, 0.3, 1]) expect(preintegrate(c, 0)).toEqual([Math.max(0, c), Math.max(0, c), Math.max(0, c)])
    const [r, g, b] = preintegrate(0, KAPPA_MAX, 1024)
    // 明暗交界处有光，红多于绿多于蓝 / light at the terminator, red above green above blue
    expect(r).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(0)
    // 越弯越软 / the more curved, the softer
    expect(preintegrate(0, KAPPA_MAX, 1024)[0]).toBeGreaterThan(preintegrate(0, KAPPA_MAX / 4, 1024)[0])
    // 迎光面不会超过 1 / never above 1 facing the light
    for (const c of [0.5, 0.9, 1]) for (const v of preintegrate(c, KAPPA_MAX, 1024)) expect(v).toBeLessThanOrEqual(1.0001)
  })

  for (const body of ['male', 'female']) {
    it.skipIf(!existsSync(look(body, 'skin-preint.bin')))(`${body}: skin-preint.bin regenerates bit for bit`, () => {
      const bin = new Uint8Array(readFileSync(look(body, 'skin-preint.bin')))
      const shipped = new Uint16Array(bin.slice().buffer)
      const t = buildPreint()
      expect(shipped.length).toBe(PREINT_W * PREINT_H * 4)
      for (let i = 0; i < t.length; i++) expect(shipped[i]).toBe(DataUtils.toHalfFloat(t[i]!))
    })
  }
})

describe('micro-relief tile', () => {
  const present = existsSync(look('male', 'skin-micro.png'))
  it.skipIf(!present)('skin-micro.png regenerates byte for byte and tiles', async () => {
    const packed = packMicro(buildMicro())
    for (const body of ['male', 'female']) {
      const png = await decodePngRgba(new Uint8Array(readFileSync(look(body, 'skin-micro.png'))))
      expect(png.width).toBe(MICRO_SIZE)
      // 同一引擎下逐字节相同；不同 JS 引擎的 Math.cos 可能差一个末位，最多容许极少数 ±1
      // byte for byte on one engine; another JS engine's Math.cos may differ in the last bit, so a very few ±1 are allowed
      let off = 0
      for (let i = 0; i < MICRO_SIZE * MICRO_SIZE; i++) {
        for (let c = 0; c < 3; c++) {
          const dv = Math.abs(png.data[i * 4 + c]! - packed[i * 3 + c]!)
          if (dv > 1) throw new Error(`${body}: pixel ${i} channel ${c} differs by ${dv}`)
          off += dv
        }
      }
      expect(off).toBeLessThan(MICRO_SIZE * MICRO_SIZE * 3 * 0.001)
    }
    // 可平铺：对边的差不比相邻两列的差大很多 / tileable: the jump across opposite edges is no larger than between neighbouring columns
    const S = MICRO_SIZE
    for (let c = 0; c < 3; c++) {
      let wrap = 0, inner = 0
      for (let y = 0; y < S; y++) {
        wrap += Math.abs(packed[(y * S + S - 1) * 3 + c]! - packed[(y * S) * 3 + c]!)
        inner += Math.abs(packed[(y * S + S / 2) * 3 + c]! - packed[(y * S + S / 2 - 1) * 3 + c]!)
      }
      expect(wrap).toBeLessThan(inner * 1.5 + S)
    }
  }, 60_000)
})

describe('detail data checks', () => {
  it('refuses wrong sizes', () => {
    const data = { detail: { size: 4 }, micro: { size: 2 }, preintegrated: { width: 2, height: 2 } } as unknown as SkinColourData
    const img = (n: number) => ({ width: n, height: n, data: new Uint8Array(n * n * 4) })
    expect(() => checkSkinDetail(data, img(3), null, null)).toThrow()
    expect(() => checkSkinDetail(data, null, img(4), null)).toThrow()
    expect(() => checkSkinDetail(data, null, null, new Uint8Array(10))).toThrow()
    expect(checkSkinDetail(data, img(4), img(2), new Uint8Array(32)).preint?.length).toBe(16)
  })
})

for (const body of ['male', 'female']) {
  const present = existsSync(look(body, 'skin-colour.json')) && existsSync(look(body, 'skin-detail.png')) && existsSync(look(body, 'skin-uv.json'))
  describe.skipIf(!present)(`${body}: detail map`, () => {
    it('covers every overlay vertex with bounded values that match the regions', async () => {
      const data = JSON.parse(readFileSync(look(body, 'skin-colour.json'), 'utf8')) as SkinColourData
      const d = data.detail!
      const uvData = JSON.parse(readFileSync(look(body, 'skin-uv.json'), 'utf8')) as SkinUvData
      const uv = decodeSkinUv(uvData, new Uint8Array(readFileSync(look(body, 'skin-uv.bin'))))
      const det = await decodePngRgba(new Uint8Array(readFileSync(look(body, d.file))))
      const reg = await decodePngRgba(new Uint8Array(readFileSync(look(body, data.regions.file))))
      expect(det.width).toBe(d.size)
      const S = d.size
      const thick: number[] = []
      let palmRidges = 0, palm = 0
      for (let i = 0; i < uvData.vertexCount; i++) {
        const x = Math.min(S - 1, Math.floor(uv.uv[i * 2]! * S)), y = Math.min(S - 1, Math.floor(uv.uv[i * 2 + 1]! * S))
        const o = (y * S + x) * 4
        const relief = (det.data[o]! / 255) * d.reliefMax, type = det.data[o + 1]! / 255
        const mm = (det.data[o + 2]! / 255) ** 2 * d.thicknessMaxMm, kappa = (det.data[o + 3]! / 255) ** 2 * d.kappaMax
        expect(relief).toBeGreaterThanOrEqual(0)
        expect(relief).toBeLessThanOrEqual(d.reliefMax)
        expect(type).toBeLessThanOrEqual(1)
        expect(mm).toBeGreaterThan(0.2)
        expect(mm).toBeLessThanOrEqual(d.thicknessMaxMm)
        expect(kappa).toBeLessThanOrEqual(d.kappaMax)
        thick.push(mm)
        // 手掌、足底（部位贴图 B 高）应是皮嵴类型 / palms and soles (high B in the region map) should be of ridge type
        if (reg.data[o + 2]! > 230) {
          palm++
          if (type > 0.8) palmRidges++
        }
      }
      expect(palm).toBeGreaterThan(500)
      expect(palmRidges / palm).toBeGreaterThan(0.8)
      // 有薄的地方（手指、足趾），大部分是厚的 / thin places exist (fingers, toes), most skin is thick
      thick.sort((a, b) => a - b)
      expect(thick[Math.floor(thick.length * 0.02)]!).toBeLessThan(20)
      expect(thick[thick.length >> 1]!).toBeGreaterThan(30)
    })

    it('the added assets stay within 2 MB', () => {
      const files = [data(body).detail!.file, data(body).micro!.file, data(body).preintegrated!.file]
      const bytes = files.reduce((s, f) => s + statSync(look(body, f)).size, 0)
      expect(bytes).toBeLessThan(2 * 1024 * 1024)
    })
  })
}

function data(body: string): SkinColourData {
  return JSON.parse(readFileSync(look(body, 'skin-colour.json'), 'utf8')) as SkinColourData
}
