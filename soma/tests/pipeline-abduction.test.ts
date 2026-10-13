// 男性上肢外展的验证：针对已生成的 public/anatomy/male（报告中的数值 + 从 GLB 重新量出的几何）。
// 没有生成结果、或构建时用 SOMA_ARM_ABDUCTION=0 关掉了外展时跳过。SOMA_MALE_DIR 可把测试指到另一个输出目录。
// 外展改变了内部结构的指纹：按外展前的骨架拟合的皮肤包不再装入，身体带的是 BodyParts3D 自带的皮肤（见最后一项）。
// Checks of the abduction of the male upper limbs, against the generated public/anatomy/male (numbers
// of the report + geometry measured again from the GLBs). Skipped when there is no output, or when
// the build switched the abduction off with SOMA_ARM_ABDUCTION=0. SOMA_MALE_DIR points the tests at
// another output directory. The abduction changes the fingerprint of the internals: a skin package
// fitted to the skeleton before it is no longer installed, and the body carries the BodyParts3D skin
// (see the last check).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnatomyData, Part } from '../src/anatomy/types.ts'
import { abductionTransform, rotateAboutZ } from '../tools/pipeline/armAbduction.ts'
import type { Mesh } from '../tools/pipeline/geometry.ts'
import { readGlb } from '../tools/pipeline/glb.ts'
import type { LandmarkResult } from '../tools/pipeline/landmarks.ts'
import { limbJointCentres } from '../tools/pipeline/shoulder.ts'

const DIR = process.env.SOMA_MALE_DIR ?? join(import.meta.dirname, '../public/anatomy/male')
const present = existsSync(join(DIR, 'anatomy.json')) && existsSync(join(DIR, 'pipeline-report.json'))

interface Gap { minMm: number; medianMm: number }
interface Bands { wall: number[]; folds: number[] }
interface Transform { rotation: number[]; translationM: number[]; inverse: { rotation: number[]; translationM: number[] } }
interface AbductionReport {
  applied: boolean
  angleDeg: number
  scapula: { verified: boolean; source: string }
  requirement: { minGapMm: number; wallFromBand: string; foldsFromBand: string; foldInsertionsEndAtFraction: number }
  gapBands: string[]
  gapCurve: { curve: { angleDeg: number; left: Bands; right: Bands; worstRequiredMm: number }[]; foldsClearFrom: { angleDeg: number; left: string; right: string }[] }
  sides: Record<'left' | 'right', { headCentreM: number[]; limbBones: number; glenohumeralGap: { before: Gap; after: Gap }; elbowM: { before: number[]; after: number[] }; gapMm: { before: Bands; after: Bands } }>
  transforms: Record<string, Transform>
  field: { largestWeightNearBoundary: number; jacobian: { samples: number; nonPositive: number; median: number } }
  parts: { moved: number; rigid: number; deformed: number; deformedIds: string[]; mapJacobianAtVertices: { samples: number; nonPositive: number; min: number }; thinStructures: { triangles: number; reversedTriangles: number } }
  crossing: { parts: { name: string; tissue: string; volumeChange: number; lengthChange: number; closestToLimbBoneMm: number[]; closestToTrunkBoneMm: number[] }[] }
  attachments: { checked: number; movedOffBoneByMoreThan1Mm: number; largestIncrease: { mm: number } }
  insideBone: { before: number; after: number }
  criterion: { rule: string; whyNotFromAQuarter: string; anatomy: string }
  travelWithLimb: { fromFraction: number; fullFromFraction: number; parts: { id: string; name: string }[]; lagBelowAxilla: { parts: { name: string; tissue: string; verticesBelowAxilla: number; largestLagBelowAxillaMm: number }[] } }
  nerves: { rebuilt: number; perNerve: { name: string; pointsBelowAxilla: number; largestLagBelowAxillaMm: number }[]; inBone: { before: number; afterCleanUp: number }; deepInMuscle: { before: number; after: number } }
  provenance: { scannedBefore: number; scannedAfter: number; relabelledToWarped: number; relabelledByTissue: Record<string, number>; relabelledIds: string[] }
}

const report = (present ? JSON.parse(readFileSync(join(DIR, 'pipeline-report.json'), 'utf8')) : {}) as { armAbduction?: AbductionReport; landmarks?: LandmarkResult[]; landmarksBeforeAbduction?: LandmarkResult[]; skinPackage?: { installed?: boolean; internalsKey: string; fittedTo?: { key: string } | null; reason?: string }; appendages?: { applied: boolean } }
const applied = present && !!report.armAbduction?.applied

