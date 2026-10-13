// 体形重塑（shape.ts）的校验：位移场求解器的单元测试，以及对 pipeline-report.json 和输出 GLB 的数值检查。
// 构建时没有用到目标包（data/raw/bodyshape/out/female-target）时，后者整体跳过。
// Checks of the body-shape stage (shape.ts): unit tests of the stage on a synthetic limb, and numeric
// checks on pipeline-report.json and the written GLBs. The latter are skipped as a whole when the
// build did not use a target package (data/raw/bodyshape/out/female-target).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnatomyData } from '../src/anatomy/types.ts'
import { loadBuiltBody } from '../tools/pipeline/body.ts'
import { EXTREMITY_LEAVE_MM, EXTREMITY_TOLERANCE_MM, matchTarget, SKELETON_TOLERANCE_MM, stageV2InternalsKey } from '../tools/pipeline/femaleShape.ts'
import { SKELETON_031C_BOXES_MM, SKELETON_031C_KEY } from '../tools/pipeline/femaleSkeleton031c.ts'
import type { Mesh } from '../tools/pipeline/geometry.ts'
import { signedVolume } from '../tools/pipeline/meshRepair.ts'
import { loadShapeTarget, outsideShare, regionOfBone, reshapeIntoEnvelope, type ShapePart, type ShapeRole } from '../tools/pipeline/shape.ts'

const ROOT = join(import.meta.dirname, '..')
// SOMA_FEMALE_DIR：改为校验另一个目录里的构建（管线的 --out） / SOMA_FEMALE_DIR: validate a build in another directory instead (the pipeline's --out)
const DIR = process.env.SOMA_FEMALE_DIR ?? join(ROOT, 'public/anatomy/female')
const present = existsSync(join(DIR, 'anatomy.json')) && existsSync(join(DIR, 'pipeline-report.json'))
const report = (present ? JSON.parse(readFileSync(join(DIR, 'pipeline-report.json'), 'utf8')) : {}) as Record<string, any>
const shape = report.bodyShape as Record<string, any> | undefined
const applied = !!shape?.applied
// 口周肌随唇搬运后体积变化的上限。平移场不改变厚度；沿前后方向走行的肌（颊肌、笑肌）一端随唇前移约 8 mm、另一端留在骨上，
// 长度增加，体积随之增加约 20 %。小于 0.05 ml 的薄片（提口角肌等）网格太粗，体积不作判断。
// Bound on the volume change of a perioral muscle carried with the lips. The translation field does not change
// thickness; a muscle that runs front to back (buccinator, risorius) has one end carried about 8 mm forwards with the
// lip and the other left on bone, so it lengthens and gains about 20 % in volume. Slivers under 0.05 ml (levator
// anguli oris and the like) are too coarse a mesh for their volume to be judged.
const PERIORAL_VOLUME_TOLERANCE = 0.25

