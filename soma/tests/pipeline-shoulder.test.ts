// 男性肩带姿势校正的验证：针对已生成的 public/anatomy/male（报告中的数值 + 从 GLB 重新量出的几何）。
// 没有生成结果时跳过。
// Checks of the male shoulder girdle posture correction, against the generated public/anatomy/male
// (numbers of the report + geometry measured again from the GLBs). Skipped when there is no output.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnatomyData, Part } from '../src/anatomy/types.ts'
import type { Mesh } from '../tools/pipeline/geometry.ts'
import { readGlb } from '../tools/pipeline/glb.ts'
import type { LandmarkResult } from '../tools/pipeline/landmarks.ts'
import { girdleAngles, girdleLandmarks, RESTING_POSTURE, rotationAngleOf, thoraxFrame, thoraxLandmarks, type GirdleAngles } from '../tools/pipeline/shoulder.ts'

const DIR = join(import.meta.dirname, '../public/anatomy/male')
const present = existsSync(join(DIR, 'anatomy.json')) && existsSync(join(DIR, 'pipeline-report.json'))

interface Gap { minMm: number; medianMm: number }
interface SideReport {
  anglesDeg: Record<keyof GirdleAngles, { before: number; after: number; sdFromRestingMean: [number, number] }>
  humeralHeadCentreMovedMm: [number, number, number]
  scapulothoracic: {
    standOffChangeMm: { rms: number; maxCloser: number }
    costalSurfaceToChestWall: { before: { minMm: number; p10Mm: number }; after: { minMm: number; p10Mm: number } }
    wholeScapulaToRibs: { before: { minMm: number; p10Mm: number }; after: { minMm: number; p10Mm: number } }
    scapulaSurfaceInsideRibs: { before: number; after: number }
  }
  jointGaps: Record<'glenohumeral' | 'acromioclavicular' | 'sternoclavicular', { before: Gap; after: Gap }>
  arm: { bones: number; shaftDirection: { changeDeg: number }; elbowRelativeToPelvisMm: { before: number[]; after: number[] } }
}
interface Transform { rotation: number[]; translationM: number[]; inverse: { rotation: number[]; translationM: number[] } }
interface ShoulderReport {
  applied: boolean
  glenohumeralSeparationMm: { before: number; after: number; target: number; withoutLateralTarget: number }
  targetsTried: { separationMm: number; accepted: boolean }[]
  sides: { left: SideReport; right: SideReport }
  transforms: Record<string, Transform>
  jointCentresM: Record<string, number[]>
  symmetry: { glenohumeralCentreMm: number; humeralHeadDisplacementMm: number }
  field: { largestDisplacementNearBoundaryMm: number; jacobian: { samples: number; nonPositive: number; median: number } }
  parts: {
    moved: number
    byVia: Record<string, number>
    mapJacobianAtVertices: { samples: number; nonPositive: number }
    thinStructures: { triangles: number; reversedTriangles: number }
  }
  attachments: { checked: number; movedOffBoneByMoreThan1Mm: number; largestIncrease: { mm: number } }
  insideBone: { before: number; after: number }
  nerves: { rebuilt: number; inBone: { before: number; afterCleanUp: number }; deepInMuscle: { before: number; after: number } }
  provenance: { scannedBefore: number; scannedAfter: number; relabelledToWarped: number; relabelledByTissue: Record<string, number>; relabelledIds: string[]; replacedBySkinPackage?: string[] }
}

