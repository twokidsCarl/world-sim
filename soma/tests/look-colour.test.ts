// 写实皮肤的颜色：查找表在给定色差内重现 NIST 光谱的颜色；部位贴图覆盖每个覆盖网格顶点的 UV、值有效；地址里的 tone 往返。
// The lifelike skin's colour: the table reproduces the NIST spectra's colours within the stated difference; the
// region map covers every overlay vertex's UV with valid values; the tone URL parameter round-trips.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkSkinColour, decodeSkinUv } from '../src/look/load.ts'
import { decodePngRgba } from '../src/look/png.ts'
import { lookupLut, toneMelanin } from '../src/look/skinMaterial.ts'
import { DEFAULT_TONE, type SkinColourData, type SkinUvData } from '../src/look/types.ts'
import { formatUrl, parseUrl } from '../src/state/urlState.ts'

const ROOT = resolve(import.meta.dirname, '..')
const CURATED = resolve(ROOT, 'data/curated/look/skin-colour.json')

type Lab = [number, number, number]

function xyzToLab(xyz: number[], white: number[]): Lab {
  const f = (t: number): number => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29)
  const [fx, fy, fz] = [0, 1, 2].map((i) => f(xyz[i]! / white[i]!)) as [number, number, number]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** CIEDE2000（Sharma、Wu、Dalal 2005）/ CIEDE2000 (Sharma, Wu & Dalal 2005) */
function de2000([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const rad = Math.PI / 180
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2)
  const Cb = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2)
  const h1p = ((Math.atan2(b1, a1p) / rad) % 360 + 360) % 360
  const h2p = ((Math.atan2(b2, a2p) / rad) % 360 + 360) % 360
  let dh = h2p - h1p
  if (C1p * C2p === 0) dh = 0
  else if (dh > 180) dh -= 360
  else if (dh < -180) dh += 360
  const dLp = L2 - L1, dCp = C2p - C1p
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * rad)
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2
  const hs = h1p + h2p
  const hbp = C1p * C2p === 0 ? hs : Math.abs(h1p - h2p) <= 180 ? hs / 2 : hs < 360 ? (hs + 360) / 2 : (hs - 360) / 2
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad)
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2))
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2)
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T
  const Rt = -Math.sin(2 * dTheta * rad) * Rc
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))
}

describe('colour difference', () => {
  it('CIEDE2000 matches the test pairs of Sharma et al. 2005', () => {
    expect(de2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3)
    expect(de2000([50, -1, 2], [50, 0, 0])).toBeCloseTo(2.3669, 3)
    expect(de2000([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387])).toBeCloseTo(1.2644, 3)
    expect(de2000([22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619])).toBeCloseTo(2.0373, 3)
  })
})

