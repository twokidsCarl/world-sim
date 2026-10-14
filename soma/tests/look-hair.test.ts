// 写实模式的毛发：发片数据与发布的皮肤对得上（根在皮肤三角形上、顶点不在头里）、生成统计与文献表相符、
// 解码和带状三角形正确、发色换算、URL 参数往返。本机有 data/raw/hair/ 的发丝时，再逐根检查发丝。
// Lifelike hair: the card data fit the shipped skin (roots on skin triangles, no vertex inside the head), the
// generation statistics agree with the literature table, decoding and strip triangles are right, the colour mapping,
// and the URL parameters round-trip. When the strands under data/raw/hair/ exist locally, strands are checked one by one.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeLod, lodBytes, placeVertices, stripIndex } from '../src/hair/cards.ts'
import { DEFAULT_HAIR_COLOUR, EUMELANIN, HAIR_COLOURS, MELANIN, albedo, isHairColour, sigmaA, swatch } from '../src/hair/colour.ts'
import type { HairData } from '../src/look/types.ts'
import type { AnatomyData } from '../src/anatomy/types.ts'
import { formatUrl, parseUrl } from '../src/state/urlState.ts'
import { readGlbParts } from '../tools/skinmaps/io.ts'
import { Surface, type V3, dot, sub } from '../tools/hair/geom.ts'
import { styleCoverage } from '../tools/hair/coverage.ts'
import { buildStrands, decodeGuides, smoothGuides, strandBytes } from '../src/hair/strands.ts'
import { headFrame } from '../tools/hair/frame.ts'
import { decodePng } from '../tools/hair/png.ts'
import { loadParams, makeScalp } from '../tools/hair/scalp.ts'
import { loadBody } from '../tools/hair/skin.ts'

const ROOT = resolve(import.meta.dirname, '..')
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 16)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = (JSON.parse(readFileSync(resolve(ROOT, 'data', 'curated', 'hair', 'hair.json'), 'utf8')) as { values: Record<string, any> }).values

