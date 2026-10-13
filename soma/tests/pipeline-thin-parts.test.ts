// 薄结构收回皮肤之内（tools/pipeline/thinParts.ts）和唇的切分（tools/pipeline/lipSplit.ts）：合成数据上的单元测试，
// 以及已发布的男性人体上的核对。
// Thin structures brought inside the skin (tools/pipeline/thinParts.ts) and the lip split
// (tools/pipeline/lipSplit.ts): unit tests on synthetic data and checks on the shipped male body.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnatomyData } from '../src/anatomy/types.ts'
import { measure, weld, type Mesh } from '../tools/pipeline/geometry.ts'
import { expandRetiredLipIds, LIP_HALVES, LIP_PARENT_FMA, lipPartIds, splitLip } from '../tools/pipeline/lipSplit.ts'
import { topology } from '../tools/pipeline/meshRepair.ts'
import { clipByScalar, recourseCentrelines, settleThinParts, SkinField, THIN_DEFAULTS, THIN_RULES, THIN_TISSUES } from '../tools/pipeline/thinParts.ts'

const ROOT = join(import.meta.dirname, '..')
const DIR = process.env.SOMA_MALE_DIR ?? join(ROOT, 'public/anatomy/male')
/** 男性：处理后仍在腋襞处露出一小片的部件（见下面的说明） / male: the parts that keep a small patch outside at the axillary folds (see the note below) */
const AXILLARY_RESIDUAL = new Set(['ZAACCC4854', 'ZAAFB06D34'])

/** 经纬球，法向朝外 / a latitude–longitude sphere, normals outwards */
function sphere(r: number, c: [number, number, number] = [0, 0, 0], n = 48, squash: (x: number, y: number, z: number) => [number, number, number] = (x, y, z) => [x, y, z]): Mesh {
  const pos: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= n; i++) for (let j = 0; j < 2 * n; j++) {
    const th = (Math.PI * i) / n
    const ph = (Math.PI * j) / n
    // 两极处 sin 取成正好 0，整圈顶点才重合 / sin is made exactly 0 at the poles so that the whole ring coincides
    const st = i === 0 || i === n ? 0 : Math.sin(th)
    const q = squash(r * st * Math.cos(ph), r * Math.cos(th), r * st * Math.sin(ph))
    pos.push(c[0] + q[0], c[1] + q[1], c[2] + q[2])
  }
  const at = (i: number, j: number) => i * 2 * n + (j % (2 * n))
  for (let i = 0; i < n; i++) for (let j = 0; j < 2 * n; j++) {
    if (i > 0) idx.push(at(i, j), at(i, j + 1), at(i + 1, j))
    if (i < n - 1) idx.push(at(i, j + 1), at(i + 1, j + 1), at(i + 1, j))
  }
  // 两极的顶点是重复的：焊接成一个 / the pole vertices are duplicated: welded into one
  const w = weld(Float32Array.from(pos), Uint32Array.from(idx))
  const mesh = { positions: w.positions, indices: w.indices }
  if (measure(mesh).signedVolume < 0) for (let t = 0; t < mesh.indices.length; t += 3) [mesh.indices[t + 1], mesh.indices[t + 2]] = [mesh.indices[t + 2]!, mesh.indices[t + 1]!]
  return mesh
}

/** 一张方片（细分 n×n），在平面 z = z0 上 / a square sheet (n×n), in the plane z = z0 */
function sheet(half: number, z0: number, n = 20): Mesh {
  const pos: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) pos.push(-half + (2 * half * i) / n, -half + (2 * half * j) / n, z0)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = i * (n + 1) + j
    idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2)
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

