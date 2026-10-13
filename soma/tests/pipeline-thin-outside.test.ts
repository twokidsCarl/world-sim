// 薄结构露在皮肤外的面积（tools/pipeline/thinOutside.ts）：在已发布的两个人体上重算。
// 原先的量法（report.skinPackage.notFitted.thin：露出的比例和到最近皮肤的距离）在两个人体上都“通过”，
// 而趾蹼处横着小腿筋膜、她的大腿根处翻出阔筋膜——这组测试原是为这些已知的情形写的（下限：毛病必须被量出来）。
// 这些毛病已由 tools/pipeline/thinParts.ts 修好（小腿筋膜在趾根剪掉，其余用位移场收到皮下），先是男性，后是女性，
// 所以两个人体的下限都已改成上限（FIXED）。
//
// Area of thin structures outside the skin (tools/pipeline/thinOutside.ts), recomputed on the two shipped
// bodies. The earlier measure (report.skinPackage.notFitted.thin: a share outside and the distance to the
// nearest skin) "passes" on both bodies while the crural fascia lay across every web space between the
// toes and, on her, the fascia lata stands out at the root of each thigh — these tests were built on
// those cases (lower bounds: the faults must be measured). The faults are repaired by
// tools/pipeline/thinParts.ts (crural fascia clipped at the toe bases, the rest taken under the skin by a
// displacement field), first on the male body and then on the female one, so the lower bounds of both are
// now upper bounds (FIXED).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadBuiltBody } from '../tools/pipeline/body.ts'
import { FAT_DEEP_TISSUES } from '../tools/pipeline/fat.ts'
import { RobustInside, thinStructuresOutsideSkin, type ThinOutside } from '../tools/pipeline/thinOutside.ts'

const ROOT = join(import.meta.dirname, '..')
const DIRS = { male: process.env.SOMA_MALE_DIR ?? join(ROOT, 'public/anatomy/male'), female: process.env.SOMA_FEMALE_DIR ?? join(ROOT, 'public/anatomy/female') }

/**
 * 已修好的情形：部件 id、露出面积的上限（cm²，在发布的皮肤上量；注释里是修之前 → 修之后量得的值）。
 * The repaired cases: part id and upper bound of the area outside (cm², measured on the shipped skin; the
 * comments give the value before → after the repair).
 */
const FIXED: Record<'male' | 'female', { id: string; name: string; maxCm2: number }[]> = {
  male: [
    { id: 'ZAE982E04F', name: 'Left crural fascia', maxCm2: 1 }, // 21.2 → 0
    { id: 'ZAFB27CA9E', name: 'Right crural fascia', maxCm2: 1 }, // 20.0 → 0
    { id: 'ZAACCC4854', name: 'Left investing abdominal fascia', maxCm2: 4 }, // 27.3 → 1.05 (at the axillary fold)
    { id: 'ZAAFB06D34', name: 'Right investing abdominal fascia', maxCm2: 4 }, // 4.2 → 2.21 (at the axillary fold)
    { id: 'ZAE8457450', name: 'Left fascia lata', maxCm2: 1 }, // 6.3 → 0
    { id: 'ZA38D8A0B1', name: 'Right fascia lata', maxCm2: 1 }, // 5.7 → 0
    { id: 'FJ2120', name: 'Set of plantar digital veins', maxCm2: 1 }, // 5.6 → 0
    { id: 'FJ2175', name: 'Set of plantar digital veins', maxCm2: 1 }, // 5.0 → 0
    { id: 'FJ2185', name: 'Set of dorsal digital veins', maxCm2: 1 }, // 4.0 → 0
    { id: 'FJ2198', name: 'Set of dorsal digital veins', maxCm2: 1 }, // 3.3 → 0
    { id: 'ZA26CBCD39', name: 'Left dorsal digital branches of radial nerve', maxCm2: 1 }, // 4.7 → 0
    { id: 'ZA8C5324BA', name: 'Right dorsal digital branches of radial nerve', maxCm2: 1 }, // 4.5 → 0
  ],
  // 女性：“之前”是上一版发布的人体上量得的值（这组测试原先的下限就是照它定的）
  // female: "before" is what was measured on the previously shipped body (the earlier lower bounds of this test were set from it)
  female: [
    { id: 'W_ZAE982E04F', name: 'Left crural fascia', maxCm2: 1 }, // 14.6 → 0
    { id: 'W_ZAFB27CA9E', name: 'Right crural fascia', maxCm2: 1 }, // 12.6 → 0
    { id: 'W_ZAE8457450', name: 'Left fascia lata', maxCm2: 1 }, // 29.6 → 0
    { id: 'W_ZA38D8A0B1', name: 'Right fascia lata', maxCm2: 1 }, // 27.8 → 0.15
    { id: 'W_FJ1423M', name: 'Left iliotibial tract', maxCm2: 1 }, // 23.6 → 0
    { id: 'W_ZAACCC4854', name: 'Left investing abdominal fascia', maxCm2: 6 }, // 1.84 → 1.87 (at the axillary fold; not improved)
    { id: 'W_ZAAFB06D34', name: 'Right investing abdominal fascia', maxCm2: 6 }, // 4.71 → 4.33 (at the axillary fold; hardly improved)
    { id: 'W_ZA26CBCD39', name: 'Left dorsal digital branches of radial nerve', maxCm2: 1 }, // about 11 → 0
    { id: 'W_ZA8C5324BA', name: 'Right dorsal digital branches of radial nerve', maxCm2: 1 }, // about 11 → 0
  ],
}
/** 男性：头部以外全部薄结构露出面积的上限、前足的上限（cm²；修之前约 126 和 59） / male: upper bounds over all thin structures beyond the head, and in the forefoot (cm²; about 126 and 59 before the repair) */
const MALE_TOTAL_MAX_CM2 = 10 // 4.46
const MALE_FOREFOOT_MAX_CM2 = 3 // 0.01
/** 女性：同样的两个上限，另加大腿根（cm²；修之前全部 253、前足 45、大腿根 62） / female: the same two bounds and one for the thigh roots (cm²; before the repair 253 in all, 45 in the forefoot, 62 at the thigh roots) */
const FEMALE_TOTAL_MAX_CM2 = 20 // 10.09
const FEMALE_FOREFOOT_MAX_CM2 = 3 // 0
const FEMALE_THIGH_ROOT_MAX_CM2 = 3 // 0.12