describe('hair helpers', () => {
  it('strip triangles stay inside each card and cover every segment', () => {
    const idx = stripIndex(3, 4)
    expect(idx.length).toBe(3 * 3 * 6)
    expect(Math.max(...idx)).toBe(3 * 4 * 2 - 1)
    // 每个三角形的顶点属于同一张发片 / every triangle's vertices belong to one card
    for (let t = 0; t < idx.length; t += 3) {
      const card = Math.floor(idx[t]! / 8)
      expect(Math.floor(idx[t + 1]! / 8)).toBe(card)
      expect(Math.floor(idx[t + 2]! / 8)).toBe(card)
    }
  })

  it('melanin presets: pbrt concentrations, base colour darkens with eumelanin, swatches are hex', () => {
    expect(sigmaA(MELANIN.black)).toEqual(EUMELANIN.map((x) => x * 8))
    const lum = (c: [number, number, number]): number => c[0] + c[1] + c[2]
    expect(lum(albedo(sigmaA(MELANIN.black)))).toBeLessThan(lum(albedo(sigmaA(MELANIN.brown))))
    expect(lum(albedo(sigmaA(MELANIN.brown)))).toBeLessThan(lum(albedo(sigmaA(MELANIN.blonde))))
    // 红发：红通道相对绿通道比棕发高 / red hair: red relative to green is higher than for brown
    const ratio = (c: [number, number, number]): number => c[0] / c[1]
    expect(ratio(albedo(sigmaA(MELANIN.red)))).toBeGreaterThan(ratio(albedo(sigmaA(MELANIN.blonde))))
    for (const c of HAIR_COLOURS) expect(swatch(c)).toMatch(/^#[0-9a-f]{6}$/)
    expect(isHairColour('red')).toBe(true)
    expect(isHairColour('green')).toBe(false)
  })
})

describe('hair URL parameters', () => {
  it('hair and hc round-trip; defaults and bad values are not written', () => {
    const p = parseUrl('?skin=1&hair=long&hc=red')
    expect(p.state.hair).toBe('long')
    expect(p.state.hc).toBe('red')
    const back = parseUrl(`?${formatUrl(p.state)}`)
    expect(back.state.hair).toBe('long')
    expect(back.state.hc).toBe('red')
    expect(parseUrl('?hair=none').state.hair).toBe('none')
    expect(parseUrl('?hair=bob').warnings.length).toBe(1)
    expect(parseUrl('?hc=green').warnings.length).toBe(1)
    expect(formatUrl({ skin: true, hc: DEFAULT_HAIR_COLOUR })).not.toContain('hc')
    expect(formatUrl({ skin: true })).not.toContain('hair')
    expect(parseUrl('?beard=stubble').state.beard).toBe('stubble')
    expect(parseUrl(`?${formatUrl({ beard: 'short' })}`).state.beard).toBe('short')
    expect(formatUrl({ beard: 'none' })).not.toContain('beard')
    expect(parseUrl('?beard=goatee').warnings.length).toBe(1)
  })
})

for (const body of ['male', 'female']) {
  const dir = resolve(ROOT, 'public', 'anatomy', body)
  const metaPath = resolve(dir, 'hair', 'hair.json')
  describe.skipIf(!existsSync(metaPath))(`hair cards (${body})`, () => {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as HairData
    const skinMesh = async (): Promise<{ positions: Float32Array; indices: Uint32Array }> => {
      const anatomy = JSON.parse(readFileSync(resolve(dir, 'anatomy.json'), 'utf8')) as AnatomyData
      const part = anatomy.parts.find((p) => p.id === meta.skin)!
      const glb = anatomy.systems.find((s) => s.id === part.system)!.glb!
      return (await readGlbParts(resolve(dir, glb), new Set([meta.skin]))).get(meta.skin)!
    }

    it('files are current, sizes match, the hidden shells exist and the download stays small', () => {
      expect(meta.inputs['integumentary.glb']).toBe(sha(new Uint8Array(readFileSync(resolve(dir, 'integumentary.glb')))))
      const anatomy = JSON.parse(readFileSync(resolve(dir, 'anatomy.json'), 'utf8')) as AnatomyData
      for (const id of meta.hides) expect(anatomy.parts.some((p) => p.id === id)).toBe(true)
      let atlas = 0
      for (const f of [meta.atlas.a, meta.atlas.b]) atlas += readFileSync(resolve(dir, 'hair', f)).length
      for (const p of meta.pieces) {
        const bin = readFileSync(resolve(dir, 'hair', p.file))
        expect(bin.length).toBe(p.bytes)
        expect(p.lods.reduce((a, l) => a + lodBytes(l), 0)).toBe(p.bytes)
      }
      // 一次下载：贴图集 + 最大的发型 + 眉毛 + 睫毛，≤ 5 MB / one download: atlas + the largest style + brows + lashes, ≤ 5 MB
      const piece = (id: string): number => meta.pieces.find((p) => p.id === id)!.bytes
      expect(atlas + Math.max(piece('short'), piece('long')) + piece('brows') + piece('lashes') + piece('pubic') + piece('axilla') + meta.scalp.vertices * 5).toBeLessThan(5e6)
    })

    it('roots lie on skin triangles and no card vertex is inside the skin', async () => {
      const skin = await skinMesh()
      expect(skin.positions.length / 3).toBe(meta.skinVertexCount)
      const tri = new Set<string>()
      for (let t = 0; t < skin.indices.length; t += 3) tri.add([skin.indices[t]!, skin.indices[t + 1]!, skin.indices[t + 2]!].sort((a, b) => a - b).join())
      const surface = new Surface(skin.positions, skin.indices)
      for (const p of meta.pieces) {
        const bin = new Uint8Array(readFileSync(resolve(dir, 'hair', p.file)))
        for (const l of p.lods) {
          const d = decodeLod(bin, l, meta.offsetUnit, meta.skinVertexCount)
          // 根的三个顶点是皮肤的一个三角形，所以按重心坐标插出的根就在皮肤面上 / the root's three vertices form a skin triangle, so the interpolated root lies on the skin surface
          for (let c = 0; c < d.cards; c++) {
            expect(tri.has(Array.from(d.rootVerts.subarray(c * 3, c * 3 + 3)).sort((a, b) => a - b).join())).toBe(true)
            const w = d.rootBary.subarray(c * 3, c * 3 + 3)
            expect(Math.abs(w[0]! + w[1]! + w[2]! - 1)).toBeLessThan(1e-4)
          }
          for (const x of d.uv) expect(x >= 0 && x <= 1).toBe(true)
          for (let i = 0; i < d.index.length; i++) expect(d.index[i]!).toBeLessThan(d.offset.length / 3)
          // 静止位置的顶点离皮肤（带符号）不小于 −0.5 毫米；根环在皮肤上 / rest-position vertices are no less than −0.5 mm from the skin (signed); the root ring sits on it
          const pos = new Float32Array(d.offset.length)
          placeVertices(d, skin.positions, pos)
          let worst = Infinity
          for (let v = 0; v < pos.length / 3; v++) {
            const q: V3 = [pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!]
            const h = surface.closest(q, 0.01)
            if (h && h.distance <= 0.01) worst = Math.min(worst, dot(sub(q, h.point), h.smoothNormal))
          }
          expect(worst, `${p.id} level ${p.lods.indexOf(l)}`).toBeGreaterThan(-0.0005)
        }
      }
    }, 120000)

    it('coverage: from every view at least 95 % of the scalp (outside the part and the hairline ramp) is hidden by the cards', async () => {
      const b = await loadBody(body as 'male' | 'female')
      const surface = new Surface(b.skin.positions, b.skin.indices)
      const f = headFrame(b, surface)
      const scalp = makeScalp(b, f, loadParams())
      const png = decodePng(new Uint8Array(readFileSync(resolve(dir, 'hair', meta.atlas.a))))
      expect(png.channels).toBe(4)
      for (const style of ['short', 'long'] as const) {
        const piece = meta.pieces.find((p) => p.id === style)!
        const r = styleCoverage(b, f, surface, scalp, style, new Uint8Array(readFileSync(resolve(dir, 'hair', piece.file))), piece.lods[0]!, meta.offsetUnit, png.data, png.width)
        expect(r.samples).toBeGreaterThan(1000)
        for (const [view, v] of Object.entries(r.views)) expect(v, `${style} ${view}`).toBeGreaterThanOrEqual(0.95)
        // 与构建时记下的数一致 / agrees with the numbers recorded at build time
        expect(Math.abs(r.all - meta.coverage[style]!.all!)).toBeLessThan(0.01)
      }
      // 头皮底色的数据长度 / the scalp tint data length
      expect(readFileSync(resolve(dir, 'hair', meta.scalp.file)).length).toBe(meta.scalp.vertices * 5)
    }, 120000)

    it('close-up strands: guide roots on skin triangles, no guide point inside the skin, render strands well formed, small download', async () => {
      const skin = await skinMesh()
      const tri = new Set<string>()
      for (let t = 0; t < skin.indices.length; t += 3) tri.add([skin.indices[t]!, skin.indices[t + 1]!, skin.indices[t + 2]!].sort((a, b) => a - b).join())
      const surface = new Surface(skin.positions, skin.indices)
      for (const style of ['short', 'long'] as const) {
        const info = meta.pieces.find((p) => p.id === style)!.strands!
        expect(info, style).toBeTruthy()
        const bin = new Uint8Array(readFileSync(resolve(dir, 'hair', info.file)))
        expect(bin.length).toBe(info.bytes)
        expect(strandBytes(info)).toBe(info.bytes)
        // 每种发型的发丝数据不超过 3 MB / at most 3 MB of strand data per style
        expect(info.bytes).toBeLessThan(3e6)
        const d = decodeGuides(bin, info, meta.offsetUnit, meta.skinVertexCount)
        const P = info.points
        let worst = Infinity
        for (let g = 0; g < info.guides; g++) {
          expect(tri.has(Array.from(d.rootVerts.subarray(g * 3, g * 3 + 3)).sort((a, b) => a - b).join())).toBe(true)
          const root = [0, 0, 0]
          for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) root[c]! += skin.positions[d.rootVerts[g * 3 + k]! * 3 + c]! * d.rootBary[g * 3 + k]!
          if (g % 7) continue // 抽查 / a sample
          for (let k = 1; k < P; k++) {
            const q: V3 = [root[0]! + d.offset[(g * P + k) * 3]!, root[1]! + d.offset[(g * P + k) * 3 + 1]!, root[2]! + d.offset[(g * P + k) * 3 + 2]!]
            const h = surface.closest(q, 0.005)
            if (h && h.distance <= 0.005) worst = Math.min(worst, dot(sub(q, h.point), h.smoothNormal))
          }
        }
        expect(worst, style).toBeGreaterThan(-0.0005)
        // 细分保住两端；渲染发丝的三角形下标都有效 / subdivision keeps both ends; render-strand indices are all valid
        const sm = smoothGuides(d, 2)
        expect(sm.info.points).toBe((P - 1) * 2 + 1)
        expect(sm.offset[(sm.info.points - 1) * 3]).toBeCloseTo(d.offset[(P - 1) * 3]!, 6)
        const built = buildStrands(d, 7, style === 'long' ? 2 : 1)
        const V = built.geometry.getAttribute('position').count
        expect(built.strands).toBe(info.guides * info.children)
        const index = built.geometry.index!.array
        let max = 0
        for (let i = 0; i < index.length; i++) max = Math.max(max, index[i]!)
        expect(max).toBe(V - 1)
      }
    }, 120000)

    it('generation statistics agree with the curated literature table', () => {
      const s = (id: string): Record<string, number> => meta.pieces.find((p) => p.id === id)!.stats
      const scalp = s('short')
      const full = table.scalpDensity.value as number
      // 各区密度在文献均值 ±12% 内；颞部按颞部比例 / regional densities within ±12 % of the literature mean; the temples by the temporal ratio
      for (const k of ['vertex', 'occipital', 'frontal']) expect(Math.abs(scalp[`density_${k}`]! / full - 1)).toBeLessThan(0.12)
      expect(Math.abs(scalp.density_temporal! / (full * table.temporalDensityRatio.value) - 1)).toBeLessThan(0.12)
      // 总根数在文献范围内 / total hairs within the literature range
      const [lo, hi] = table.totalScalpHairs.range as [number, number]
      expect(scalp.follicles).toBeGreaterThanOrEqual(lo)
      expect(scalp.follicles).toBeLessThanOrEqual(hi)
      // 短发：中位长度在两侧与头顶的设定之间；长发：最长的不超过设定长度 / short: median length between the sides and top settings; long: the longest not beyond the set length
      expect(scalp.lengthMmP50).toBeGreaterThan(table.styleShortLength.sides)
      expect(scalp.lengthMmP50).toBeLessThan(table.styleShortLength.top * 1.1)
      expect(s('long').lengthMmP90).toBeLessThan(table.styleLongLength.value * 1.1)
      expect(s('long').lengthMmP50).toBeGreaterThan(table.styleLongLength.value * 0.5)
      // 眉毛、睫毛的根数和长度 / eyebrow and eyelash counts and lengths
      const brows = s('brows')
      expect(brows.perSide).toBeGreaterThanOrEqual(table.browCount.range[0])
      expect(brows.perSide).toBeLessThanOrEqual(table.browCount.range[1])
      expect(Math.abs(brows.lengthMmP50! / table.browLength.value - 1)).toBeLessThan(0.2)
      const lashes = s('lashes')
      expect(lashes.upperPerLid).toBeGreaterThanOrEqual(table.lashCountUpper.range[0])
      expect(lashes.upperPerLid).toBeLessThanOrEqual(table.lashCountUpper.range[1])
      expect(lashes.lowerPerLid).toBeGreaterThanOrEqual(table.lashCountLower.range[0] - 2)
      expect(lashes.lowerPerLid).toBeLessThanOrEqual(table.lashCountLower.range[1])
      expect(Math.abs(lashes.upperLengthMm! / table.lashLengthUpper.value - 1)).toBeLessThan(0.1)
      expect(Math.abs(lashes.lowerLengthMm! / table.lashLengthLower.value - 1)).toBeLessThan(0.1)
      // 阴毛、腋毛：区内部的密度在表值 ±20% 内（都是假设值）；中位长度在 ±15% 内
      // pubic and axillary hair: interior density within ±20 % of the table (both assumed); median length within ±15 %
      expect(Math.abs(s('pubic').densityPerCm2! / table.pubicDensity.value - 1)).toBeLessThan(0.2)
      expect(Math.abs(s('axilla').densityPerCm2! / table.axillaryDensity.value - 1)).toBeLessThan(0.2)
      expect(Math.abs(s('pubic').lengthMmP50! / table.pubicLength.value - 1)).toBeLessThan(0.15)
      expect(Math.abs(s('axilla').lengthMmP50! / table.axillaryLength.value - 1)).toBeLessThan(0.15)
      // 胡须（只有男性）：各区密度与 Dua 等 2021 相符（颊、颏 ±15%，上唇按两侧值 ±15%，颈部是假设 ±30%）
      // beard (male only): regional densities agree with Dua et al. 2021 (cheek and chin ±15 %, upper lip against the lateral value ±15 %, the assumed neck ±30 %)
      const beard = meta.pieces.find((p) => p.id === 'beard')?.stats
      expect(!!beard).toBe(body === 'male')
      if (beard) {
        const D = table.beardDensity
        expect(Math.abs(beard.density_cheek! / D.cheek - 1)).toBeLessThan(0.15)
        expect(Math.abs(beard.density_chin! / D.chin - 1)).toBeLessThan(0.15)
        expect(Math.abs(beard.density_moustache! / D.moustacheLateral - 1)).toBeLessThan(0.15)
        expect(Math.abs(beard.density_neck! / D.neck - 1)).toBeLessThan(0.3)
        expect(Math.abs(beard.lengthMmP50! / table.beardLength.short - 1)).toBeLessThan(0.15)
        expect(meta.beard!.vertices).toBeGreaterThan(100)
        expect(readFileSync(resolve(dir, 'hair', meta.beard!.file)).length).toBe(meta.beard!.vertices * 5)
      }
      // 阴毛外壳在被替代的外壳里 / the pubic shell is among the replaced shells
      expect(meta.hides[2]).toMatch(/FJ2815$/)
    })

    // 本机才有：逐根检查发丝（根在皮肤上 ≤ 0.5 毫米，没有点在皮肤里）/ local only: strand by strand (roots ≤ 0.5 mm from the skin, no point inside it)
    const rawPath = resolve(ROOT, 'data', 'raw', 'hair', body, 'strands.json')
    it.skipIf(!existsSync(rawPath))('strands: roots on the skin, no point inside the head', async () => {
      const raw = JSON.parse(readFileSync(rawPath, 'utf8')) as { pieces: Record<string, { verts: number[]; bary: number[]; pts: number[][] }[]> }
      const skin = await skinMesh()
      const surface = new Surface(skin.positions, skin.indices)
      for (const [id, strands] of Object.entries(raw.pieces)) {
        let worstRoot = 0, worstInside = Infinity
        for (const st of strands) {
          const root = st.pts[0]! as V3
          const h = surface.closest(root, 0.01)!
          worstRoot = Math.max(worstRoot, h.distance)
          for (const p of st.pts.slice(1)) {
            const c = surface.closest(p as V3, 0.005)
            // 只看搜索半径以内的最近点（BVH 偶尔会给出更远的）/ only closest points within the search radius count (the BVH occasionally returns a farther one)
            if (c && c.distance <= 0.005) worstInside = Math.min(worstInside, dot(sub(p as V3, c.point), c.smoothNormal))
          }
        }
        expect(worstRoot, id).toBeLessThan(0.0005)
        expect(worstInside, id).toBeGreaterThan(-0.0005)
      }
    }, 300000)
  })
}