describe('thin parts: the signed depth field and the inward displacement', () => {
  const skin = sphere(0.1)
  const field = new SkinField(skin)
  it('measures signed depth and the inward direction on a sphere', () => {
    const out = new Float64Array(4)
    expect(field.sample(0, 0, 0.097, 0.01, out)).toBe(true)
    expect(out[0]!).toBeGreaterThan(0.0025)
    expect(out[0]!).toBeLessThan(0.0032)
    expect(out[3]!).toBeLessThan(-0.99)
    expect(field.sample(0, 0, 0.104, 0.01, out)).toBe(true)
    expect(out[0]!).toBeLessThan(-0.0038)
    expect(out[3]!).toBeLessThan(-0.99)
    // 深处：不必知道深度 / deep inside: the depth is not needed
    expect(field.sample(0, 0, 0, 0.01, out)).toBe(false)
    // 远在外面的点仍要找得到皮肤 / a point far outside must still find the skin
    expect(field.sample(0, 0, 0.14, 0.01, out)).toBe(true)
    expect(out[0]!).toBeLessThan(-0.039)
  })

  it('brings a sheet that cuts through the skin under it, smoothly, and leaves deep parts alone', () => {
    // 一张平片在 z = 0.095：中间在球内 5 mm，四周伸出球外 / a flat sheet at z = 0.095: 5 mm under the skin in the middle, outside the sphere round its rim
    const fascia = sheet(0.05, 0.095)
    const deep = sheet(0.03, 0.02)
    const res = settleThinParts(
      [{ id: 'f', name: 'Left test fascia', tissue: 'fascia', provenance: 'scanned', mesh: fascia }, { id: 'd', name: 'Left deep fascia', tissue: 'fascia', provenance: 'curated', mesh: deep }],
      [], skin, THIN_RULES.male,
    )
    expect([...res.changed.keys()]).toEqual(['f'])
    const m = res.changed.get('f')!.mesh
    const out = new Float64Array(4)
    for (let i = 0; i < m.positions.length; i += 3) {
      const ok = field.sample(m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!, 0.01, out)
      // 每个顶点至少在皮下 margin（留一点数值余量） / every vertex at least the margin under the skin (with a little numerical slack)
      if (ok) expect(out[0]!).toBeGreaterThan(THIN_DEFAULTS.margin - 1e-4)
      else expect(field.contains(m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!)).toBe(true)
    }
    const row = res.report.parts[0]!
    expect(row.rule).toBe('fasciaSheets')
    expect(row.outsideCm2.before).toBeGreaterThan(5)
    expect(row.outsideCm2.after).toBeLessThan(0.05)
    // scanned 的部件被形变，改标 warped / a scanned part was deformed: relabelled warped
    expect(row.provenance).toEqual({ before: 'scanned', after: 'warped' })
    expect(res.report.relabelledToWarped).toEqual(['f'])
    // 确定性：再算一遍逐字节相同 / deterministic: a second run is byte-identical
    const again = settleThinParts([{ id: 'f', name: 'Left test fascia', tissue: 'fascia', provenance: 'scanned', mesh: fascia }], [], skin, THIN_RULES.male)
    expect(Buffer.from(again.changed.get('f')!.mesh.positions.buffer).equals(Buffer.from(m.positions.buffer))).toBe(true)
  })

  it('measures digital parts inside bone only when asked, and holds the move back where it would enter bone', () => {
    // 皮肤是半径 100 mm 的球；皮下 2 mm 处放一块“指骨”（半径 6 mm 的球，中心在 z = 0.092）；一张“指静脉”平片在 z = 0.0995，
    // 中间离皮肤 0.5 mm：位移场要把它推到皮下 2.5 mm（z ≈ 0.0975），正好推进骨里（骨的前缘在 z = 0.098）
    // the skin is a sphere of radius 100 mm; a "phalanx" (a sphere of radius 6 mm centred at z = 0.092) lies 2 mm under it; a flat "digital vein"
    // at z = 0.0995 is 0.5 mm under the skin in its middle: the field wants it 2.5 mm deep (z ≈ 0.0975), which is inside the bone (its front is at z = 0.098)
    const bone = { name: 'Proximal phalanx of left test finger', mesh: sphere(0.006, [0, 0, 0.092], 16) }
    const vein = { id: 'v', name: 'Proper palmar digital vein of left test finger', tissue: 'vein', provenance: 'warped', mesh: sheet(0.004, 0.0995, 16) }
    const plain = settleThinParts([vein], [bone], skin, THIN_RULES.female)
    // 不要求时报告里没有这一项（男性的输出不变） / without the request the report has no such entry (the male output is unchanged)
    expect('insideBone' in plain.report).toBe(false)
    expect('insideBone' in plain.report.parts[0]!).toBe(false)
    expect('boneRelief' in plain.report.parts[0]!).toBe(false)
    const ask = { insideBone: { parts: /\bdigital\b/i, bones: /phalanx/i } }
    const measured = settleThinParts([vein], [bone], skin, THIN_RULES.female, THIN_DEFAULTS, ask)
    // 只量不改：几何与不要求时逐字节相同 / measuring changes nothing: the geometry is byte for byte the same
    expect(Buffer.from(measured.changed.get('v')!.mesh.positions.buffer).equals(Buffer.from(plain.changed.get('v')!.mesh.positions.buffer))).toBe(true)
    expect(measured.report.insideBone!.shareBefore).toBe(0)
    expect(measured.report.insideBone!.shareAfter).toBeGreaterThan(0.2)
    const relieved = settleThinParts([vein], [bone], skin, THIN_RULES.female, THIN_DEFAULTS, { ...ask, keepOutOfBone: true })
    expect(relieved.report.insideBone!.shareAfter).toBe(0)
    expect(relieved.report.parts[0]!.boneRelief!.points).toBeGreaterThan(0)
    // 仍在皮肤之内 / still inside the skin
    expect(relieved.report.parts[0]!.outsideCm2.after).toBe(0)
  })

  it('re-courses a nerve by its centreline, radius included', () => {
    // 一条沿 x 的线，中段在球外 / a line along x whose middle is outside the sphere
    const n = 21
    const pts = new Float32Array(3 * n)
    const rad = new Float32Array(n).fill(0.001)
    for (let i = 0; i < n; i++) pts.set([-0.03 + 0.003 * i, 0, 0.0985 + 0.003 * Math.sin((Math.PI * i) / (n - 1))], 3 * i)
    const r = recourseCentrelines(field, [{ points: pts, radius: rad }], THIN_DEFAULTS)
    expect(r).not.toBeNull()
    const out = new Float64Array(4)
    for (const l of r!.lines) for (let i = 0; i < l.points.length; i += 3) {
      expect(field.sample(l.points[i]!, l.points[i + 1]!, l.points[i + 2]!, 0.02, out)).toBe(true)
      // 中心线至少在皮下 margin + 半径（简化容差 0.25 mm） / the centreline at least margin + radius under the skin (simplification tolerance 0.25 mm)
      expect(out[0]!).toBeGreaterThan(THIN_DEFAULTS.margin + 0.001 - 0.0003)
    }
    expect(r!.maxMm).toBeGreaterThan(3)
  })

  it('clips a sheet by a scalar and keeps the positive side', () => {
    const s = sheet(0.05, 0, 10)
    const val = new Float32Array(s.positions.length / 3)
    for (let v = 0; v < val.length; v++) val[v] = s.positions[3 * v]! - 0.0123
    const c = clipByScalar(s, val)
    const st = measure(c)
    expect(st.bbox[0]).toBeCloseTo(0.0123, 5)
    expect(st.area).toBeCloseTo(0.1 * (0.05 - 0.0123), 6)
  })

  it('has a rule for every body and handles only tissues outside the skin fit', () => {
    for (const body of ['male', 'female'] as const) {
      const rule = (n: string) => THIN_RULES[body].find((r) => r.name.test(n))!.key
      expect(rule('Left crural fascia')).toBe('cruralFascia')
      expect(rule('Set of plantar digital veins')).toBe('digitalVessels')
      expect(rule('Left dorsal digital branches of radial nerve')).toBe('digitalNerves')
      expect(rule('Left fascia lata')).toBe('fasciaSheets')
      expect(rule('Left iliotibial tract')).toBe('fasciaSheets')
      expect(rule('Left investing abdominal fascia')).toBe('fasciaSheets')
      expect(rule('Left great saphenous vein')).toBe('subcutaneous')
    }
    for (const t of ['muscle', 'bone', 'cartilage', 'organ', 'skin', 'fat']) expect(THIN_TISSUES.has(t)).toBe(false)
  })
})