/** 沿 Y 轴的闭合圆柱（两端封口），半径 r，偏心 (cx, cz) / a closed cylinder along Y (capped), radius r, offset (cx, cz) */
function cylinder(r: number, y0: number, y1: number, cx = 0, cz = 0, seg = 48, rings = 40): Mesh {
  const pos: number[] = []
  const idx: number[] = []
  for (let j = 0; j <= rings; j++) for (let i = 0; i < seg; i++) {
    const a = (2 * Math.PI * i) / seg
    pos.push(cx + r * Math.cos(a), y0 + ((y1 - y0) * j) / rings, cz + r * Math.sin(a))
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
    const a = j * seg + i
    const b = j * seg + ((i + 1) % seg)
    idx.push(a, a + seg, b, b, a + seg, b + seg)
  }
  const bottom = pos.length / 3
  pos.push(cx, y0, cz, cx, y1, cz)
  for (let i = 0; i < seg; i++) {
    idx.push(bottom, i, (i + 1) % seg)
    idx.push(bottom + 1, rings * seg + ((i + 1) % seg), rings * seg + i)
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

describe('body-shape stage on a synthetic limb (shape.ts)', () => {
  it('assigns bones to regions, the cuneiform cartilage to the neck and the cuneiform bones to the foot', () => {
    expect(regionOfBone('Left cuneiform cartilage')).toBe('neck')
    expect(regionOfBone('Left medial cuneiform bone')).toBe('foot')
    expect(regionOfBone('Right radius')).toBe('forearm')
    expect(regionOfBone('Left articular cartilage of head of femur')).toBe('pelvis')
    expect(regionOfBone('Left femur')).toBe('thigh')
    expect(regionOfBone('Fifth lumbar vertebra')).toBe('abdomen')
    expect(regionOfBone('Frontal bone')).toBe('head')
  })

  it('shifts an off-centre muscle round its bone into the envelope, without moving the bone or folding', () => {
    // 骨在包络正中；肌向 +X 偏了 10 mm：一侧露在包络外，另一侧还有空余
    // the bone runs down the middle of the envelope; the muscle is 10 mm off towards +X: one side sticks out, the other has room
    const bone: ShapePart = { id: 'bone', name: 'Left femur', tissue: 'bone', mesh: cylinder(0.012, 0.4, 0.8, 0.1) }
    const muscle: ShapePart = { id: 'muscle', name: 'Left test muscle', tissue: 'muscle', mesh: cylinder(0.05, 0.45, 0.75, 0.11) }
    const vessel: ShapePart = { id: 'vessel', name: 'Left test vessel', tissue: 'artery', mesh: cylinder(0.003, 0.5, 0.7, 0.165), centrelines: [{ points: Float32Array.from([0.165, 0.5, 0, 0.165, 0.7, 0]), radius: Float32Array.from([0.003, 0.003]) }] }
    const envelope = cylinder(0.052, 0.38, 0.82, 0.1, 0, 96, 120)
    const boneBefore = Float32Array.from(bone.mesh.positions)
    const v0 = signedVolume(muscle.mesh)
    const roleOf = (p: ShapePart): ShapeRole => (p.tissue === 'bone' ? 'bone' : p.tissue === 'muscle' ? 'driver' : 'follower')
    const rep = reshapeIntoEnvelope([bone, muscle, vessel], roleOf, envelope, { xMid: 0, mirror: 0 })
    expect(Array.from(bone.mesh.positions)).toEqual(Array.from(boneBefore))
    expect(rep.outside.before.all!.outside).toBeGreaterThan(0.2)
    expect(rep.outside.after.all!.outside).toBeLessThan(0.05)
    expect(rep.jacobian.folded).toBe(0)
    expect(rep.jacobian.min).toBeGreaterThan(0.3)
    // 是挪动而不是压扁：体积大体保住了 / a shift, not a squeeze: the volume is largely kept
    expect(signedVolume(muscle.mesh) / v0).toBeGreaterThan(0.85)
    expect(rep.passes[0]!.pullAnchors).toBeGreaterThan(0)
    // 血管和它的中心线随同一个场向内移动 / the vessel and its centreline move inwards with the same field
    expect(vessel.centrelines![0]!.points[0]!).toBeLessThan(0.164)
    let cx = 0
    for (let i = 0; i < vessel.mesh.positions.length; i += 3) cx += vessel.mesh.positions[i]! / (vessel.mesh.positions.length / 3)
    expect(Math.abs(cx - vessel.centrelines![0]!.points[0]!)).toBeLessThan(0.003)
  }, 60_000)

  it('returns null for a missing target package', () => {
    expect(loadShapeTarget(join(ROOT, 'data/raw/bodyshape/out/no-such-target'))).toBeNull()
  })
})

describe('which skeleton a target package may be used on (femaleShape.ts)', () => {
  const bones = (shift: (id: string, name: string) => number) => Object.entries(SKELETON_031C_BOXES_MM).map(([id, b]) => ({ id, name: id === 'W_FJ3186' ? 'Distal phalanx of left middle finger' : id === 'VD_calcaneus_left' ? 'Left calcaneus' : `bone ${id}`, bbox: b.map((v) => v / 1000 + shift(id, '')) }))
  it('accepts the skeleton it was made for, before or after stage v2', () => {
    expect(matchTarget({ body: 'female', key: 'abc' }, 'abc', []).accepted).toBe(true)
    expect(matchTarget({ body: 'female', key: stageV2InternalsKey('abc') }, 'abc', []).accepted).toBe(true)
    // 面部目标包的指纹就是 031c 骨架经第 2 版重塑之后的 / the face target's fingerprint is that of skeleton 031c after stage v2
    expect(stageV2InternalsKey(SKELETON_031C_KEY)).toBe('d8e55b8725377511')
  })
  it('refuses other bodies, other internals and a package that does not say', () => {
    expect(matchTarget(null, 'abc', []).accepted).toBe(false)
    expect(matchTarget({ body: 'male', key: 'abc' }, 'abc', []).accepted).toBe(false)
    expect(matchTarget({ body: 'female', key: 'other' }, 'abc', bones(() => 0)).accepted).toBe(false)
  })
  it('accepts a package made for skeleton 031c while the present bones are within tolerance of it', () => {
    for (const key of [SKELETON_031C_KEY, stageV2InternalsKey(SKELETON_031C_KEY)]) {
      const same = matchTarget({ body: 'female', key }, 'present', bones(() => 0))
      expect(same.accepted).toBe(true)
      expect(same.skeleton!.maxDifferenceMm).toBe(0)
      expect(same.leaveRegions).toEqual([])
      // 一块指骨差 5 mm：接受，但手不参加重塑 / a phalanx 5 mm off: accepted, with the hand left out of the stage
      const finger = matchTarget({ body: 'female', key }, 'present', bones((id) => (id === 'W_FJ3186' ? 0.005 : 0)))
      expect(finger.accepted).toBe(true)
      expect(finger.leaveRegions).toEqual(['hand'])
      // 手骨差得太多，或者手以外的骨差出容差：不接受 / a hand bone too far off, or another bone beyond the tolerance: refused
      expect(matchTarget({ body: 'female', key }, 'present', bones((id) => (id === 'W_FJ3186' ? (EXTREMITY_TOLERANCE_MM.hand + 2) / 1000 : 0))).accepted).toBe(false)
      expect(matchTarget({ body: 'female', key }, 'present', bones((id) => (id === 'VD_calcaneus_left' ? 0.02 : 0))).leaveRegions).toEqual(['foot'])
      expect(matchTarget({ body: 'female', key }, 'present', bones((id) => (id === 'VF_femur_left' ? (SKELETON_TOLERANCE_MM + 2) / 1000 : 0))).accepted).toBe(false)
      // 少了一块骨：不接受 / a bone missing: refused
      expect(matchTarget({ body: 'female', key }, 'present', bones(() => 0).slice(1)).accepted).toBe(false)
    }
  })
})

describe.skipIf(!applied)('female body shape (pipeline-report.json bodyShape, shipped GLBs)', () => {
  const data = (applied ? JSON.parse(readFileSync(join(DIR, 'anatomy.json'), 'utf8')) : null) as AnatomyData

  it('was made for these internals and says which envelope it used', () => {
    expect(shape!.basedOn.body).toBe('female')
    // 目标包对的是重塑之前的骨架：要么就是按它做的，要么是按 031c 骨架做的而现在的骨架与之相差在容差以内（见 femaleShape.ts）；
    // 重塑之后指纹不同，按旧软组织拟合的皮肤不会被装入
    // the target is matched against the skeleton before the stage: made for it, or made for skeleton 031c with the present
    // skeleton within tolerance of that one (see femaleShape.ts); after the stage the fingerprint differs, so a skin fitted
    // to the old soft tissue is not installed
    expect(shape!.targetMatch.accepted).toBe(true)
    expect(matchTarget(shape!.basedOn, shape!.internalsKeyBeforeShape, []).accepted || shape!.targetMatch.skeleton.madeFor === SKELETON_031C_KEY).toBe(true)
    if (shape!.targetMatch.skeleton) {
      expect(shape!.targetMatch.skeleton.maxDifferenceMm).toBeLessThanOrEqual(SKELETON_TOLERANCE_MM)
      const ext = shape!.targetMatch.skeleton.extremities
      for (const k of ['hand', 'foot'] as const) expect(ext[k].maxDifferenceMm, k).toBeLessThanOrEqual(EXTREMITY_TOLERANCE_MM[k])
      expect(shape!.targetMatch.skeleton.missing).toEqual([])
      // 手骨或足骨对不上时，该部位不参加重塑 / when the bones of hand or foot do not match, that region is left out of the stage
      expect(shape!.options.leaveRegions ?? []).toEqual((['foot', 'hand'] as const).filter((k) => ext[k].maxDifferenceMm > EXTREMITY_LEAVE_MM))
    }
    expect(report.skinPackage.internalsKeyBeforeShape).toBe(shape!.internalsKeyBeforeShape)
    expect(report.skinPackage.internalsKey).toMatch(/^[0-9a-f]{16}$/)
    expect(report.skinPackage.internalsKey).not.toBe(shape!.internalsKeyBeforeShape)
    expect(shape!.envelopeSha1).toMatch(/^[0-9a-f]{16}$/)
  })

  it('brings soft deep parts in: less outside in every large region, far less overall', () => {
    const before = shape!.outside.before
    const after = shape!.outside.after
    expect(after.all.outside).toBeLessThan(0.6 * before.all.outside)
    expect(after.all.p95Mm).toBeLessThan(before.all.p95Mm)
    for (const k of Object.keys(before)) expect(after[k].outside, k).toBeLessThanOrEqual(before[k].outside + 0.005)
    // 唇随目标唇面前移（见 femaleShape.ts）：前表面在目标体表之下，没有顶点移动超过上限
    // the lips moved forwards with the target lip surface (see femaleShape.ts): front face under the target skin, no vertex moved beyond the cap
    for (const r of shape!.lipCarry?.parts ?? []) if (r.carried) {
      expect(r.displacementMm.max, r.name).toBeLessThanOrEqual(shape!.lipCarry.maxMm)
      // 肌只平移和剪切，不变厚；没有哪块更深地进到牙或颌骨里 / muscles translate and shear but do not thicken; none ends up deeper in teeth or jaws
      if (r.kind === 'perioral' && r.volumeMl.before >= 0.05) expect(Math.abs(r.volumeMl.change), r.name).toBeLessThan(PERIORAL_VOLUME_TOLERANCE)
      expect(r.insideTeethOrJaws.after, r.name).toBeLessThanOrEqual(r.insideTeethOrJaws.before + 0.005)
      if (r.coverWantedMm !== null) expect(Math.abs(r.medianCoverAfterMm - r.coverWantedMm), r.name).toBeLessThan(Math.abs(r.medianCoverBeforeMm - r.coverWantedMm))
      // 唇部件留在目标体表之内（按最近点距离收住，沿平移方向量会差零点几毫米） / the Lip part stays inside the target skin (held by nearest-point distance, which reads a few tenths of a millimetre off along the direction of travel)
      if (r.kind === 'lip') expect(r.leastCoverAfterMm, r.name).toBeGreaterThanOrEqual(0)
    }
    if (shape!.lipCarry?.parts?.length) {
      expect(shape!.lipCarry.parts.filter((r: any) => r.kind === 'perioral').length).toBeGreaterThanOrEqual(15)
      // 口轮匝肌整块平移：体积不变 / orbicularis oris translates whole: its volume does not change
      expect(Math.abs(shape!.lipCarry.parts.find((r: any) => r.name === 'Orbicularis oris').volumeMl.change)).toBeLessThan(0.01)
    }
    // 腹部和骨盆不受体积下限牵制，进得最多；四肢由男性形变来的肌受“性别比”下限约束
    // abdomen and pelvis are not held back by the volume floor and come in furthest; the limb muscles warped from the male are held by the sex-ratio floor
    for (const k of ['abdomen', 'pelvis']) expect(after[k].outside, k).toBeLessThan(0.5 * before[k].outside)
  })

  it('is one smooth field: no folding, nothing moved on bone', () => {
    const j = shape!.jacobian
    expect(j.samples).toBeGreaterThan(20000)
    expect(j.folded).toBe(0)
    expect(j.min).toBeGreaterThan(0)
    expect(j.p01).toBeGreaterThan(0.2)
    expect(j.median).toBeGreaterThan(0.85)
    expect(j.median).toBeLessThan(1.1)
    expect(shape!.onBoneMm.p95).toBeLessThan(1)
    expect(shape!.displacementMm.max).toBeLessThanOrEqual(1000 * shape!.options.maxPush * 1.3)
  })

  it('reports muscle volume per muscle and per region, flags the large losses and deletes nothing', () => {
    const v = shape!.volume
    expect(v.perMuscle.length).toBe(v.muscles)
    expect(v.muscles).toBeGreaterThan(400)
    const ids = new Set(data.parts.map((p) => p.id))
    for (const m of v.perMuscle) expect(ids.has(m.id), m.name).toBe(true)
    const flagged = new Set(v.flagged.map((m: any) => m.id))
    for (const m of v.perMuscle) if (m.beforeMl >= 0.05) expect(flagged.has(m.id), m.name).toBe(m.change < -shape!.options.flagVolumeLoss)
    // 全身肌肉体积的损失有限；每个部位都有前后数值 / the loss of total muscle volume is bounded; every region has both figures
    expect(v.totalAfterMl / v.totalBeforeMl).toBeGreaterThan(0.8)
    expect(v.totalAfterMl / v.totalBeforeMl).toBeLessThan(1.05)
    for (const r of Object.values(v.byRegion) as any[]) expect(r.afterMl / r.beforeMl).toBeGreaterThan(0.6)
    // 压缩有上限：没有一块肌被压到原来的三成以下 / compression is capped: no muscle is left with less than three tenths of its volume
    for (const m of v.perMuscle) if (m.beforeMl >= 1) expect(m.afterMl / m.beforeMl, m.name).toBeGreaterThan(0.3)
  })

  it('keeps muscles warped from the male above the sourced female-to-male ratio, region by region', () => {
    const ratio = shape!.muscleSexRatio
    expect(ratio.source).toMatch(/Janssen.*10\.1152\/jappl\.2000\.89\.1\.81/)
    expect(ratio.upperBody).toBe(0.6)
    expect(ratio.lowerBody).toBe(0.67)
    const rows = Object.entries(shape!.volumeFloor.byRegion) as [string, any][]
    expect(rows.length).toBeGreaterThanOrEqual(10)
    for (const [k, r] of rows) {
      // 本步之后不低于参考体积（进入本步时已经低于的部位除外：它们不再被压）
      // not below the reference after the stage (regions already below it on entry are simply not squeezed further)
      if (r.allowedFactor < 1) expect(r.afterMl, k).toBeGreaterThanOrEqual(0.99 * r.referenceMl)
      expect(r.minDepthShare, k).toBeGreaterThanOrEqual(shape!.options.depthFloor)
      expect(r.minDepthShare, k).toBeLessThanOrEqual(1)
    }
    const ids = new Set(data.parts.map((p) => p.id))
    for (const m of shape!.volumeFloor.belowOwnReference) {
      expect(ids.has(m.id), m.name).toBe(true)
      // （两个数都四舍五入到 0.01 ml） / (both figures are rounded to 0.01 ml)
      expect(m.afterMl, m.name).toBeLessThanOrEqual(m.referenceMl)
    }
  })

  it('carries lymph nodes whole, without letting them drive the field', () => {
    expect(shape!.parts.rigid).toBe(data.parts.filter((p) => p.system === 'lymphatic' && /\bnodes?\b/i.test(p.name)).length)
    expect(shape!.parts.rigid).toBeGreaterThan(100)
    expect(shape!.rigid.after.outside).toBeLessThanOrEqual(shape!.rigid.before.outside + 0.01)
    const nodeIds = new Set(data.parts.filter((p) => p.system === 'lymphatic' && /\bnodes?\b/i.test(p.name)).map((p) => p.id))
    for (const m of shape!.organs.flagged) expect(nodeIds.has(m.id), m.name).toBe(false)
  })

  it('leaves bone, joint ligaments, the Wu pelvic parts and CT/HRA viscera alone and reports what of them is outside', () => {
    expect(shape!.parts.bone).toBe(data.parts.filter((p) => p.tissue === 'bone' || p.tissue === 'tooth' || p.tissue === 'cartilage').length)
    expect(shape!.parts.fixed).toBeGreaterThan(300)
    expect(shape!.notMoved.bone.byRegion.all.samples).toBeGreaterThan(50000)
    expect(Array.isArray(shape!.notMoved.bone.parts)).toBe(true)
    expect(shape!.notMoved.fixed.all.samples).toBeGreaterThan(10000)
    for (const n of shape!.freeLigaments) expect(data.parts.some((p) => p.name === n && p.tissue === 'ligament'), n).toBe(true)
    expect(shape!.freeLigaments).toEqual(expect.arrayContaining(['Nuchal ligament']))
  })

  it('keeps the anatomical checks: nerve landmarks, sex checks, pelvic checks, attachments', () => {
    const lm = report.landmarks as { pass: boolean; evaluated: boolean }[]
    expect(lm.length).toBe(18)
    expect(lm.filter((r) => r.pass).length).toBe(18)
    // 九项：原有的七项，加上两项乳房高度检查（leftBreastLevel / rightBreastLevel），全部要过
    // nine: the seven original checks and the two breast level checks (leftBreastLevel / rightBreastLevel), all of which must pass
    const sex = Object.entries(report.sexChecks as Record<string, { pass: boolean }>)
    expect(sex.length).toBe(9)
    expect(sex.filter(([, c]) => !c.pass).map(([k]) => k)).toEqual([])
    expect(report.pelvisChecks.checks.length).toBe(12)
    expect(report.pelvisChecks.checks.filter((c: any) => !c.pass).map((c: any) => c.id)).toEqual([])
    const att = report.attachments as { ok: boolean }[]
    expect(att.length).toBe(28)
    expect(att.filter((a) => a.ok).length).toBeGreaterThanOrEqual(25)
  })

  it('says so in the cautions, in both languages', () => {
    const c = (data.cautions ?? []).find((x) => /target body surface/.test(x.en))
    expect(c).toBeDefined()
    expect(c!.zh).toMatch(/目标体表/)
  })

  // 成品几何上的复核：需要构建时用的那一版包络仍在磁盘上
  // recheck on shipped geometry: needs the very envelope the build used to be on disk still
  const target = applied ? loadShapeTarget(join(ROOT, shape!.dir)) : null
  it.skipIf(!target || target.envelopeSha1 !== shape?.envelopeSha1)('finds the same share outside the envelope on the shipped muscles', async () => {
    const body = await loadBuiltBody(DIR)
    const as = (f: (p: AnatomyData['parts'][number]) => boolean): ShapePart[] => data.parts.filter(f).map((p) => ({ id: p.id, name: p.name, tissue: p.tissue, mesh: body.meshes.get(p.id)! }))
    // 体形重塑之后上肢又外展过：被外展动过的部件已不在包络所对的位置上，不参加复核
    // the arms were abducted after the stage: parts the abduction moved are no longer where the envelope expects them and are left out of the recheck
    const abducted = new Set<string>(report.armAbduction?.movedIds ?? [])
    const flaggedOrNot = new Set(shape!.volume.perMuscle.map((m: any) => m.id).filter((id: string) => !abducted.has(id)))
    const share = outsideShare(as((p) => flaggedOrNot.has(p.id)), as((p) => p.tissue === 'bone' || p.tissue === 'tooth' || p.tissue === 'cartilage'), target!.envelope)
    // 报告里的数包含器官，这里只有肌和腱；简化后的网格也略有出入
    // the reported figure includes organs and this one muscles and tendons only; the simplified meshes differ slightly too
    expect(share).toBeLessThan(shape!.outside.after.all.outside + 0.05)
    expect(share).toBeLessThan(0.75 * shape!.outside.before.all.outside)
  }, 180_000)
})
