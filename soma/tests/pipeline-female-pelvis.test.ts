// 女性小骨盆（Wu 等 2015 的盆底）的校验：网格修复与切分的单元测试，以及对输出 GLB 中成品几何的数值检查。
// 尚未构建时后者跳过。
// Checks of the female lesser pelvis (the pelvic floor of Wu et al. 2015): unit tests of mesh repair and
// cutting, and numeric checks on the finished geometry in the written GLBs. The latter are skipped when
// the body has not been built.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnatomyData } from '../src/anatomy/types.ts'
import { loadBuiltBody } from '../tools/pipeline/body.ts'
import type { Mesh } from '../tools/pipeline/geometry.ts'
import { components, cutByPlane, repairClosed, signedVolume, topology } from '../tools/pipeline/meshRepair.ts'
import { pelvisChecks, perineumAgainstSkin, pullField, refineWhere, WU_NOT_SHIPPED, WU_PRIORITY, WU_SPECS } from '../tools/pipeline/pelvis.ts'

// SOMA_FEMALE_DIR：改为校验另一个目录里的构建（管线的 --out） / SOMA_FEMALE_DIR: validate a build in another directory instead (the pipeline's --out)
const DIR = process.env.SOMA_FEMALE_DIR ?? join(import.meta.dirname, '../public/anatomy/female')
const present = existsSync(join(DIR, 'anatomy.json')) && existsSync(join(DIR, 'pipeline-report.json'))

/** 细分的八面体（近似球），半径 r，中心 c / a subdivided octahedron (a rough sphere) of radius r about c */
function ball(c: [number, number, number], r: number, levels = 3): Mesh {
  let pos = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]
  let idx = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5]
  for (let l = 0; l < levels; l++) {
    const mid = new Map<string, number>()
    const m = (a: number, b: number) => {
      const k = a < b ? `${a},${b}` : `${b},${a}`
      let v = mid.get(k)
      if (v === undefined) {
        v = pos.length / 3
        const p = [0, 1, 2].map((i) => pos[3 * a + i]! + pos[3 * b + i]!)
        const n = Math.hypot(p[0]!, p[1]!, p[2]!)
        pos.push(p[0]! / n, p[1]! / n, p[2]! / n)
        mid.set(k, v)
      }
      return v
    }
    const next: number[] = []
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, d] = [idx[t]!, idx[t + 1]!, idx[t + 2]!]
      const [ab, bd, da] = [m(a, b), m(b, d), m(d, a)]
      next.push(a, ab, da, ab, b, bd, da, bd, d, ab, bd, da)
    }
    idx = next
  }
  pos = pos.map((v, i) => c[i % 3]! + r * v)
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

