// 检验已生成的皮肤分区图（public/anatomy/<body>/skinmaps.json + .bin）。未生成时跳过：先运行 `bun tools/skinmaps/run.ts male`。
// Validates the generated skin maps. Skipped when they have not been generated: run `bun tools/skinmaps/run.ts male` first.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { SkinMaps } from '../src/anatomy/types.ts'
import { generate, makeReport, type Generated } from '../tools/skinmaps/generate.ts'
import { segmentKeys } from '../tools/skinmaps/verify.ts'

const dirOf = (body: string) => join(import.meta.dirname, '../public/anatomy', body)
const has = (body: string) => existsSync(join(dirOf(body), 'skinmaps.json')) && existsSync(join(dirOf(body), 'skinmaps.bin'))

// 已知并已上报的例外；出现新的例外即失败。
// Known, reported exceptions; anything new fails the test.
const KNOWN = {
  // 模型上 ISNCSCI 的 T12 点（腹股沟韧带中点）与“腹股沟属 L1”的教学说法相差约 2.5 cm。
  // ISNCSCI puts T12 on the mid-inguinal point; the "inguinal = L1" teaching point lies 2.5 cm lower here.
  failedChecks: ['2.5 cm below the midpoint of the inguinal ligament'],
  // 躯干带在上臂与胸壁皮肤粘连处被隔开，上背部各带窄于网格分辨率。
  // Trunk bands are interrupted where the arm is fused to the chest wall, and the upper-back bands are narrower than the mesh resolves.
  splitDermatomes: /^(T([2-9]|10|11)|S3|V3)$/,
  asymmetricDermatomes: /^(V3|T[3-6]|T10)$/,
  splitTerritories: /^(obturator|pudendal|sural|superficialFibular|intercostobrachial|ilioinguinal)$/,
  disagreeingTerritories: ['iliohypogastricLateral', 'iliohypogastricAnterior', 'ilioinguinal', 'genitofemoralGenital', 'medialBrachial', 'intercostobrachial', 'obturator'],
}