describe.skipIf(!present)('male shoulder girdle posture correction (public/anatomy/male)', () => {
  const data = (present ? JSON.parse(readFileSync(join(DIR, 'anatomy.json'), 'utf8')) : null) as AnatomyData
  const report = (present ? JSON.parse(readFileSync(join(DIR, 'pipeline-report.json'), 'utf8')) : null) as { shoulderGirdle: ShoulderReport; landmarks: LandmarkResult[]; landmarksAsScanned: LandmarkResult[]; skinPackage: { installed?: boolean; internalsKey: string; externalGenitalia: { parts: string[]; bbox: number[]; reachInFrontOfPubisMm: number } } }
  const sg = present ? report.shoulderGirdle : (null as unknown as ShoulderReport)
  const sides = () => [sg.sides.left, sg.sides.right]
  const skinInstalled = present && !!report.skinPackage.installed
  const part = (name: string): Part => data.parts.find((p) => p.name === name)!

  it('is applied, and widens the glenohumeral separation as far as the constraints allow', () => {
    expect(sg.applied).toBe(true)
    const s = sg.glenohumeralSeparationMm
    expect(s.before).toBeGreaterThan(322)
    expect(s.before).toBeLessThan(327)
    expect(s.after).toBeGreaterThan(335)
    expect(s.after).toBeLessThanOrEqual(s.target + 0.5)
    // 不低于“只按文献姿势和约束、不设外移目标”时自然得到的间距
    // not below what the literature posture and the constraints give by themselves, without a lateral target
    expect(s.after).toBeGreaterThanOrEqual(s.withoutLateralTarget)
    // 更大的间距都试过且被约束否决 / every larger separation that was tried was rejected by the constraints
    for (const t of sg.targetsTried) expect(t.accepted, `${t.separationMm} mm`).toBe(t.separationMm <= s.after + 0.5)
  })

  it('brings the clavicles to the resting means and the scapulae towards them', () => {
    for (const side of sides()) {
      for (const k of ['clavicleRetraction', 'clavicleElevation'] as const) {
        expect(Math.abs(side.anglesDeg[k].sdFromRestingMean[0]), k).toBeGreaterThan(0.9)
        expect(Math.abs(side.anglesDeg[k].sdFromRestingMean[1]), k).toBeLessThan(0.6)
      }
      for (const k of Object.keys(RESTING_POSTURE) as (keyof GirdleAngles)[]) {
        // 没有哪个角比校正前离均值更远 / no angle ends further from the mean than it started
        expect(Math.abs(side.anglesDeg[k].sdFromRestingMean[1]), k).toBeLessThanOrEqual(Math.abs(side.anglesDeg[k].sdFromRestingMean[0]) + 0.1)
      }
      expect(side.anglesDeg.scapulaInternalRotation.after - side.anglesDeg.scapulaInternalRotation.before).toBeGreaterThan(8)
      expect(Math.abs(side.anglesDeg.scapulaUpwardRotation.sdFromRestingMean[1])).toBeLessThan(1)
    }
  })

  it('keeps the scapula on the chest wall: stand-off preserved, nothing closer to the ribs, no penetration', () => {
    for (const side of sides()) {
      const st = side.scapulothoracic
      expect(st.standOffChangeMm.rms).toBeLessThanOrEqual(2.5)
      expect(st.costalSurfaceToChestWall.after.minMm).toBeGreaterThanOrEqual(st.costalSurfaceToChestWall.before.minMm - 0.05)
      expect(st.costalSurfaceToChestWall.after.p10Mm).toBeGreaterThanOrEqual(st.costalSurfaceToChestWall.before.p10Mm - 0.05)
      expect(st.wholeScapulaToRibs.after.minMm).toBeGreaterThanOrEqual(st.wholeScapulaToRibs.before.minMm - 0.05)
      expect(st.wholeScapulaToRibs.after.p10Mm).toBeGreaterThanOrEqual(st.wholeScapulaToRibs.before.p10Mm - 0.05)
      expect(st.scapulaSurfaceInsideRibs.after).toBe(0)
    }
  })

  it('keeps the glenohumeral, acromioclavicular and sternoclavicular joints congruent', () => {
    for (const side of sides()) {
      for (const j of ['glenohumeral', 'acromioclavicular', 'sternoclavicular'] as const) {
        const g = side.jointGaps[j]
        expect(Math.abs(g.after.medianMm - g.before.medianMm), j).toBeLessThan(0.5)
        expect(g.after.minMm, j).toBeGreaterThanOrEqual(g.before.minMm - 0.2)
        expect(g.after.minMm, j).toBeGreaterThan(0)
      }
    }
  })

  it('moves bones by pure rigid transforms that can be inverted, the limbs by translation only, mirror-symmetrically', () => {
    for (const [key, t] of Object.entries(sg.transforms)) {
      if (key === 'note') continue
      const r = t.rotation
      const det = r[0]! * (r[4]! * r[8]! - r[5]! * r[7]!) - r[1]! * (r[3]! * r[8]! - r[5]! * r[6]!) + r[2]! * (r[3]! * r[7]! - r[4]! * r[6]!)
      expect(det, key).toBeCloseTo(1, 5)
      // inverse(T(x)) = x
      const x = [0.15, 1.3, 0.05]
      const y = [0, 1, 2].map((i) => r[3 * i]! * x[0]! + r[3 * i + 1]! * x[1]! + r[3 * i + 2]! * x[2]! + t.translationM[i]!)
      const back = [0, 1, 2].map((i) => t.inverse.rotation[3 * i]! * y[0]! + t.inverse.rotation[3 * i + 1]! * y[1]! + t.inverse.rotation[3 * i + 2]! * y[2]! + t.inverse.translationM[i]!)
      for (let i = 0; i < 3; i++) expect(back[i]!, key).toBeCloseTo(x[i]!, 5)
      if (key.startsWith('arm_')) expect(rotationAngleOf(r), key).toBe(0)
      else expect((rotationAngleOf(r) * 180) / Math.PI, key).toBeLessThan(25)
    }
    for (const side of sides()) {
      expect(side.arm.bones).toBe(30)
      expect(side.arm.shaftDirection.changeDeg).toBe(0)
      // 肘相对骨盆的位移 = 肱骨头中心的位移（上肢整体平移） / the elbow moves relative to the pelvis exactly as the humeral head centre does (the limb is translated as a block)
      const d = side.arm.elbowRelativeToPelvisMm.after.map((v, i) => v - side.arm.elbowRelativeToPelvisMm.before[i]!)
      expect(Math.abs(d[0]!) - Math.abs(side.humeralHeadCentreMovedMm[0])).toBeLessThan(0.21)
      expect(d[1]! - side.humeralHeadCentreMovedMm[1]).toBeCloseTo(0, 0)
      expect(d[2]! - side.humeralHeadCentreMovedMm[2]).toBeCloseTo(0, 0)
    }
    expect(sg.symmetry.glenohumeralCentreMm).toBeLessThan(2)
    expect(sg.symmetry.humeralHeadDisplacementMm).toBeLessThan(1)
    const l = sg.sides.left.humeralHeadCentreMovedMm
    // 肩下降并前移，上肢不抬高 / the shoulders come down and forwards; the limbs are not raised
    expect(l[1]).toBeLessThan(-10)
    expect(l[2]).toBeGreaterThan(10)
    expect(l[2]).toBeLessThan(35)
  })

  it('ships the geometry the report describes (angles and joint centres measured again from the GLBs)', async () => {
    const wanted = new Set(['Manubrium', 'Xiphoid process', 'Seventh cervical vertebra', 'Eighth thoracic vertebra', ...['Left', 'Right'].flatMap((S) => [`${S} clavicle`, `${S} scapula`, `${S} humerus`])])
    const byId = new Map(data.parts.map((p) => [p.id, p]))
    const meshes = new Map<string, Mesh>()
    const doc = await readGlb(join(DIR, 'skeletal.glb'))
    for (const node of doc.getRoot().listNodes()) {
      const p = byId.get(node.getName())
      if (!p || !wanted.has(p.name)) continue
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
    expect(meshes.size).toBe(wanted.size)
    const M = (n: string) => meshes.get(n)!
    const frame = thoraxFrame(thoraxLandmarks(M('Manubrium'), M('Xiphoid process'), M('Seventh cervical vertebra'), M('Eighth thoracic vertebra')))
    const gh: number[][] = []
    const apply = (t: { rotation: number[]; translationM: number[] }, v: ArrayLike<number>): Float32Array => {
      const o = new Float32Array(v.length)
      for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) o[i + k] = t.rotation[3 * k]! * v[i]! + t.rotation[3 * k + 1]! * v[i + 1]! + t.rotation[3 * k + 2]! * v[i + 2]! + t.translationM[k]!
      return o
    }
    for (const [S, s, lat, side] of [['Left', 'L', 1, sg.sides.left], ['Right', 'R', -1, sg.sides.right]] as const) {
      // 标志点是在扫描原样的姿势上自动取的（取“最靠内”“最靠后外”的点，换了姿势取到的就不是同一个点），
      // 所以先用报告里的逆变换把三块骨放回原位、取标志点，再用正变换带到校正后的位置。
      // The landmarks are picked automatically in the as-scanned posture (extreme points: in another
      // posture the extremes are other points), so the three bones are first put back with the inverse
      // transforms of the report, the landmarks picked, and then carried forward again.
      const T = { clavicle: sg.transforms[`clavicle_${s}`]!, scapula: sg.transforms[`scapula_${s}`]!, arm: sg.transforms[`arm_${s}`]! }
      const back = (name: string, t: Transform): Mesh => ({ positions: apply(t.inverse, M(name).positions), indices: M(name).indices })
      const lm0 = girdleLandmarks(lat, back(`${S} clavicle`, T.clavicle), back(`${S} scapula`, T.scapula), back(`${S} humerus`, T.arm), M('Manubrium'))
      const fwd = (t: Transform, v: [number, number, number]) => Array.from(apply(t, v)) as [number, number, number]
      const lm = { sc: lm0.sc, ac: fwd(T.clavicle, lm0.ac), gh: fwd(T.arm, lm0.gh), aa: fwd(T.scapula, lm0.aa), ts: fwd(T.scapula, lm0.ts), ai: fwd(T.scapula, lm0.ai) }
      gh.push(lm.gh)
      for (const [name, c] of [['glenohumeral', lm.gh], ['acromioclavicular', lm.ac], ['sternoclavicular', lm.sc]] as const) {
        const r = sg.jointCentresM[`${name}_${s}`]!
        expect(Math.hypot(c[0] - r[0]!, c[1] - r[1]!, c[2] - r[2]!) * 1000, `${name} ${s}`).toBeLessThan(2.5)
      }
      // 肩锁关节不脱开：锁骨带过去的关节中心与肩胛骨带过去的是同一点；肱骨头中心随关节盂走
      // the acromioclavicular joint stays together: its centre carried by the clavicle and by the scapula is one point; the head centre goes with the glenoid
      // （简化网格上取到的中心与管线用的相差 1–2 mm，转 15° 后相差不到 1 mm） / (centres picked on the simplified meshes are 1–2 mm from the pipeline's, which turned by 15° makes less than 1 mm)
      const acByScapula = fwd(T.scapula, lm0.ac)
      expect(Math.hypot(acByScapula[0] - lm.ac[0], acByScapula[1] - lm.ac[1], acByScapula[2] - lm.ac[2]) * 1000).toBeLessThan(1)
      const ghByScapula = fwd(T.scapula, lm0.gh)
      expect(Math.hypot(ghByScapula[0] - lm.gh[0], ghByScapula[1] - lm.gh[1], ghByScapula[2] - lm.gh[2]) * 1000).toBeLessThan(1)
      // 自动取的标志点在简化后的网格上会偏几毫米，角度允许差 4°
      // the automatically picked landmarks shift by millimetres on the simplified meshes: angles may differ by 4°
      const a0 = girdleAngles(frame, lat, lm0)
      const a1 = girdleAngles(frame, lat, lm)
      for (const k of Object.keys(RESTING_POSTURE) as (keyof GirdleAngles)[]) {
        expect(Math.abs(a0[k] - side.anglesDeg[k].before), `${S} ${k} before`).toBeLessThan(4)
        expect(Math.abs(a1[k] - side.anglesDeg[k].after), `${S} ${k} after`).toBeLessThan(4)
        // 角度的变化量不依赖标志点取得准不准 / the change of an angle does not depend on how well the landmarks were picked
        expect(Math.abs(a1[k] - a0[k] - (side.anglesDeg[k].after - side.anglesDeg[k].before)), `${S} ${k} change`).toBeLessThan(1.5)
      }
      // 锁骨没有被缩放：长度仍在 145–152 mm / the clavicle was not scaled: still 145–152 mm long
      const len = Math.hypot(lm.ac[0] - lm.sc[0], lm.ac[1] - lm.sc[1], lm.ac[2] - lm.sc[2]) * 1000
      expect(len).toBeGreaterThan(145)
      expect(len).toBeLessThan(152)
    }
    expect(Math.abs((gh[0]![0]! - gh[1]![0]!) * 1000 - sg.glenohumeralSeparationMm.after)).toBeLessThan(1.5)
    // 其余大关节中心都给出了，且左右对称 / the other large joint centres are given, and mirror each other
    for (const j of ['hip', 'knee', 'ankle', 'elbow', 'wrist', 'glenohumeral', 'acromioclavicular', 'sternoclavicular']) {
      const l = sg.jointCentresM[`${j}_L`]!
      const r = sg.jointCentresM[`${j}_R`]!
      expect(l.length, j).toBe(3)
      expect(Math.hypot(l[0]! + r[0]!, l[1]! - r[1]!, l[2]! - r[2]!) * 1000, j).toBeLessThan(6)
    }
  }, 120_000)

  it('does not fold space, keeps attachments on their bones and soft parts out of bone', () => {
    // 位移场在网格上的雅可比行列式：非正的不超过 0.3 %（都在上肢/肩胛骨贴着胸壁滑动的那一层里）
    // Jacobian determinant of the field on a grid: non-positive in at most 0.3 % of the samples (all in the layer where limb and scapula slide on the chest wall)
    expect(sg.field.jacobian.samples).toBeGreaterThan(50_000)
    expect(sg.field.jacobian.nonPositive / sg.field.jacobian.samples).toBeLessThan(0.003)
    expect(sg.field.jacobian.median).toBeCloseTo(1, 2)
    expect(sg.field.largestDisplacementNearBoundaryMm).toBeLessThan(0.05)
    expect(sg.parts.mapJacobianAtVertices.nonPositive / sg.parts.mapJacobianAtVertices.samples).toBeLessThan(0.001)
    expect(sg.parts.thinStructures.reversedTriangles / sg.parts.thinStructures.triangles).toBeLessThan(0.004)
    expect(sg.attachments.checked).toBeGreaterThan(120)
    expect(sg.attachments.movedOffBoneByMoreThan1Mm).toBeLessThanOrEqual(3)
    expect(sg.attachments.largestIncrease.mm).toBeLessThan(2)
    expect(sg.insideBone.after).toBeLessThanOrEqual(sg.insideBone.before + 0.001)
    expect(sg.nerves.inBone.afterCleanUp).toBeLessThanOrEqual(sg.nerves.inBone.before + 0.001)
    expect(sg.nerves.deepInMuscle.after).toBeLessThanOrEqual(sg.nerves.deepInMuscle.before + 0.01)
  })

  it('passes all 18 nerve landmark checks before and after', () => {
    for (const list of [report.landmarksAsScanned, report.landmarks]) {
      expect(list.length).toBe(18)
      expect(list.filter((r) => !r.pass).map((r) => `${r.side} ${r.id}: ${r.measured}`)).toEqual([])
    }
    // 桡神经沟里的主干随肱骨刚性移动：校正前后离骨的距离、在骨干后方的距离相差不到 0.3 mm
    // the trunk in the radial groove moves rigidly with the humerus: its distance from the bone and behind the shaft change by less than 0.3 mm
    for (const side of ['L', 'R'] as const) {
      const a = report.landmarksAsScanned.find((r) => r.id === 'radial-humerus' && r.side === side)!.values
      const b = report.landmarks.find((r) => r.id === 'radial-humerus' && r.side === side)!.values
      expect(Math.abs(a.toBone! - b.toBone!)).toBeLessThan(0.3)
      expect(Math.abs(a.posterior! - b.posterior!)).toBeLessThan(0.3)
    }
  })

  it('relabels only what was deformed: the limbs and the girdle bones stay scanned', () => {
    const pv = sg.provenance
    expect(pv.scannedBefore).toBe(2220)
    expect(pv.relabelledToWarped).toBe(pv.relabelledIds.length)
    expect(pv.relabelledToWarped).toBeLessThanOrEqual(160)
    // 装入外部皮肤包时，被形变过的旧皮肤已被换掉：它既不算 warped，也不再是 scanned
    // with an external skin package installed, the old skin that had been deformed is gone: neither warped nor scanned any more
    const replaced = pv.replacedBySkinPackage ?? []
    expect(replaced.length).toBe(skinInstalled ? 1 : 0)
    expect(pv.scannedAfter).toBe(pv.scannedBefore - pv.relabelledToWarped - replaced.length)
    expect(data.parts.filter((p) => p.provenance === 'scanned').length).toBe(pv.scannedAfter)
    expect(data.parts.filter((p) => p.id.startsWith('FJ') && p.provenance === 'warped').map((p) => p.id).sort()).toEqual([...pv.relabelledIds].sort())
    // 只有肌、动脉、静脉和皮肤被改标；骨一块也没有 / only muscles, arteries, veins and the skin are relabelled; not one bone
    expect(Object.keys(pv.relabelledByTissue).sort()).toEqual(skinInstalled ? ['artery', 'muscle', 'vein'] : ['artery', 'muscle', 'skin', 'vein'])
    expect(data.parts.filter((p) => p.tissue === 'bone' && p.provenance !== 'scanned')).toEqual([])
    for (const S of ['Left', 'Right']) {
      const s = S.toLowerCase()
      for (const n of [`${S} clavicle`, `${S} scapula`, `${S} humerus`, `${S} radius`, `${S} ulna`, `${S} brachialis`, `${S} brachioradialis`, `Lateral head of ${s} triceps brachii`, `Medial head of ${s} triceps brachii`, `${S} radial artery`]) expect(part(n)?.provenance, n).toBe('scanned')
      for (const n of [`Acromial part of ${s} deltoid`, `${S} serratus anterior`, `${S} pectoralis minor`, `${S} subscapularis`, `${S} levator scapulae`, `${S} axillary artery`]) expect(part(n)?.provenance, n).toBe('warped')
    }
    expect(part('Skin').provenance).toBe(skinInstalled ? 'curated' : 'warped')
    // 躯干深部和下肢不受影响 / the deep trunk and the lower limbs are untouched
    for (const n of ['Left femur', 'Left psoas major', 'Trachea', 'Left external oblique']) expect(part(n)?.provenance, n).toBe('scanned')
  })

  it('reports what the skin fitter needs', () => {
    expect(report.skinPackage.internalsKey).toMatch(/^[0-9a-f]{16}$/)
    const g = report.skinPackage.externalGenitalia
    expect(g.parts.length).toBe(15)
    expect(g.reachInFrontOfPubisMm).toBeGreaterThan(50)
    expect(g.bbox.length).toBe(6)
    const c = data.cautions!.map((x) => x.zh).join(' ')
    expect(c).toContain('仰卧')
    expect(c).toContain('形变')
  })
})
