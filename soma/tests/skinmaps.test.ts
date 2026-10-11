// 检验已生成的皮肤分区图（public/anatomy/<body>/skinmaps.json + .bin）。未生成时跳过：先运行 `bun tools/skinmaps/run.ts male|female`。
// Validates the generated skin maps. Skipped when they have not been generated: run `bun tools/skinmaps/run.ts male|female` first.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { BodyId, SkinMaps } from '../src/anatomy/types.ts'
import { generate, makeReport, type Generated } from '../tools/skinmaps/generate.ts'
import { segmentKeys } from '../tools/skinmaps/verify.ts'

const dirOf = (body: string) => join(import.meta.dirname, '../public/anatomy', body)
const has = (body: string) => existsSync(join(dirOf(body), 'skinmaps.json')) && existsSync(join(dirOf(body), 'skinmaps.bin'))

const INGUINAL = '2.5 cm below the midpoint of the inguinal ligament'
const XIPHOID = 'Over the xiphoid process (dermatome with the largest share of the skin in front of the process)'

interface Known {
  /** 允许不通过的经典检查点（按 checks 中的顺序）/ Classic checkpoints allowed to fail (in the order of `checks`). */
  failedChecks: string[]
  /** 剑突前方皮肤中 T6 须占多数的侧别 / Sides on which T6 must hold most of the skin over the xiphoid. */
  xiphoidSides: ('L' | 'R')[]
  splitDermatomes: RegExp
  asymmetricDermatomes: RegExp
  splitTerritories: RegExp
  disagreeingTerritories: string[]
  /** 面积可以小于 20 cm² 的分布区 / Territories allowed to be smaller than 20 cm². */
  tinyTerritories: string[]
  /** 肋间臂神经分布区镜像一致率的下限 / Lower bound of the intercostobrachial territory's mirror agreement. */
  intercostobrachialMirror: number
}