const curatedPresent = existsSync(CURATED)
describe.skipIf(!curatedPresent)('skin colour calibration (data/curated/look/skin-colour.json)', () => {
  const cur = curatedPresent ? JSON.parse(readFileSync(CURATED, 'utf8')) : null

  it('every fitted number is marked computed, every fixed one sourced or computed', () => {
    for (const v of Object.values(cur.model.fitted) as { provenance: string }[]) expect(v.provenance).toBe('computed')
    for (const v of Object.values(cur.model.fixed) as { provenance: string }[]) expect(['sourced', 'computed']).toContain(v.provenance)
    for (const [k, r] of Object.entries(cur.regions) as [string, { provenance: string; note: { zh: string; en: string } }][]) {
      expect(r.provenance, k).toMatch(/computed|assumed/)
      expect(r.note.zh.length, k).toBeGreaterThan(0)
      expect(r.note.en.length, k).toBeGreaterThan(0)
    }
  })

  for (const body of ['male', 'female']) {
    const dir = resolve(ROOT, 'public/anatomy', body, 'look')
    const present = existsSync(resolve(dir, 'skin-colour.json'))
    it.skipIf(!present)(`${body}: the table reproduces the 100 NIST spectra within the stated ΔE00`, async () => {
      const data = JSON.parse(readFileSync(resolve(dir, 'skin-colour.json'), 'utf8')) as SkinColourData
      const lutBin = new Uint8Array(readFileSync(resolve(dir, data.lut.file)))
      const regions = await decodePngRgba(new Uint8Array(readFileSync(resolve(dir, data.regions.file))))
      const colour = checkSkinColour(data, lutBin, regions)
      expect(data.tone.default).toBe(DEFAULT_TONE)
      const M = cur.colorimetry.rgbToXyz as number[][]
      const white = cur.colorimetry.whiteXyz as number[]
      const tol = cur.calibration.lutDE2000.tolerance as number
      const des: number[] = []
      for (const s of cur.subjects as { cm: number; chd: number; lab: Lab }[]) {
        const rgb = lookupLut(colour.lut, data.lut.size, data.lut.cmMax, data.lut.chdMax, s.cm, s.chd).map((v) => v + data.surfaceReflection)
        const xyz = M.map((row) => row[0]! * rgb[0]! + row[1]! * rgb[1]! + row[2]! * rgb[2]!)
        des.push(de2000(s.lab, xyzToLab(xyz, white)))
      }
      expect(des.length).toBe(100)
      expect(Math.max(...des)).toBeLessThanOrEqual(tol)
      expect(des.reduce((a, b) => a + b, 0) / des.length).toBeLessThan(1.5)
      // 色调越深越暗，缺省色调落在 NIST 的中位数 / a deeper tone is darker, and the default tone is the NIST median
      const lum = (t: number): number => lookupLut(colour.lut, data.lut.size, data.lut.cmMax, data.lut.chdMax, toneMelanin(t, data.tone.cmMax), data.tone.bloodChd)[1]
      for (let t = 10; t <= 100; t += 10) expect(lum(t)).toBeLessThan(lum(t - 10))
      const median = [...(cur.subjects as { cm: number }[])].map((s) => s.cm).sort((a, b) => a - b)
      const mid = (median[49]! + median[50]!) / 2
      expect(toneMelanin(data.tone.default, data.tone.cmMax)).toBeGreaterThan(mid * 0.85)
      expect(toneMelanin(data.tone.default, data.tone.cmMax)).toBeLessThan(mid * 1.15)
    })

    const uvPresent = present && existsSync(resolve(dir, 'skin-uv.json'))
    it.skipIf(!uvPresent)(`${body}: the region map covers every overlay vertex with valid values`, async () => {
      const data = JSON.parse(readFileSync(resolve(dir, 'skin-colour.json'), 'utf8')) as SkinColourData
      const uvData = JSON.parse(readFileSync(resolve(dir, 'skin-uv.json'), 'utf8')) as SkinUvData
      expect(data.skin).toBe(uvData.skin)
      const uv = decodeSkinUv(uvData, new Uint8Array(readFileSync(resolve(dir, 'skin-uv.bin'))))
      const map = await decodePngRgba(new Uint8Array(readFileSync(resolve(dir, data.regions.file))))
      const S = data.regions.size
      expect(map.width).toBe(S)
      const k = data.regions.logScale
      const at = (i: number): [number, number, number, number] => {
        const x = Math.min(S - 1, Math.floor(uv.uv[i * 2]! * S)), y = Math.min(S - 1, Math.floor(uv.uv[i * 2 + 1]! * S))
        const o = (y * S + x) * 4
        return [2 ** ((map.data[o]! - 128) / k), 2 ** ((map.data[o + 1]! - 128) / k), map.data[o + 2]! / 255, map.data[o + 3]! / 255]
      }
      const bloodPerSkinVertex = new Float64Array(uvData.skinVertexCount)
      let palm = 0
      for (let i = 0; i < uvData.vertexCount; i++) {
        const [m, b, p, r] = at(i)
        expect(m).toBeGreaterThan(0.1)
        expect(m).toBeLessThan(4)
        expect(b).toBeGreaterThan(0.5)
        expect(b).toBeLessThan(12)
        expect(p).toBeGreaterThanOrEqual(0)
        expect(r).toBeGreaterThan(0.25)
        expect(r).toBeLessThan(0.7)
        bloodPerSkinVertex[uv.skinVertex[i]!] = b
        if (p > 0.8) palm++
      }
      // 部位确实落在该在的地方：唇缘的血量远高于全身中位数，手掌和足底存在 / regions sit where they belong: blood at the lip margins far above the body median, palms and soles present
      const openings = JSON.parse(readFileSync(resolve(ROOT, 'public/anatomy', body, 'face/openings.json'), 'utf8')) as { margins: Record<string, number[]> }
      const lip = [...openings.margins.upperLip!, ...openings.margins.lowerLip!].map((v) => bloodPerSkinVertex[v]!)
      const all = [...bloodPerSkinVertex].sort((a, b) => a - b)
      expect(lip.reduce((a, b) => a + b, 0) / lip.length).toBeGreaterThan(3 * all[all.length >> 1]!)
      expect(palm).toBeGreaterThan(500)
    })
  }
})

describe('tone URL parameter', () => {
  it('round-trips, is written only when set, and refuses values outside 0–100', () => {
    expect(parseUrl(`?${formatUrl({ skin: true, tone: 37 })}`).state.tone).toBe(37)
    expect(parseUrl('?tone=0').state.tone).toBe(0)
    expect(parseUrl('?tone=100').state.tone).toBe(100)
    expect(formatUrl({ skin: true })).not.toContain('tone')
    const bad = parseUrl('?tone=150')
    expect(bad.state.tone).toBeUndefined()
    expect(bad.warnings.length).toBe(1)
    expect(parseUrl('?tone=x').warnings.length).toBe(1)
  })
})