describe.skipIf(!has('male'))('skin maps (public/anatomy/male)', () => {
  let g: Generated
  let maps: SkinMaps
  let bin: Uint8Array
  let report: ReturnType<typeof makeReport>
  beforeAll(async () => {
    g = await generate('male')
    maps = JSON.parse(readFileSync(join(dirOf('male'), 'skinmaps.json'), 'utf8')) as SkinMaps
    bin = new Uint8Array(readFileSync(join(dirOf('male'), 'skinmaps.bin')))
    const n = maps.vertexCount
    report = makeReport(g.ctx, bin.subarray(0, n), bin.subarray(n, 2 * n))
  }, 120_000)

  it('follows the contract', () => {
    const n = g.ctx.skin.n
    expect(maps.part).toBe(g.ctx.skinPart)
    expect(maps.vertexCount).toBe(n)
    expect(bin.length).toBe(n * 2)
    expect(maps.maps.map((m) => m.id)).toEqual(['dermatome', 'cutaneousNerve'])
    const concepts = new Set(g.ctx.body.data.trees.isa.map((c) => c.id))
    maps.maps.forEach((m, k) => {
      expect(m.offset).toBe(k * n)
      expect(m.status).toBe('unreviewed')
      expect(m.regions.length).toBeLessThan(255)
      expect(m.method.zh).toMatch(/未经临床医师审校/)
      expect(m.method.en).toMatch(/not been reviewed by a clinician/)
      expect(m.sources.length).toBeGreaterThan(2)
      for (const r of m.regions) {
        expect(r.name.zh.length).toBeGreaterThan(0)
        expect(r.color).toMatch(/^#[0-9a-f]{6}$/)
        if (r.concept) expect(concepts.has(r.concept), `${r.name.en}: ${r.concept}`).toBe(true)
      }
      for (let i = 0; i < n; i++) {
        const l = bin[m.offset + i]!
        if (l !== 255 && l >= m.regions.length) throw new Error(`label ${l} out of range in ${m.id}`)
      }
    })
    // 每个皮节和大多数皮神经分布区都应能解析到概念 / Every dermatome and most territories resolve to a concept.
    expect(maps.maps[0]!.regions.every((r) => r.concept)).toBe(true)
    expect(maps.maps[1]!.regions.filter((r) => r.concept).length).toBeGreaterThanOrEqual(30)
  })

  it('is what the definitions generate, deterministically', () => {
    expect(Buffer.from(g.bin).equals(Buffer.from(bin))).toBe(true)
    expect(JSON.stringify(g.skinMaps)).toBe(JSON.stringify(maps))
  })

  it('assigns every skin vertex; the inner wall copies the outer wall', () => {
    expect(report.dermatome.unassigned.count).toBe(0)
    expect(report.cutaneous.unassigned.count).toBe(0)
    expect(report.dermatome.unassigned.innerCount).toBe(0)
    const { skin } = g.ctx
    for (let i = 0; i < skin.n; i++) {
      if (skin.outer[i]) continue
      if (bin[i] !== bin[skin.outerOf[i]!] || bin[skin.n + i] !== bin[skin.n + skin.outerOf[i]!]) throw new Error(`inner vertex ${i} differs from its outer vertex`)
    }
  })

  it('has every ISNCSCI key sensory point in its own dermatome on both sides', () => {
    expect(report.dermatome.keyPoints.length).toBe(56)
    expect(report.dermatome.keyPointsFailed).toEqual([])
  })

  it('starts the back of T11, T12 and L1-L3 in order down the spine, at least 2 cm apart', () => {
    // 回归：原先 T12、L1 用棘突尖，与 T11 带的后部重叠，使 L1 在脊柱旁出现孤立小块。
    // Regression: T12 and L1 used the spinous process tips, which overlapped the back of the T11 band and left an island of L1 beside the spine.
    for (const side of ['L', 'R'] as const) {
      const ys = ['T11BackMid', 'T12BackMid', 'L1BackMid', 'L2BackMid', 'L3BackMid'].map((k) => g.ctx.lm.surfacePoint(k, side)[1])
      for (let i = 1; i < ys.length; i++) expect(ys[i - 1]! - ys[i]!, `${side} ${i}`).toBeGreaterThan(0.02)
    }
  })

  it('passes the classic checkpoints from independent sources', () => {
    const failed = [...new Set(report.dermatome.checks.filter((c) => !c.ok).map((c) => c.name))]
    expect(failed).toEqual(KNOWN.failedChecks)
    const got = (name: string) => report.dermatome.checks.filter((c) => c.name.startsWith(name)).map((c) => c.got)
    expect(got('Nipple line')).toEqual(['T4', 'T4'])
    expect(got('Beside the umbilicus')).toEqual(['T10', 'T10'])
    expect(got('Pad of the thumb')).toEqual(['C6', 'C6'])
    expect(got('Pad of the middle finger')).toEqual(['C7', 'C7'])
    expect(got('Pad of the little finger')).toEqual(['C8', 'C8'])
    expect(got('Dorsum of the great toe')).toEqual(['L5', 'L5'])
    expect(got('Little toe')).toEqual(['S1', 'S1'])
    expect(got('Perianal skin')).toEqual(['S4-5', 'S4-5'])
    for (const v of got('Angle of the mandible')) expect(['C2', 'C3']).toContain(v)
    // 剑突：其前方皮肤的大部分应属 T6，而不是恰好过半 / Xiphoid: most of the skin in front of it is T6, not a bare majority.
    for (const c of report.dermatome.checks.filter((c) => c.name.startsWith('Over the xiphoid'))) expect(c.shares!.T6, c.side).toBeGreaterThan(0.65)
  })

  it('is roughly symmetric and contiguous, with only the known exceptions', () => {
    for (const a of report.dermatome.areas) {
      expect(a.L + a.R, a.key).toBeGreaterThan(50)
      if (a.flagged) expect(a.key).toMatch(KNOWN.asymmetricDermatomes)
    }
    for (const p of report.dermatome.pieces) expect(p.region).toMatch(KNOWN.splitDermatomes)
    for (const p of report.cutaneous.pieces) expect(p.region).toMatch(KNOWN.splitTerritories)
    for (const a of report.cutaneous.areas) expect(a.L + a.R, a.key).toBeGreaterThan(20)
    expect(report.dermatome.speckle.isolated).toBeLessThanOrEqual(2)
    expect(report.cutaneous.speckle.isolated).toBeLessThanOrEqual(2)
    expect(report.dermatome.speckle.outvotedFraction).toBeLessThan(0.03)
    expect(report.cutaneous.speckle.outvotedFraction).toBeLessThan(0.03)
  })

  it('has nerve territories lying in the dermatomes of their textbook root values', () => {
    const rows = new Map(report.cutaneous.composition.map((c) => [c.key, c]))
    const flagged = report.cutaneous.composition.filter((c) => c.flagged).map((c) => c.key)
    for (const k of flagged) expect(KNOWN.disagreeingTerritories).toContain(k)
    expect(rows.get('lateralAntebrachial')!.inExpected).toBeGreaterThan(0.9)
    expect(rows.get('saphenous')!.inExpected).toBeGreaterThan(0.55)
    expect(rows.get('sural')!.inExpected).toBeGreaterThan(0.9)
    expect(rows.get('lateralFemoral')!.inExpected).toBeGreaterThan(0.75)
    expect(rows.get('median')!.inExpected).toBeGreaterThan(0.9)
    expect(rows.get('ulnar')!.inExpected).toBeGreaterThan(0.75)
    expect(segmentKeys('S5')).toEqual(['S4-5'])
  })

  it('writes innervation tables that point at real parts', () => {
    const table = JSON.parse(readFileSync(join(import.meta.dirname, '../data/curated/skinmaps/innervation.male.json'), 'utf8')) as Generated['tables']
    expect(JSON.stringify(table.dermatomes)).toBe(JSON.stringify(g.tables.dermatomes))
    for (const d of table.dermatomes) {
      expect(d.parts.L.length, d.dermatome).toBeGreaterThan(0)
      for (const p of [...d.parts.L, ...d.parts.R]) expect(g.ctx.body.byId.has(p.id)).toBe(true)
    }
    const saph = table.cutaneous.find((c) => c.territory === 'saphenous')!
    expect(saph.nerveParts.R.length).toBe(3)
    expect(saph.chain[0]!.name).toBe('femoral nerve')
    expect(saph.rootParts.R.length).toBeGreaterThan(0)
  })
})

describe.skipIf(!has('female'))('skin maps (public/anatomy/female)', () => {
  it('assigns every vertex and keeps the key sensory points', async () => {
    const g = await generate('female')
    const maps = JSON.parse(readFileSync(join(dirOf('female'), 'skinmaps.json'), 'utf8')) as SkinMaps
    const bin = new Uint8Array(readFileSync(join(dirOf('female'), 'skinmaps.bin')))
    expect(maps.part).toBe(g.ctx.skinPart)
    expect(Buffer.from(g.bin).equals(Buffer.from(bin))).toBe(true)
    expect(g.report.dermatome.unassigned.count).toBe(0)
    expect(g.report.cutaneous.unassigned.count).toBe(0)
    expect(g.report.dermatome.keyPointsFailed).toEqual([])
  }, 120_000)
})