// 已知并已上报的例外；出现新的例外即失败。两个人体共有的原因写在这里，各自特有的写在各自的表里。
// Known, reported exceptions; anything new fails the test. Reasons common to both bodies are given
// here, those particular to one body in its own table.
//
// failedChecks: ISNCSCI 把 T12 的关键点放在腹股沟韧带中点，“腹股沟属 L1”的教学说法所指的位置在其下方约 2.5 cm，
//   恰在 T12/L1 分界上。
//   ISNCSCI puts the T12 key point on the mid-inguinal point; the "inguinal = L1" teaching point lies
//   about 2.5 cm lower, right on the T12/L1 boundary.
// splitDermatomes: 躯干带在腋窝以上（躯干与上臂连成一体处）前后分开；背部近中线处各带窄于网格分辨率。
//   V3 的颏部与耳前两段各有种子。
//   Trunk bands are in a front and a back piece above the axilla, where trunk and arm are one mass;
//   beside the spine the bands are narrower than the mesh resolves. V3 has separate seeds for the
//   chin and in front of the ear.
// disagreeingTerritories（落在教科书节段皮节内的面积不到一半）:
//   - 髂腹下神经两支：ISNCSCI 把 T12 放在腹股沟韧带上，下腹部在皮节图上属 T12 而非 L1；外侧皮支分布区跨 L1/L2。
//   - 臂后皮神经：臂后面正中即上肢背侧轴线，C5 与 T1/T2 在此相接，皮节图上臂后没有 C6–C8。
//   - 臂内侧皮神经：Gray 正文为 C8、T1，但臂内侧上部在各家皮节图上属 T2（男性现为 0.52，在界线上）。
//   (less than half the area in the dermatomes of the textbook segments):
//   - both iliohypogastric branches: ISNCSCI puts T12 on the inguinal ligament, so the lower abdomen
//     is T12, not L1, in the dermatome map; the lateral branch's territory straddles L1/L2.
//   - posterior brachial cutaneous: the back of the arm is the dorsal axial line, where C5 meets
//     T1/T2; the dermatome maps have no C6-C8 on the back of the arm.
//   - medial brachial cutaneous: Gray's text gives C8, T1, but the upper medial arm is T2 in the
//     dermatome maps (the male is at 0.52 now, on the line).
const KNOWN: Record<BodyId, Known> = {
  male: {
    failedChecks: [INGUINAL],
    xiphoidSides: ['L', 'R'],
    splitDermatomes: /^(T([2-9]|10|11)|V3)$/,
    // T3–T6：上背部和胸部的窄带（T2、T3 在背部只相距 1.4 cm）在网格分辨率下左右互有出入。
    // T9、T10：腹前壁的网格边长达 6 cm 以上，而两带在锁骨中线上只相距约 3 cm（下面的测试里量给你看）；
    //   两侧的种子线对称（相差不到 5 mm），不对称出在每个顶点代表的面积太大。
    // T3-T6: the narrow upper-back and chest bands (T2 and T3 are 1.4 cm apart on the back) trade
    //   area between the sides at mesh resolution.
    // T9, T10: the mesh of the anterior abdominal wall has edges of 6 cm and more while the two bands
    //   are about 3 cm apart at the midclavicular line (measured in a test below); the seed lines of
    //   the two sides are symmetric to within 5 mm, the asymmetry is that of vertices standing for too much area.
    asymmetricDermatomes: /^(T[3-6]|T9|T10)$/,
    splitTerritories: /^(obturator|pudendal)$/,
    disagreeingTerritories: ['iliohypogastricLateral', 'iliohypogastricAnterior', 'posteriorBrachial', 'medialBrachial'],
    tinyTerritories: [],
    intercostobrachialMirror: 0.5,
  },
  female: {
    // 剑突（右侧）：她的第 5、6 肋间神经（由男性模型变形而来）两侧高度不同，右侧 T5/T6 分界落在剑突下方；
    // 且她的剑突骨骼整体偏左约 1.2 cm。左侧为 T6。
    // Xiphoid (right side): her 5th and 6th intercostal nerves (warped from the male model) differ in
    // height between the sides, and on the right the T5/T6 boundary falls below the xiphoid; her
    // xiphoid bone also lies about 1.2 cm to the left. The left side is T6.
    failedChecks: [XIPHOID, INGUINAL],
    xiphoidSides: ['L'],
    // S3：她的皮肤上会阴是两股之间一条窄缝，比坐骨结节低约 5 cm；S4–5 的肛周圆盘和臀裂把缝整个占住，
    // S3 的会阴/外阴部分与臀部部分因此不相连。
    // S3: on her skin the perineum is a narrow seam between the thighs about 5 cm below the ischial
    // tuberosities; the perianal disc and natal cleft of S4-5 take the whole width of the seam, so the
    // perineal/genital part of S3 is not joined to its buttock part.
    splitDermatomes: /^(T([2-9]|10|11)|V3|S3)$/,
    // 胸腹部的带沿她变形后的肋间神经，神经两侧不完全对称。
    // The thoracic and abdominal bands follow her warped intercostal nerves, which are not quite symmetric.
    asymmetricDermatomes: /^(T([3-9]|10))$/,
    // 髂腹下神经外侧皮支、股外侧皮神经、肋下神经：她的这些神经（变形后）有几条分支各自贴近皮肤，
    // 中间被邻近神经的分布区隔开。
    // Lateral branch of iliohypogastric, lateral femoral cutaneous, subcostal: several branches of
    // these (warped) nerves come close to her skin separately, with a neighbour's territory between.
    splitTerritories: /^(obturator|pudendal|iliohypogastricLateral|lateralFemoral|subcostal)$/,
    // 除两个人体共有的以外：
    //  - 髂腹股沟神经：终末段落在耻骨上方，皮节图上该处属 T12（与髂腹下神经前皮支同理）。
    //  - 生殖股神经生殖支：见 tinyTerritories，区内没有皮肤。
    //  - 臂后皮神经在她身上只有 0.08：她的这条神经（变形后）的体表投影落在臂后内侧，即背侧轴线的 T1/T2 一侧。
    // Besides those common to both bodies:
    //  - ilioinguinal: its terminal stretch lies above the pubis, which is T12 in the dermatome map
    //    (same reason as the anterior branch of the iliohypogastric).
    //  - genital branch of genitofemoral: see tinyTerritories, it has no skin.
    //  - posterior brachial is only 0.08 on her: the skin projection of her (warped) nerve lies
    //    posteromedially, on the T1/T2 side of the dorsal axial line.
    disagreeingTerritories: ['iliohypogastricLateral', 'iliohypogastricAnterior', 'ilioinguinal', 'genitofemoralGenital', 'posteriorBrachial', 'medialBrachial'],
    // 生殖股神经生殖支：耻骨结节下方的终末段只落在两三个皮肤顶点上（她的皮肤上没有做出大阴唇），
    // 不足 6 cm² 的小块按规则并入邻区。Gray 对此支的描述也只是“少数细支”。
    // Genital branch of genitofemoral: its terminal stretch below the pubic tubercle lands on two or
    // three skin vertices (her skin has no modelled labium majus), and a patch under 6 cm² is
    // absorbed by its neighbours by rule. Gray describes this branch as "a few filaments".
    tinyTerritories: ['genitofemoralGenital'],
    // 她的右腋窝做得不好（肱骨 25–40% 处上臂皮肤插进躯干皮肤），两侧的肋间臂神经分布区不对称。
    // Her right axilla is poor (arm skin runs into trunk skin at 25-40% of the humerus), so the
    // intercostobrachial territories of the two sides do not mirror each other.
    intercostobrachialMirror: 0,
  },
}