describe('mesh repair and cutting (meshRepair.ts)', () => {
  it('measures topology and volume of a closed mesh', () => {
    const b = ball([0, 0, 0], 0.01)
    const t = topology(b)
    expect(t.watertight).toBe(true)
    expect(t.boundaryEdges).toBe(0)
    expect(signedVolume(b) * 1e6).toBeGreaterThan(3.8)
    expect(signedVolume(b) * 1e6).toBeLessThan((4 / 3) * Math.PI)
  })

  it('removes fragments, flips inverted winding and leaves positions alone', () => {
    const big = ball([0, 0, 0], 0.01)
    const crumb = ball([0.05, 0, 0], 0.001, 0)
    const idx = Uint32Array.from([...big.indices, ...Array.from(crumb.indices, (v) => v + big.positions.length / 3)])
    for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2]!, idx[t + 1]!]
    const { mesh, report } = repairClosed({ positions: Float32Array.from([...big.positions, ...crumb.positions]), indices: idx })
    expect(report.flipped).toBe(true)
    expect(report.fragmentsRemoved).toBe(1)
    expect(report.after.watertight).toBe(true)
    expect(components(mesh).length).toBe(1)
    expect(signedVolume(mesh)).toBeCloseTo(signedVolume(big), 9)
  })

  it('separates two bodies that touch along an edge', () => {
    // 两个共用一条边的四面体：该边属于四个三角形 / two tetrahedra sharing one edge: that edge has four triangles
    const positions = Float32Array.from([0, 0, 0, 0, 0, 1, 1, 0, 0.5, 0.5, 1, 0.5, -1, 0, 0.5, -0.5, -1, 0.5].map((v) => v * 0.01))
    const tet = (a: number, b: number, c: number, d: number) => [a, c, b, a, b, d, b, c, d, c, a, d]
    const raw: Mesh = { positions, indices: Uint32Array.from([...tet(0, 1, 2, 3), ...tet(1, 0, 4, 5)]) }
    expect(topology(raw).nonManifoldEdges).toBe(1)
    const { mesh, report } = repairClosed(raw)
    expect(report.nonManifoldEdgesBefore).toBe(1)
    expect(report.verticesSplit).toBe(2)
    expect(report.after.watertight).toBe(true)
    expect(components(mesh).length).toBe(2)
    expect(Math.abs(signedVolume(mesh))).toBeCloseTo(Math.abs(signedVolume(raw)), 12)
  })

  it('cuts a closed mesh in two closed halves whose volumes add up', () => {
    const b = ball([0.002, 0, 0], 0.01)
    const cut = cutByPlane(b, [1, 0, 0], 0)
    expect(cut.loops).toBe(1)
    expect(topology(cut.positive).watertight).toBe(true)
    expect(topology(cut.negative).watertight).toBe(true)
    expect(signedVolume(cut.positive) + signedVolume(cut.negative)).toBeCloseTo(signedVolume(b), 10)
    expect(signedVolume(cut.positive)).toBeGreaterThan(signedVolume(cut.negative))
    for (let i = 0; i < cut.positive.positions.length; i += 3) expect(cut.positive.positions[i]!).toBeGreaterThanOrEqual(-1e-9)
  })

  it('refines locally without opening the mesh, and pulls smoothly', () => {
    const b = ball([0, 0, 0], 0.01, 2)
    const fine = refineWhere(b, (x) => x > 0.005, 0.001)
    expect(fine.indices.length).toBeGreaterThan(b.indices.length)
    expect(topology(fine).watertight).toBe(true)
    expect(signedVolume(fine)).toBeCloseTo(signedVolume(b), 9)
    const moved = pullField([{ from: [0.01, 0, 0], to: [0.015, 0, 0], sigma: 0.004 }])(b.positions)
    let far = 0
    let near = 0
    for (let i = 0; i < moved.length; i += 3) {
      const d = Math.hypot(moved[i]! - b.positions[i]!, moved[i + 1]! - b.positions[i + 1]!, moved[i + 2]! - b.positions[i + 2]!)
      if (b.positions[i]! < -0.005) far = Math.max(far, d)
      if (b.positions[i]! > 0.0099) near = Math.max(near, d)
    }
    expect(near).toBeCloseTo(0.005, 4)
    expect(far).toBeLessThan(1e-5)
  })
})

describe('catalogue of the Wu structures (pelvis.ts)', () => {
  it('classifies every structure and ranks every one for giving way', () => {
    const items = new Set(WU_SPECS.map((s) => s.item))
    expect(items.size).toBe(WU_SPECS.length)
    for (const s of WU_SPECS) {
      expect(WU_PRIORITY, s.item).toContain(s.item)
      expect(s.concept, s.item).toMatch(/^(FMA\d+|WUC_[a-z_]+)$/)
      if (s.split !== 'whole') expect(s.sided, s.item).toMatch(/\{[sS]\}/)
      for (const c of s.sidedConcept ?? []) expect(c).toMatch(/^FMA\d+$/)
      expect(WU_NOT_SHIPPED[s.item], s.item).toBeUndefined()
    }
    // 肛管的结构归消化系统，尿道的归泌尿系统，阴蒂、前庭球和前庭大腺归生殖系统
    // anal-canal structures are digestive, urethral ones urinary, clitoris, bulbs and glands reproductive
    const sys = (item: string) => WU_SPECS.find((s) => s.item === item)!.system
    expect(sys('internal_anal_sphincter')).toBe('digestive')
    expect(sys('urethral_sphincter_proper')).toBe('urinary')
    expect(sys('vestibular_bulb')).toBe('reproductive')
    expect(sys('puborectal_muscle_deep_part')).toBe('muscular')
  })
})

