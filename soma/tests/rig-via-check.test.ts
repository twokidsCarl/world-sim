// 经过点的门槛（tools/rig/via-check.ts）：同一姿势下，有经过点（网格按横截面蒙皮并推出骨面）的肌肉网格与去掉经过点（纯蒙皮）相比，
// 翻转的三角形、边的拉伸（p99、最大值）、落在膝周骨里的顶点、皮肤外的顶点（个数和最远距离）、悬空（最远距离和超过 15 mm 的个数）都不多，
// 股骨远端前面、髌骨、股骨髁后面的覆盖不少。
// 覆盖只算射线碰到的第一个面是骨外的肌肉（穿在骨里的肌肉、先碰到骨都不算）。骨网格必须封闭（否则 checkBody 抛错）。
// 屈膝 90°、135° 和下蹲三个姿势，两副身体全量（两副约 3 秒）。绑定尚未生成时跳过。
// The via-point gate (tools/rig/via-check.ts): in the same pose, the muscle meshes with via points (skinned by
// cross-section and pushed out of the bones) against the same rig with the via points removed (plain skinning) have no
// more inverted triangles, no more edge stretch (p99 and max), no more vertices inside the knee bones, no more vertices
// outside the skin (count and largest distance), no more stand-off (largest distance and the count beyond 15 mm), and
// cover no less of the anterior distal femur, the patella and the posterior condyles. Coverage counts only when the first surface
// the ray meets is muscle lying outside the bone (muscle running inside the bone, or a bone met first, does not count).
// The bone meshes must be closed (checkBody throws otherwise). Knee flexion 90° and 135° and the squat, both bodies in
// full (about 3 s for the two). Skipped while the rig is not built.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkBody, gateFailures } from '../tools/rig/via-check.ts'

for (const bodyId of ['male', 'female'] as const) {
  const DIR = join(import.meta.dirname, '../public/anatomy', bodyId)
  const present = existsSync(join(DIR, 'rig.json')) && existsSync(join(DIR, 'rig.bin')) && existsSync(join(DIR, 'anatomy.json'))

  describe.skipIf(!present)(`via-point gate (${bodyId})`, () => {
    it('with via points: no more inversions, stretch, muscle in bone, muscle outside the skin or stand-off, no less bone coverage', { timeout: 120_000 }, async () => {
      const rows = await checkBody(bodyId)
      expect(rows.map((r) => r.pose)).toEqual(['flex90', 'flex135', 'squat'])
      for (const r of rows) {
        const at = `${r.body} ${r.pose}`
        expect(r.inverted[1], `${at}: inverted triangles`).toBeLessThanOrEqual(r.inverted[0])
        expect(r.stretchP99[1], `${at}: edge stretch p99`).toBeLessThanOrEqual(r.stretchP99[0])
        expect(r.stretchMax[1], `${at}: edge stretch max`).toBeLessThanOrEqual(r.stretchMax[0])
        expect(r.inBone[1], `${at}: vertices inside a knee bone`).toBeLessThanOrEqual(r.inBone[0])
        expect(r.outsideSkin[1], `${at}: vertices outside the skin`).toBeLessThanOrEqual(r.outsideSkin[0])
        expect(r.outsideSkinMm[1], `${at}: largest distance outside the skin`).toBeLessThanOrEqual(r.outsideSkinMm[0])
        expect(r.standOffMm[1], `${at}: largest stand-off`).toBeLessThanOrEqual(r.standOffMm[0])
        expect(r.detached[1], `${at}: detached vertices`).toBeLessThanOrEqual(r.detached[0])
        for (const k of ['anteriorFemur', 'patella', 'posteriorCondyles'] as const) expect(r.coverage[k][1], `${at}: coverage of ${k}`).toBeGreaterThanOrEqual(r.coverage[k][0])
        expect(gateFailures(r), at).toEqual([])
        // 门槛确实在量东西：屈膝时纯蒙皮有翻转、有肌肉在骨里，覆盖不为 0 / the gate really measures something: under flexion plain skinning has inversions and muscle in bone, and coverage is not zero
        expect(r.inverted[0]).toBeGreaterThan(0)
        expect(r.inBone[0]).toBeGreaterThan(0)
        for (const k of ['anteriorFemur', 'patella', 'posteriorCondyles'] as const) expect(r.coverage[k][0], `${at}: ${k}`).toBeGreaterThan(0)
      }
    })
  })
}