describe('lip split', () => {
  // 两个扁椭球上下叠着、略有重叠：合起来是一个中间有沟的闭合体（这里直接用两个球的并的近似：一个腰部收细的旋转体）
  // a closed body with a groove round its middle: a surface of revolution about the x axis pinched at y = y0
  const y0 = 1.4572
  const lip = sphere(1, [0, y0, 0.18], 24, (x, y, z) => {
    // x：宽 50 mm；y：高 16 mm；z：厚 12 mm，在 y = 0 处前表面凹进 2 mm / x 50 mm wide, y 16 mm high, z 12 mm thick, with the front 2 mm in at y = 0
    const groove = 1 - 0.35 * Math.exp(-((y / 0.25) ** 2))
    return [0.025 * x, 0.008 * y, 0.006 * z * groove]
  })
  it('finds the fissure and cuts into two closed halves whose volumes add up', () => {
    expect(topology(lip)).toEqual({ triangles: 2208, boundaryEdges: 0, nonManifoldEdges: 0, inconsistentEdges: 0, watertight: true })
    const r = splitLip(lip)
    expect(r).not.toBeNull()
    expect(Math.abs(r!.report.fissure.yAtMidlineM - y0)).toBeLessThan(0.0006)
    expect(r!.report.upper.watertight).toBe(true)
    expect(r!.report.lower.watertight).toBe(true)
    expect(Math.abs(r!.report.volumeDifferenceMl)).toBeLessThan(1e-3)
    expect(r!.report.upper.volumeMl).toBeGreaterThan(0.3 * r!.report.source.volumeMl)
    expect(r!.report.lower.volumeMl).toBeGreaterThan(0.3 * r!.report.source.volumeMl)
    expect(measure(r!.upper).bbox[1]).toBeGreaterThan(y0 - 0.0008)
    expect(measure(r!.lower).bbox[4]).toBeLessThan(y0 + 0.0008)
    expect(r!.report.cut.capAreaCm2).toBeGreaterThan(0)
  })
  it('names the halves and replaces a retired id', () => {
    expect(lipPartIds('W_FJ2814')).toEqual({ upper: 'W_FJ2814_upper', lower: 'W_FJ2814_lower' })
    expect(expandRetiredLipIds(['A', 'FJ2814', 'B'], new Map([['FJ2814', lipPartIds('FJ2814')]]))).toEqual(['A', 'FJ2814_upper', 'FJ2814_lower', 'B'])
    expect(LIP_HALVES.upper.fma).toBe('FMA59817')
    expect(LIP_HALVES.lower.fma).toBe('FMA59818')
    expect(LIP_PARENT_FMA).toBe('FMA59816')
  })
})