describe('abduction kinematics', () => {
  it('turns about the antero-posterior axis through the given centre, and the transform matches the point map', () => {
    const c: [number, number, number] = [0.17, 1.29, 0.1]
    const a = (8 * Math.PI) / 180
    const p = rotateAboutZ([0.2, 1.0, 0.09, ...c], c, a)
    // 中心不动，z 不变，c 下方的点向 +x 移动 / the centre stays, z is kept, a point below c moves towards +x
    expect(p[3]).toBeCloseTo(c[0], 6)
    expect(p[4]).toBeCloseTo(c[1], 6)
    expect(p[2]).toBeCloseTo(0.09, 6)
    expect(p[0]!).toBeGreaterThan(0.2 + 0.03)
    expect(Math.hypot(p[0]! - c[0], p[1]! - c[1])).toBeCloseTo(Math.hypot(0.03, 0.29), 5)
    const t = abductionTransform(c, a)
    for (let k = 0; k < 3; k++) expect(t.rotation[3 * k]! * 0.2 + t.rotation[3 * k + 1]! * 1.0 + t.rotation[3 * k + 2]! * 0.09 + t.translationM[k]!).toBeCloseTo(p[k]!, 5)
  })
})

describe.skipIf(!applied)('male arm abduction (public/anatomy/male)', () => {
  const data = (applied ? JSON.parse(readFileSync(join(DIR, 'anatomy.json'), 'utf8')) : null) as AnatomyData
  const ab = report.armAbduction!
  const part = (name: string): Part => data.parts.find((p) => p.name === name)!
  const sides = () => [ab.sides.left, ab.sides.right]

  // 发布的数据必须装着开口后的皮肤包（指纹对不上时构建只是悄悄留着旧皮肤），外展角是钉住的那个且仍满足间隙要求。
  // The shipped data must carry the opened skin package (on a fingerprint mismatch the build merely keeps the old skin),
  // and the abduction angle is the pinned one, which still meets the gap requirement.
  it('ships the opened skin package, at the pinned abduction angle', () => {
    const r = report as unknown as { skinPackage: { installed: boolean; opened?: unknown; internalsKey: string; fittedTo: { key: string } }; armAbduction: { pinned?: boolean; angleDeg: number; automaticWouldChoose?: number; gapAtPinnedAngleMm: number; gapNeededMm: number; reason: { zh: string; en: string }; requirement: { minGapMm: number } } }
    expect(r.skinPackage.installed).toBe(true)
    expect(r.skinPackage.opened).toBeDefined()
    expect(r.skinPackage.fittedTo.key).toBe(r.skinPackage.internalsKey)
    expect(r.armAbduction.pinned).toBe(true)
    expect(r.armAbduction.angleDeg).toBe(6.5)
    expect(typeof r.armAbduction.automaticWouldChoose).toBe('number')
    expect(r.armAbduction.gapNeededMm).toBe(r.armAbduction.requirement.minGapMm + 1)
    expect(r.armAbduction.gapAtPinnedAngleMm).toBeGreaterThanOrEqual(r.armAbduction.gapNeededMm)
    expect(r.armAbduction.reason.zh.length).toBeGreaterThan(10)
    expect(r.armAbduction.reason.en.length).toBeGreaterThan(10)
  })

  it('abducts both limbs by the same small angle, the smallest that meets the gap requirement', () => {
    expect(ab.angleDeg).toBeGreaterThanOrEqual(5)
    expect(ab.angleDeg).toBeLessThanOrEqual(15)
    // 取角用的曲线：所取的角满足要求，比它小的角都不满足（按 0.5° 细分的那一档已在曲线里）
    // the curve the angle was chosen on: the chosen angle meets the requirement and no smaller one on the curve does
    const need = ab.requirement.minGapMm
    for (const c of ab.gapCurve.curve) {
      if (c.angleDeg < ab.angleDeg - 1e-9) expect(c.worstRequiredMm, `${c.angleDeg}°`).toBeLessThan(need + 1)
      if (Math.abs(c.angleDeg - ab.angleDeg) < 1e-9) expect(c.worstRequiredMm).toBeGreaterThanOrEqual(need + 1)
    }
    expect(ab.gapCurve.curve.some((c) => Math.abs(c.angleDeg - ab.angleDeg) < 1e-9)).toBe(true)
    for (const key of ['arm_L', 'arm_R']) {
      const t = ab.transforms[key]!
      const r = t.rotation
      // 绕 z 轴的纯转动，角度就是报告的角度；左右反向 / a pure rotation about z by the reported angle; opposite on the two sides
      expect(r[8]).toBeCloseTo(1, 6)
      expect((Math.atan2(r[3]!, r[0]!) * 180) / Math.PI).toBeCloseTo(key === 'arm_L' ? ab.angleDeg : -ab.angleDeg, 3)
      const x = [0.2, 1.0, 0.1]
      const y = [0, 1, 2].map((i) => r[3 * i]! * x[0]! + r[3 * i + 1]! * x[1]! + r[3 * i + 2]! * x[2]! + t.translationM[i]!)
      const back = [0, 1, 2].map((i) => t.inverse.rotation[3 * i]! * y[0]! + t.inverse.rotation[3 * i + 1]! * y[1]! + t.inverse.rotation[3 * i + 2]! * y[2]! + t.inverse.translationM[i]!)
      for (let i = 0; i < 3; i++) expect(back[i]!).toBeCloseTo(x[i]!, 5)
    }
    // 肩胛骨不动的依据未经核对，报告里如实标注 / the basis for leaving the scapula alone was not checked against the source, and the report says so
    expect(ab.scapula.verified).toBe(false)
    expect(ab.scapula.source.length).toBeGreaterThan(20)
  })

  it('opens the axilla: the limb clears the chest wall and, below their insertions, the fold muscles', () => {
    const b = ab.gapBands
    const wallFrom = b.indexOf(ab.requirement.wallFromBand)
    const foldsFrom = b.indexOf(ab.requirement.foldsFromBand)
    expect(wallFrom).toBeGreaterThan(0)
    expect(foldsFrom).toBeGreaterThan(wallFrom)
    for (const s of sides()) {
      // 最终几何上到三角形的精确距离 / exact distances to the triangles on the final geometry
      for (let k = wallFrom; k < b.length; k++) expect(s.gapMm.after.wall[k]!, `wall ${b[k]}`).toBeGreaterThanOrEqual(ab.requirement.minGapMm)
      for (let k = foldsFrom; k < b.length; k++) expect(s.gapMm.after.folds[k]!, `folds ${b[k]}`).toBeGreaterThanOrEqual(ab.requirement.minGapMm)
      // 外展前在这一档是不满足的 / before the abduction that band failed
      expect(s.gapMm.before.folds[foldsFrom]!).toBeLessThan(ab.requirement.minGapMm)
      // 没有哪一档比外展前更窄（容许采样误差 0.5 mm） / no band is narrower than before (0.5 mm allowed for sampling)
      for (let k = wallFrom; k < b.length; k++) expect(s.gapMm.after.folds[k]!, `folds ${b[k]}`).toBeGreaterThanOrEqual(s.gapMm.before.folds[k]! - 0.5)
    }
  })

  it('keeps the glenohumeral joint congruent and moves 30 bones per limb', () => {
    for (const s of sides()) {
      expect(s.limbBones).toBe(30)
      const g = s.glenohumeralGap
      expect(Math.abs(g.after.medianMm - g.before.medianMm)).toBeLessThan(0.5)
      expect(g.after.minMm).toBeGreaterThanOrEqual(g.before.minMm - 0.2)
      expect(g.after.minMm).toBeGreaterThan(0)
      // 肘向外移 / the elbow moves outwards
      expect(Math.abs(s.elbowM.after[0]!) - Math.abs(s.elbowM.before[0]!)).toBeGreaterThan(0.02)
      expect(s.elbowM.after[2]!).toBeCloseTo(s.elbowM.before[2]!, 4)
    }
  })

  it('does not fold space, keeps attachments on their bones and soft parts out of bone', () => {
    expect(ab.field.jacobian.samples).toBeGreaterThan(50_000)
    expect(ab.field.jacobian.nonPositive / ab.field.jacobian.samples).toBeLessThan(0.001)
    expect(ab.field.jacobian.median).toBeCloseTo(1, 2)
    expect(ab.field.largestWeightNearBoundary).toBe(0)
    expect(ab.parts.mapJacobianAtVertices.samples).toBeGreaterThan(5000)
    expect(ab.parts.mapJacobianAtVertices.nonPositive).toBe(0)
    expect(ab.parts.mapJacobianAtVertices.min).toBeGreaterThan(0.5)
    expect(ab.parts.thinStructures.reversedTriangles / ab.parts.thinStructures.triangles).toBeLessThan(0.001)
    expect(ab.attachments.checked).toBeGreaterThan(60)
    expect(ab.attachments.movedOffBoneByMoreThan1Mm).toBe(0)
    expect(ab.attachments.largestIncrease.mm).toBeLessThan(1)
    expect(ab.insideBone.after).toBeLessThanOrEqual(ab.insideBone.before + 0.002)
    expect(ab.nerves.inBone.afterCleanUp).toBeLessThanOrEqual(ab.nerves.inBone.before + 0.001)
    expect(ab.nerves.deepInMuscle.after).toBeLessThanOrEqual(ab.nerves.deepInMuscle.before + 0.01)
  })

  it('deforms the muscles that cross the joint between origin and insertion, within a few percent', () => {
    const names = ab.crossing.parts.map((c) => c.name).join('; ')
    for (const n of ['deltoid', 'pectoralis major', 'latissimus dorsi', 'teres major', 'teres minor', 'supraspinatus', 'infraspinatus', 'subscapularis', 'coracobrachialis', 'Long head of left biceps brachii', 'Long head of left triceps brachii']) expect(names).toContain(n)
    for (const c of ab.crossing.parts.filter((x) => x.tissue === 'muscle')) {
      expect(Math.abs(c.volumeChange), c.name).toBeLessThan(0.08)
      expect(Math.abs(c.lengthChange), c.name).toBeLessThan(0.08)
      // 两端都还在骨上 / both ends still on their bones
      expect(c.closestToLimbBoneMm[1]!, c.name).toBeLessThan(c.closestToLimbBoneMm[0]! + 1)
      expect(c.closestToTrunkBoneMm[1]!, c.name).toBeLessThan(c.closestToTrunkBoneMm[0]! + 1)
    }
    // 内收肌被拉长，三角肌肩峰部缩短 / the adductors lengthen, the acromial part of deltoid shortens
    const of = (n: string) => ab.crossing.parts.find((c) => c.name === n)!
    expect(of('Left latissimus dorsi').lengthChange).toBeGreaterThan(0)
    expect(of('Left teres major').lengthChange).toBeGreaterThan(0)
    expect(of('Acromial part of left deltoid').lengthChange).toBeLessThan(0)
  })

  it('ships the geometry the report describes (the elbow measured again from the GLB)', async () => {
    const byId = new Map(data.parts.map((p) => [p.id, p]))
    const doc = await readGlb(join(DIR, 'skeletal.glb'))
    const meshes = new Map<string, Mesh>()
    for (const node of doc.getRoot().listNodes()) {
      const p = byId.get(node.getName())
      if (!p || !/^(Left|Right) humerus$/.test(p.name)) continue
      const prim = node.getMesh()!.listPrimitives()[0]!
      const pos = prim.getAttribute('POSITION')!
      const m = node.getWorldMatrix()
      const positions = new Float32Array(pos.getCount() * 3)
      const v = [0, 0, 0]
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v)
        for (let k = 0; k < 3; k++) positions[3 * i + k] = v[k]! * m[5 * k]! + m[12 + k]!
      }
      meshes.set(p.name, { positions, indices: Uint32Array.from(prim.getIndices()!.getArray()!) })
    }
    for (const [S, s, lat, side] of [['Left', 'L', 1, ab.sides.left], ['Right', 'R', -1, ab.sides.right]] as const) {
      // 肘的定义取“最低的 8%”，转过之后取到的不是同一片：所以先用逆变换放回去再量，再用正变换带回来
      // the elbow is defined on "the lowest 8 %", which is another slab after the turn: the bone is put back with the inverse, measured, and carried forward again
      const t = ab.transforms[`arm_${s}`]!
      const apply = (q: { rotation: number[]; translationM: number[] }, v: ArrayLike<number>): Float32Array => {
        const o = new Float32Array(v.length)
        for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) o[i + k] = q.rotation[3 * k]! * v[i]! + q.rotation[3 * k + 1]! * v[i + 1]! + q.rotation[3 * k + 2]! * v[i + 2]! + q.translationM[k]!
        return o
      }
      const h = meshes.get(`${S} humerus`)!
      const e0 = limbJointCentres(lat, { humerus: { positions: apply(t.inverse, h.positions), indices: h.indices } }).elbow!
      const e1 = apply(t, e0)
      expect(Math.hypot(e0[0] - side.elbowM.before[0]!, e0[1] - side.elbowM.before[1]!, e0[2] - side.elbowM.before[2]!) * 1000).toBeLessThan(2)
      expect(Math.hypot(e1[0]! - side.elbowM.after[0]!, e1[1]! - side.elbowM.after[1]!, e1[2]! - side.elbowM.after[2]!) * 1000).toBeLessThan(2)
    }
  }, 120_000)

  it('passes all 18 nerve landmark checks before and after', () => {
    for (const list of [report.landmarksBeforeAbduction!, report.landmarks!]) {
      expect(list.length).toBe(18)
      expect(list.filter((r) => !r.pass).map((r) => `${r.side} ${r.id}: ${r.measured}`)).toEqual([])
    }
    // 桡神经沟里的主干随肱骨整体转动：这项检查按肱骨干自己的轴线取切片，外展前后的读数相差不到 0.3 mm
    // the trunk in the radial groove turns whole with the humerus: the check takes its slabs along the shaft's own axis, and its readings before and after the abduction differ by less than 0.3 mm
    for (const side of ['L', 'R'] as const) {
      const a = report.landmarksBeforeAbduction!.find((r) => r.id === 'radial-humerus' && r.side === side)!.values
      const b = report.landmarks!.find((r) => r.id === 'radial-humerus' && r.side === side)!.values
      for (const k of ['toBone', 'posterior', 'medialProximal', 'lateralDistal'] as const) expect(Math.abs(a[k]! - b[k]!), `${side} ${k}`).toBeLessThan(0.3)
    }
  })

  it('carries the nerves and vessels of the arm rigidly with the limb below the axilla', () => {
    // 腋窝下缘以远（腋襞肌止点远端再往下 5%）、离上肢骨 5 cm 以内：正中神经、尺神经、桡神经、前臂内侧皮神经，
    // 以及与它们伴行的肱动脉、肱静脉、贵要静脉、头静脉，离“随上肢整体转动”的位置不到 0.05 mm；过渡只在腋窝之内。
    // （胸长神经、胸背神经、腹部和锁胸筋膜属于躯干，本来就不该随上肢走，不在此列。）
    // Below the lower border of the axilla (5% of the humerus beyond the distal end of the fold muscles'
    // insertions) and within 5 cm of a limb bone, the median, ulnar and radial nerves, the medial
    // antebrachial cutaneous nerve and the vessels that run with them (brachial artery and veins, basilic
    // and cephalic veins) are within 0.05 mm of where the rigid turn of the limb puts them; the blend is
    // confined to the axilla. (The long thoracic and thoracodorsal nerves and the abdominal and
    // clavipectoral fasciae belong to the trunk, are not meant to go with the limb and are not looked at.)
    const t = ab.travelWithLimb
    expect(t.fullFromFraction).toBeLessThanOrEqual(0.4)
    expect(t.fromFraction).toBeGreaterThanOrEqual(0.2)
    const rows = ab.nerves.perNerve
    expect(rows.length).toBe(ab.nerves.rebuilt)
    for (const S of ['Left', 'Right']) {
      for (const n of [`${S} radial nerve`, `${S} median nerve`, `${S} ulnar nerve`, `${S} medial antebrachial cutaneous nerve`]) {
        const r = rows.find((x) => x.name === n)!
        expect(r.pointsBelowAxilla, n).toBeGreaterThan(20)
        expect(r.largestLagBelowAxillaMm, n).toBeLessThan(0.05)
      }
      for (const n of [`${S} brachial artery`, `${S} basilic vein`, `${S} cephalic vein`, `${S} medial brachial vein`]) {
        const r = t.lagBelowAxilla.parts.find((x) => x.name === n)!
        expect(r, n).toBeDefined()
        expect(r.verticesBelowAxilla, n).toBeGreaterThan(100)
        expect(r.largestLagBelowAxillaMm, n).toBeLessThan(0.05)
      }
    }
    // 其余在腋窝以下仍不随上肢走的，只有躯干的筋膜 / what else does not go with the limb below the axilla is fascia of the trunk only
    for (const r of t.lagBelowAxilla.parts.filter((x) => x.largestLagBelowAxillaMm >= 0.05)) expect(r.name).toMatch(/abdominal fascia|clavipectoral fascia|pectoral fascia|axillary fascia|thoracic|thoracodorsal|subscapular|circumflex scapular/i)
  })

  it('records the criterion and why the axilla cannot open from a quarter of the humerus', () => {
    expect(ab.criterion.rule).toContain('fold muscles')
    expect(ab.criterion.whyNotFromAQuarter).toContain('hinge')
    expect(ab.criterion.anatomy.length).toBeGreaterThan(60)
    // 曲线本身说明这一点：襞肌离臂 ≥ 12 mm 的起始档在头几度之后不再上移 / the curve itself shows it: the band from which the folds are clear stops rising after the first degrees
    const cf = ab.gapCurve.foldsClearFrom
    const at = (deg: number) => cf.find((c) => c.angleDeg === deg)!
    expect(at(15).left).toBe(at(Math.ceil(ab.angleDeg)).left)
    expect(at(0).left).not.toBe(at(15).left)
    const c = data.cautions!.map((x) => x.en).join(' ')
    expect(c).toContain('modelling choice')
    expect(c).toContain('like a hinge')
  })

  it('relabels only what it deformed: the free limb stays scanned', () => {
    const pv = ab.provenance
    expect(pv.relabelledToWarped).toBe(pv.relabelledIds.length)
    // 外展形变的 BodyParts3D 部件（跨关节的肌、腋部和臂近段的血管、旧皮肤）在肩带校正时就已被形变并改标过，
    // 所以这一步新改标的可以是零个；要求的是：凡被它形变的 BodyParts3D 部件都标着 warped（旧皮肤被皮肤包换掉时除外）。
    // The BodyParts3D parts the abduction deforms (the crossing muscles, the vessels of the axilla and the
    // proximal arm, the old skin) had already been deformed and relabelled by the shoulder correction, so
    // this step may relabel none anew; what is required is that every BodyParts3D part it deformed is
    // labelled warped (the old skin excepted when a skin package has replaced it).
    expect(pv.relabelledToWarped).toBeLessThan(80)
    expect(ab.parts.deformedIds.length).toBe(ab.parts.deformed)
    for (const id of ab.parts.deformedIds.filter((x) => x.startsWith('FJ'))) {
      const p = data.parts.find((x) => x.id === id)!
      if (p.name === 'Skin' && report.skinPackage?.installed) continue
      expect(p.provenance, `${id} ${p.name}`).toBe('warped')
    }
    for (const id of pv.relabelledIds) expect(ab.parts.deformedIds, id).toContain(id)
    expect(data.parts.filter((p) => p.tissue === 'bone' && p.provenance !== 'scanned')).toEqual([])
    for (const S of ['Left', 'Right']) {
      const s = S.toLowerCase()
      for (const n of [`${S} humerus`, `${S} radius`, `${S} ulna`, `${S} brachialis`, `${S} brachioradialis`, `Lateral head of ${s} triceps brachii`, `Medial head of ${s} triceps brachii`, `${S} radial artery`, `${S} ulnar artery`]) expect(part(n)?.provenance, n).toBe('scanned')
      for (const n of [`Long head of ${s} triceps brachii`, `Long head of ${s} biceps brachii`, `${S} coracobrachialis`, `${S} teres major`, `${S} brachial artery`]) expect(part(n)?.provenance, n).toBe('warped')
    }
  })

  it('falls back cleanly when the skin package was fitted to the internals before the abduction', () => {
    const sp = report.skinPackage!
    expect(sp.internalsKey).toMatch(/^[0-9a-f]{16}$/)
    if (sp.installed) {
      // 已有按外展后的骨架拟合的皮肤包 / a skin package fitted to the abducted skeleton exists
      expect(sp.fittedTo!.key).toBe(sp.internalsKey)
      expect(report.appendages!.applied).toBe(true)
      return
    }
    if (sp.fittedTo) expect(sp.fittedTo.key).not.toBe(sp.internalsKey)
    expect(report.appendages!.applied).toBe(false)
    // 身体带的是 BodyParts3D 自带的皮肤：仍是 BodyParts3D 的部件，没有来源字段，因被形变而标为 warped
    // the body carries the BodyParts3D skin: still a BodyParts3D part, without a source field, labelled warped for having been deformed
    const skin = part('Skin')
    expect(skin.id).toBe('FJ2810')
    expect(skin.provenance).toBe('warped')
    expect(skin.source).toBeUndefined()
    expect(data.sources.some((x) => /Momentum Human Rig/.test(x.name))).toBe(false)
    // 皮下脂肪仍然是按这层皮肤推导出来的 / the subcutaneous fat is still derived, from this skin
    expect(data.parts.filter((p) => /^SOMA_fat_/.test(p.id)).length).toBeGreaterThanOrEqual(5)
    const c = data.cautions!.map((x) => x.en).join(' ')
    expect(c).toContain('abducted')
    expect(c).not.toContain('parametric body surface')
  })
})