describe.skipIf(!present)('female lesser pelvis as shipped (public/anatomy/female)', async () => {
  const data = (present ? JSON.parse(readFileSync(join(DIR, 'anatomy.json'), 'utf8')) : null) as AnatomyData
  const report = (present ? JSON.parse(readFileSync(join(DIR, 'pipeline-report.json'), 'utf8')) : null) as Record<string, any>
  const body = present ? await loadBuiltBody(DIR) : null
  const idOf = new Map<string, string>()
  if (present) for (const p of data.parts) if (!idOf.has(p.name)) idOf.set(p.name, p.id)
  const get = (k: string): Mesh | null => body!.meshes.get(k) ?? body!.meshes.get(idOf.get(k) ?? '') ?? null
  const ids = present ? data.parts.map((p) => p.id) : []
  const wu = present ? data.parts.filter((p) => p.id.startsWith('WU_')) : []
  const result = present ? pelvisChecks(get, ids) : null
  const check = (id: string) => result!.checks.find((c) => c.id === id)!

  it('ships the Wu structures, split into left and right, and none of the male pelvic floor', () => {
    expect(wu.length).toBeGreaterThanOrEqual(48)
    for (const s of WU_SPECS) {
      const mine = wu.filter((p) => p.id.replace(/_[LR]$/, '') === `WU_${s.item}`)
      expect(mine.map((p) => p.side).sort(), s.item).toEqual(s.split === 'whole' ? ['M'] : ['L', 'R'])
      for (const p of mine) {
        expect(p.provenance).toBe('curated')
        expect(p.source).toBe('Wu et al. 2015 pelvic floor')
        if (p.side !== 'M') expect(p.name, p.id).toMatch(p.side === 'L' ? /\b[Ll]eft\b/ : /\b[Rr]ight\b/)
        // 左侧部件在中线左侧（+X） / a left part lies on the left of the midline (+X)
        if (p.side !== 'M') expect(Math.sign(p.centroid[0] - 0.0008), p.id).toBe(p.side === 'L' ? 1 : -1)
      }
    }
    const names = new Set(data.parts.map((p) => p.name))
    for (const n of ['Left puborectalis', 'Right pubococcygeus', 'Left iliococcygeus', 'Urethra']) expect(names.has(n), n).toBe(false)
    for (const n of ['Left coccygeus', 'Right coccygeus', 'External anal sphincter', 'Rectum', 'Vagina', 'Uterus']) expect(data.parts.filter((p) => p.name === n).map((p) => p.id.slice(0, 3)), n).toEqual(['WU_'])
    for (const p of data.parts) if (/^W_/.test(p.id)) expect(/levator ani$|puborectalis|pubococcygeus|iliococcygeus|coccygeus$|^Rectum$|anal sphincter/.test(p.name) && p.tissue === 'muscle', p.name).toBe(false)
  })

  it('ships closed, consistently wound meshes', () => {
    const open: string[] = []
    for (const p of wu) {
      const m = get(p.id)!
      const t = topology(m)
      if (!t.watertight) open.push(p.id)
      expect(signedVolume(m), p.id).toBeGreaterThan(0)
    }
    // 直肠系膜（作者给出的表面有 150 多条非流形边）要修两遍才封闭，现在也不例外
    // the mesorectum (the authors' surface has 150-odd non-manifold edges) takes two repair passes to close and is no longer an exception
    expect(open).toEqual([])
    expect(report.wu.closedManifolds).toBe(wu.length)
  })

  it('places every Wu part in both trees with a concept of its own', () => {
    const isa = new Map(data.trees.isa.map((c) => [c.id, c]))
    const partOf = new Set(data.trees.partOf.flatMap((c) => c.parts))
    for (const p of wu) {
      expect(isa.has(p.fma), `${p.id} ${p.fma}`).toBe(true)
      expect(partOf.has(p.id), p.id).toBe(true)
      expect(p.fma, p.id).toMatch(/^(FMA\d+(_[LR])?|WUC_[a-z_]+(_[LR])?)$/)
    }
    // 分侧的概念不共用 / sided parts do not share a concept
    for (const p of wu) if (p.side !== 'M') expect(wu.filter((q) => q.fma === p.fma).length, p.fma).toBe(1)
    const up = (id: string): string[] => {
      const out: string[] = []
      for (let c = isa.get(id); c; c = c.parent ? isa.get(c.parent) : undefined) out.push(c.name)
      return out
    }
    expect(up(wu.find((p) => p.id === 'WU_puborectal_muscle_deep_part_L')!.fma)).toContain('puborectalis')
    expect(up(wu.find((p) => p.id === 'WU_pubovisceral_muscle_inner_layer_R')!.fma)).toContain('pubovisceralis')
    const po = new Map(data.trees.partOf.map((c) => [c.id, c]))
    const holder = (id: string) => data.trees.partOf.filter((c) => c.parts.includes(id)).flatMap((c) => {
      const out: string[] = []
      for (let x: typeof c | undefined = c; x; x = x.parent ? po.get(x.parent) : undefined) out.push(x.name)
      return out
    })
    expect(holder('WU_coccygeal_muscle_L')).toContain('pelvic diaphragm')
    expect(holder('WU_bulbospongiosus_muscle_R')).toContain('perineum')
    expect(holder('WU_urethral_sphincter_proper')).toContain('female urethra')
  })

  it.each([
    'levatorHiatusContainsUrethraVaginaAnorectum', 'externalAnalSphincterEncirclesInternal', 'urethralSphincterEncirclesUrethra', 'perinealBodyBetweenVaginaAndAnalCanal',
    'clitorisAndBulbsBelowPubicArch', 'coccygeusSpansIschialSpineToSacrum', 'noInterpenetrationAmongCoreStructures', 'joinsAreContinuous', 'withinBonyPelvis', 'leftRightPresent',
    'uterusBetweenBladderAndRectum', 'adnexaLateralAndClearOfBowel',
  ])('passes the pelvic check %s on the shipped geometry', (id) => {
    const c = check(id)
    expect(c, id).toBeDefined()
    expect(c.pass, `${id}: ${JSON.stringify(c.measured).slice(0, 600)}`).toBe(true)
    // 管线报告里的同一项检查也通过 / the same check passed in the pipeline's own report
    expect(report.pelvisChecks.checks.find((x: { id: string }) => x.id === id).pass, id).toBe(true)
  })

  it('has a levator hiatus of plausible size with urethra, vagina and anorectum in that order', () => {
    const m = check('levatorHiatusContainsUrethraVaginaAnorectum').measured as any
    expect(m.order.anteriorToPosterior).toBe(true)
    // 没有打开文献核对正常值：这里只防止明显离谱的尺寸 / no published norm was opened: these bounds only catch absurd sizes
    expect(m.innerMm.transverseAtVagina).toBeGreaterThan(15)
    expect(m.innerMm.transverseAtVagina).toBeLessThan(60)
    expect(m.innerMm.symphysisToSling).toBeGreaterThan(30)
    expect(m.innerMm.symphysisToSling).toBeLessThan(90)
    expect(m.norms).toMatch(/^unreferenced/)
  })

  it('keeps overlaps among all Wu structures small and hollow organs their volume', () => {
    expect(result!.pairs[0]?.insidePct ?? 0).toBeLessThan(6)
    expect(result!.pairs.filter((p) => p.insidePct > 1).length).toBeLessThan(25)
    const b = report.pelvis.bladder.volumeMl
    expect(Math.abs(b.after / b.before - 1)).toBeLessThan(0.05)
    for (const u of report.pelvis.ureters.rows) expect(Math.abs(u.volumeMl.after / u.volumeMl.before - 1), u.side).toBeLessThan(0.05)
    // 原样采用的器官不变形：阴道是让位次序里的第一个 / organs adopted as they are keep their shape: the vagina is first in the order of giving way
    expect(report.pelvis.wuOverlaps.volumeChangedMoreThan5pct.WU_vaginal_wall).toBeUndefined()
    expect(report.pelvis.wuOverlaps.after.over1pct).toBeLessThan(report.pelvis.wuOverlaps.before.over1pct / 4)
  })

  it('records both options and the placement of the perineum against the skin', () => {
    expect(report.pelvis.options.b.hraVaginaSurfaceInsideWuStructuresPct).toBeGreaterThan(5)
    expect(report.pelvis.options.a.chosen).toMatch(/Wu uterus/)
    const sk = perineumAgainstSkin(get, ids, get('Skin'), null)
    expect(Object.keys(sk.structures as object).length).toBeGreaterThanOrEqual(12)
    expect(Object.keys(report.perineumAgainstSkin.structures).length).toBe(Object.keys(sk.structures as object).length)
  })
})