describe('shipped male body: thin parts and the lip halves', () => {
  const present = existsSync(join(DIR, 'anatomy.json')) && existsSync(join(DIR, 'pipeline-report.json'))
  const data = (present ? JSON.parse(readFileSync(join(DIR, 'anatomy.json'), 'utf8')) : null) as AnatomyData | null
  const report = present ? JSON.parse(readFileSync(join(DIR, 'pipeline-report.json'), 'utf8')) : null
  const display = present && existsSync(join(DIR, 'display.json')) ? JSON.parse(readFileSync(join(DIR, 'display.json'), 'utf8')) : null
  const applied = !!report?.thinParts?.applied

  it.skipIf(!present || !applied)('records the reference surface, the rules and what was done to every treated part', () => {
    const tp = report.thinParts
    // 参考皮肤的身份：相对目录、文件、SHA-1；它是按本次骨架拟合的 / identity of the reference: relative directory, file, SHA-1; fitted to this skeleton
    expect(tp.reference.sha1).toMatch(/^[0-9a-f]{40}$/)
    expect(tp.reference.dir.startsWith('/')).toBe(false)
    expect(tp.reference.fittedTo).toEqual({ body: 'male', key: report.skinPackage.internalsKey })
    expect(tp.marginMm).toBe(2.5)
    expect(tp.rules.map((r: { key: string }) => r.key)).toEqual(THIN_RULES.male.map((r) => r.key))
    const byId = new Map(data!.parts.map((p) => [p.id, p]))
    for (const row of tp.parts as { id: string; tissue: string; provenance: { before: string; after: string }; outsideCm2: { before: number; after: number }; moved: unknown; clipped?: unknown; note: string }[]) {
      const p = byId.get(row.id)!
      expect(p, row.id).toBeDefined()
      expect(THIN_TISSUES.has(row.tissue), row.id).toBe(true)
      expect(p.provenance, row.id).toBe(row.provenance.after)
      // 被形变或剪过的 scanned 部件不再标 scanned / a scanned part that was deformed or clipped is no longer marked scanned
      expect(row.provenance.after, row.id).not.toBe('scanned')
      expect(row.moved !== null || row.clipped !== undefined, row.id).toBe(true)
      expect(row.note.length).toBeGreaterThan(20)
      // 处理后露出的面积：不超过原来的四分之一（或 0.5 cm²）。例外是两侧的腹部包被筋膜：剩下的 1–2.5 cm² 全在腋襞处，
      // 那里上臂和胸壁的皮肤相贴、互相遮挡（皮肤自身的已知缺陷），“内外”在那里定义不好，位移场收不进去。
      // Area outside after the treatment: at most a quarter of what it was (or 0.5 cm²). The exception is the
      // investing abdominal fascia of both sides: the 1–2.5 cm² left all lies at the axillary folds, where the
      // skin of arm and chest wall lie together and cover each other (a known defect of the skin itself), so
      // inside/outside is ill-defined there and the field cannot take the sheet in.
      expect(row.outsideCm2.after, row.id).toBeLessThanOrEqual(AXILLARY_RESIDUAL.has(row.id) ? 3 : Math.max(0.5, 0.25 * row.outsideCm2.before))
      expect(row.outsideCm2.after, row.id).toBeLessThanOrEqual(row.outsideCm2.before)
    }
    expect(tp.outsideCm2.before).toBeGreaterThan(80)
    expect(tp.outsideCm2.after).toBeLessThan(0.08 * tp.outsideCm2.before)
    // 两侧小腿筋膜在趾根剪掉：不再伸到趾骨的远端 / both crural fasciae are clipped at the toe bases: they no longer reach the distal toe bones
    const clipped = (tp.parts as { id: string; name: string; clipped?: { removedCm2: number } }[]).filter((r) => r.clipped)
    expect(clipped.map((r) => r.name).sort()).toEqual(['Left crural fascia', 'Right crural fascia'])
    for (const r of clipped) {
      expect(r.clipped!.removedCm2).toBeGreaterThan(40)
      const side = /^Left/.test(r.name) ? 'left' : 'right'
      // 筋膜原先一直包到拇趾尖；现在它的最前端在拇趾远节趾骨之后（外侧几趾较短，所以只同拇趾比）
      // the sheet used to reach the tip of the big toe; its foremost point now lies behind the distal phalanx of the big toe (the lateral toes are shorter, so only the big toe is compared)
      const tip = data!.parts.find((p) => p.name === `Distal phalanx of ${side} big toe`)!
      expect(tip, side).toBeDefined()
      expect(byId.get(r.id)!.bbox[5]).toBeLessThan(tip.bbox[2])
    }
    // 神经标志点仍全部通过 / the nerve landmarks all still pass
    expect((report.landmarks as { evaluated: boolean; pass: boolean }[]).filter((l) => l.evaluated && !l.pass)).toEqual([])
    // 说明里写的是面积，不再是旧的比例 / the caution states areas, not the earlier share
    const all = data!.cautions!.map((c) => c.en).join(' ')
    expect(all).toContain('cut off at the bases of the toes')
    expect(all).toContain('Measured by area')
    expect(all).not.toContain('were not considered')
  })

  it.skipIf(!present || !report?.lipSplit?.applied)('ships the lip as an upper and a lower part, in the trees and on the lists', () => {
    const row = (report.lipSplit.parts as { split: boolean; retiredId: string; parts: { id: string; fma: string; name: string }[]; upper: { watertight: boolean }; lower: { watertight: boolean }; volumeDifferenceMl: number; provenanceNote: string }[]).find((p) => p.split)!
    const ids = lipPartIds(row.retiredId)
    expect(row.parts.map((p) => p.id)).toEqual([ids.upper, ids.lower])
    const byId = new Map(data!.parts.map((p) => [p.id, p]))
    // 原 id 退役 / the original id is retired
    expect(byId.has(row.retiredId)).toBe(false)
    const up = byId.get(ids.upper)!
    const lo = byId.get(ids.lower)!
    expect([up.name, up.fma, lo.name, lo.fma]).toEqual(['Upper lip', 'FMA59817', 'Lower lip', 'FMA59818'])
    expect(up.centroid[1]).toBeGreaterThan(lo.centroid[1])
    expect(up.bbox[1]).toBeGreaterThan(lo.bbox[4] - 0.0015)
    for (const p of [up, lo]) {
      expect(p.system).toBe('digestive')
      expect(p.side).toBe('M')
      expect(p.volume).toBeUndefined()
    }
    expect(row.upper.watertight && row.lower.watertight).toBe(true)
    expect(Math.abs(row.volumeDifferenceMl)).toBeLessThan(1e-3)
    expect(row.provenanceNote).toContain('capped')
    // 两半互为邻接 / the halves are adjacent to each other
    expect(up.adjacent).toContain(lo.id)
    expect(lo.adjacent).toContain(up.id)
    // isa 树：两个概念都挂在“唇”下，各带自己的部件；partOf 树里原来就没有唇，现在也没有
    // the isa tree: both concepts under "lip", each with its own part; the partOf tree never had the lip and still has not
    const isa = new Map(data!.trees.isa.map((c) => [c.id, c]))
    expect(isa.get('FMA59817')).toMatchObject({ parent: LIP_PARENT_FMA, parts: [ids.upper] })
    expect(isa.get('FMA59818')).toMatchObject({ parent: LIP_PARENT_FMA, parts: [ids.lower] })
    expect(isa.get(LIP_PARENT_FMA)!.parts).toEqual([])
    for (const t of [data!.trees.isa, data!.trees.partOf]) for (const c of t) expect(c.parts).not.toContain(row.retiredId)
    expect(data!.trees.partOf.some((c) => c.parts.includes(ids.upper) || c.parts.includes(ids.lower))).toBe(false)
    // 皮肤不透明时隐藏、皮肤有意不包住：两半都在名单上 / hidden under an opaque skin and not enclosed by design: both halves are listed
    if (report.skinPackage?.opened) {
      for (const id of [ids.upper, ids.lower]) {
        expect(report.appendages.hideWithOpaqueSkin).toContain(id)
        expect(display.hideWithOpaqueSkin).toContain(id)
        expect(report.skinPackage.notEnclosedPartIds).toContain(id)
      }
      expect(report.appendages.deepLip.ids).toEqual([ids.upper, ids.lower])
      expect(report.skinPackage.notEnclosedPartIds).not.toContain(row.retiredId)
    }
  })
})