for (const body of ['male', 'female'] as BodyId[]) {
  const known = KNOWN[body]
  describe.skipIf(!has(body))(`skin maps (public/anatomy/${body})`, () => {
    let g: Generated
    let maps: SkinMaps
    let bin: Uint8Array
    let report: ReturnType<typeof makeReport>
    beforeAll(async () => {
      g = await generate(body)
      maps = JSON.parse(readFileSync(join(dirOf(body), 'skinmaps.json'), 'utf8')) as SkinMaps
      bin = new Uint8Array(readFileSync(join(dirOf(body), 'skinmaps.bin')))
      const n = maps.vertexCount
      report = makeReport(g.ctx, bin.subarray(0, n), bin.subarray(n, 2 * n))
    }, 180_000)

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

    it('assigns every skin vertex; an inner wall copies the outer wall', () => {
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

    it('puts the thoracic key points of the two sides at the same height', () => {
      // 回归：关键点原先吸附到神经径向投影的皮肤顶点上，在粗网格上左右相差可达 1.5 cm。
      // 男性的神经两侧对称，应在 6 mm 以内；女性的神经由男性变形而来，两侧相差更大，放宽到 2 cm。
      // Regression: the key points used to snap to skin vertices of the nerve's radial projection and
      // differed by up to 1.5 cm between the sides on a coarse mesh. The male's nerves are symmetric
      // and should agree within 6 mm; the female's are warped from the male's and differ more: 2 cm.
      const tol = body === 'male' ? 0.006 : 0.02
      for (let n = 3; n <= 11; n++) {
        const l = g.ctx.lm.surfacePoint(`K_T${n}`, 'L')[1], r = g.ctx.lm.surfacePoint(`K_T${n}`, 'R')[1]
        expect(Math.abs(l - r), `T${n}`).toBeLessThan(tol)
      }
    })

    it('passes the classic checkpoints from independent sources', () => {
      const failed = [...new Set(report.dermatome.checks.filter((c) => !c.ok).map((c) => c.name))]
      expect(failed).toEqual(known.failedChecks)
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
      for (const c of report.dermatome.checks.filter((c) => c.name.startsWith('Over the xiphoid') && known.xiphoidSides.includes(c.side))) expect(c.shares!.T6, c.side).toBeGreaterThan(0.65)
    })

    it('is roughly symmetric and contiguous, with only the known exceptions', () => {
      for (const a of report.dermatome.areas) {
        expect(a.L + a.R, a.key).toBeGreaterThan(50)
        if (a.flagged) expect(a.key).toMatch(known.asymmetricDermatomes)
      }
      // 三叉神经三支：面部网格细，两侧应当很对称 / The trigeminal divisions: the face mesh is fine and the sides should agree well.
      for (const a of report.dermatome.areas.filter((a) => /^V[123]$/.test(a.key))) {
        expect(a.ratio!, a.key).toBeGreaterThan(0.85)
        expect(a.ratio!, a.key).toBeLessThan(1.18)
        expect(a.mirror!, a.key).toBeGreaterThan(0.85)
      }
      for (const p of report.dermatome.pieces) expect(p.region).toMatch(known.splitDermatomes)
      for (const p of report.cutaneous.pieces) expect(p.region).toMatch(known.splitTerritories)
      for (const a of report.cutaneous.areas) if (!known.tinyTerritories.includes(a.key)) expect(a.L + a.R, a.key).toBeGreaterThan(20)
      expect(report.dermatome.speckle.isolated).toBeLessThanOrEqual(2)
      expect(report.cutaneous.speckle.isolated).toBeLessThanOrEqual(2)
      expect(report.dermatome.speckle.outvotedFraction).toBeLessThan(0.03)
      expect(report.cutaneous.speckle.outvotedFraction).toBeLessThan(0.03)
    })

    it.skipIf(body !== 'male')('has an abdominal wall mesh coarser than the T9/T10 bands are wide (why those two may be asymmetric)', () => {
      const { skin, lm } = g.ctx
      const y9 = lm.surfacePoint('K_T9', 'L')[1], y10 = lm.surfacePoint('K_T10', 'L')[1], y8 = lm.surfacePoint('K_T8', 'L')[1], y11 = lm.surfacePoint('K_T11', 'L')[1]
      const frontZ = lm.point('core', 'L')[2] + 0.03
      let longest = 0
      for (let i = 0; i < skin.n; i++) {
        const y = skin.positions[i * 3 + 1]!
        if (y > y8 || y < y11 || skin.positions[i * 3 + 2]! < frontZ || Math.abs(skin.positions[i * 3]! - skin.midX) > 0.14) continue
        for (let k = skin.adjStart[i]!; k < skin.adjStart[i + 1]!; k++) longest = Math.max(longest, skin.adjLen[k]!)
      }
      expect(y9 - y10).toBeLessThan(0.04)
      expect(longest).toBeGreaterThan(y9 - y10)
    })

    it('has nerve territories lying in the dermatomes of their textbook root values', () => {
      const rows = new Map(report.cutaneous.composition.map((c) => [c.key, c]))
      const flagged = report.cutaneous.composition.filter((c) => c.flagged).map((c) => c.key)
      for (const k of flagged) expect(known.disagreeingTerritories).toContain(k)
      expect(rows.get('lateralAntebrachial')!.inExpected).toBeGreaterThan(0.9)
      expect(rows.get('saphenous')!.inExpected).toBeGreaterThan(0.55)
      expect(rows.get('sural')!.inExpected).toBeGreaterThan(0.9)
      expect(rows.get('lateralFemoral')!.inExpected).toBeGreaterThan(0.75)
      expect(rows.get('median')!.inExpected).toBeGreaterThan(0.9)
      expect(rows.get('ulnar')!.inExpected).toBeGreaterThan(0.75)
      // 有腋窝的皮肤上，肋间臂神经分布区应落在 T2 / On a skin with an axilla the intercostobrachial territory lies in T2.
      expect(rows.get('intercostobrachial')!.inExpected).toBeGreaterThan(0.8)
      expect(report.cutaneous.areas.find((a) => a.key === 'intercostobrachial')!.mirror ?? 0).toBeGreaterThanOrEqual(known.intercostobrachialMirror)
      expect(segmentKeys('S5')).toEqual(['S4-5'])
    })

    it('writes innervation tables that point at real parts', () => {
      const table = JSON.parse(readFileSync(join(import.meta.dirname, `../data/curated/skinmaps/innervation.${body}.json`), 'utf8')) as Generated['tables']
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
}