describe('thin structures outside the skin, by area', () => {
  it('votes over three ray directions', () => {
    // 一个单位立方体：内部的点在内，外面的点在外，三条射线一致 / a unit cube: inside is inside, outside is outside, the three rays agree
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1])
    const indices = Uint32Array.from([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 6, 2, 3, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5])
    const cube = new RobustInside({ positions, indices }, 8)
    expect(cube.contains(0.31, 0.47, 0.59)).toBe(true)
    expect(cube.agrees(0.31, 0.47, 0.59)).toBe(true)
    for (const q of [[1.31, 0.47, 0.59], [0.31, -0.2, 0.59], [0.31, 0.47, 1.7]] as const) expect(cube.contains(q[0], q[1], q[2])).toBe(false)
    // 一张横在立方体外的薄片：全部面积在外；一半伸进立方体的：一半 / a sheet outside the cube: all of its area is outside; one reaching half way in: half
    const sheet = (x0: number, x1: number) => ({ positions: Float32Array.from([x0, 0.5, 0.2, x1, 0.5, 0.2, x1, 0.5, 0.8, x0, 0.5, 0.8]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) })
    const r = thinStructuresOutsideSkin({ positions, indices }, [{ id: 'out', name: 'out', tissue: 'fascia', mesh: sheet(1.2, 2.2) }, { id: 'half', name: 'half', tissue: 'fascia', mesh: sheet(0.5, 1.5) }], undefined, 0.02, 0)
    const by = new Map(r.rows.map((x) => [x.id, x]))
    expect(by.get('out')!.outsideCm2 / by.get('out')!.areaCm2).toBeCloseTo(1, 5)
    expect(by.get('half')!.outsideCm2 / by.get('half')!.areaCm2).toBeGreaterThan(0.48)
    expect(by.get('half')!.outsideCm2 / by.get('half')!.areaCm2).toBeLessThan(0.52)
    expect(by.get('out')!.maxMm).toBeGreaterThan(90)
  })

  for (const body of ['male', 'female'] as const) {
    const dir = DIRS[body]
    const present = existsSync(join(dir, 'anatomy.json'))
    const report = present ? JSON.parse(readFileSync(join(dir, 'pipeline-report.json'), 'utf8')) : null
    // 只在装入了开了趾的皮肤时才有这些情形（占位皮肤、连成一块的足趾另当别论） / the cases exist only with an installed skin that has separate toes (a placeholder or a one-block foot is another matter)
    const toes = !!report?.skinPackage?.opened?.grafts?.some((g: { name: string }) => /^toes/i.test(g.name))
    const measureBody = async () => {
      const b = await loadBuiltBody(dir, (p) => p.name === 'Skin' || (!FAT_DEEP_TISSUES.has(p.tissue) && p.system !== 'integumentary'))
      const skinPart = [...b.parts.values()].find((p) => p.name === 'Skin')!
      const skin = b.meshes.get(skinPart.id)!
      const sb = skinPart.bbox
      const crotchY = Math.min(...b.data.parts.filter((p) => /hip bone/i.test(p.name)).map((p) => p.bbox[1]))
      // 区域：前足 = 最低 7 cm、最靠前 9 cm；大腿根 = 中线两侧 9 cm、髋骨最低点上下 12 cm；头（发布的皮肤在口腔处是开的，那里不算）
      // regions: forefoot = lowest 7 cm, most anterior 9 cm; thigh root = within 9 cm of the midline and 12 cm of the lowest point of the hip bones; head (the shipped skin is open at the mouth, so it is left out)
      const region = (x: number, y: number, z: number) => (y < sb[1] + 0.07 && z > sb[5] - 0.09 ? 'forefoot' : Math.abs(x) < 0.09 && Math.abs(y - crotchY) < 0.12 ? 'thighRoot' : y > sb[4] - 0.25 ? 'head' : 'other')
      const parts = [...b.parts.values()].filter((p) => p.id !== skinPart.id && b.meshes.has(p.id)).map((p) => ({ id: p.id, name: p.name, tissue: p.tissue as string, mesh: b.meshes.get(p.id)! }))
      const r: ThinOutside = thinStructuresOutsideSkin(skin, parts, region, 0.002, 0)
      // 三条射线几乎处处一致 / the three rays agree almost everywhere
      expect(r.raysDisagreed / r.samples).toBeLessThan(0.005)
      return { r, by: new Map(r.rows.map((x) => [x.id, x])), ids: new Set(parts.map((p) => p.id)) }
    }
    if (body === 'male') {
      it.skipIf(!present || !toes)('male: the sheets across the web spaces and the other thin parts are back inside the skin (upper bounds)', async () => {
        // 这些上限只在薄结构那一步做过之后才成立 / the bounds hold only once the thin-structure stage has run
        expect(report.thinParts?.applied).toBe(true)
        const { r, by, ids } = await measureBody()
        for (const k of FIXED.male) {
          expect(ids.has(k.id), k.name).toBe(true)
          const row = by.get(k.id)!
          expect(row.name).toBe(k.name)
          expect(row.outsideCm2, `${k.id} ${k.name}`).toBeLessThan(k.maxCm2)
        }
        expect(r.byRegion.forefoot ?? 0).toBeLessThan(MALE_FOREFOOT_MAX_CM2)
        // 头部不算：发布的皮肤在眼和口处是开的，那里的“内外”没有意义（开口之前的闭合皮肤上，头部只有 0.2 cm²）
        // the head is left out: the shipped skin is open at the eyes and the mouth, where inside/outside means nothing (on the closed skin before the openings the head has only 0.2 cm²)
        const beyondHead = r.outsideCm2 - (r.byRegion.head ?? 0)
        expect(beyondHead).toBeLessThan(MALE_TOTAL_MAX_CM2)
        // 构建自己量的数（未简化的部件对发布的闭合皮肤）与这里量的（发布的部件）相近 / the build's own figure (unsimplified parts against the shipped closed skin) is close to the one measured here (shipped parts)
        expect(report.skinPackage.thinOutside.outsideCm2).toBeLessThan(MALE_TOTAL_MAX_CM2)
      }, 180_000)
      continue
    }
    it.skipIf(!present || !toes)('female: the fascia lata at the thigh roots, the sheets across the web spaces and the other thin parts are back inside the skin (upper bounds)', async () => {
      // 这些上限只在薄结构那一步做过之后才成立 / the bounds hold only once the thin-structure stage has run
      expect(report.thinParts?.applied).toBe(true)
      const { r, by, ids } = await measureBody()
      for (const k of FIXED.female) {
        expect(ids.has(k.id), k.name).toBe(true)
        // 露出不到 0 的部件不在 rows 里（minRowCm2 = 0 时都在） / with minRowCm2 = 0 every part has a row
        const row = by.get(k.id)!
        expect(row.name).toBe(k.name)
        expect(row.outsideCm2, `${k.id} ${k.name}`).toBeLessThan(k.maxCm2)
      }
      expect(r.byRegion.forefoot ?? 0).toBeLessThan(FEMALE_FOREFOOT_MAX_CM2)
      expect(r.byRegion.thighRoot ?? 0).toBeLessThan(FEMALE_THIGH_ROOT_MAX_CM2)
      // 头部不算（发布的皮肤在眼和口处是开的） / the head is left out (the shipped skin is open at the eyes and the mouth)
      expect(r.outsideCm2 - (r.byRegion.head ?? 0)).toBeLessThan(FEMALE_TOTAL_MAX_CM2)
      expect(report.skinPackage.thinOutside.outsideCm2).toBeLessThan(FEMALE_TOTAL_MAX_CM2)
    }, 180_000)
  }
})
