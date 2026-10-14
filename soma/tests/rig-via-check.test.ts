// 经过点的门槛（tools/rig/via-check.ts）：同一姿势下，有经过点的肌肉网格与去掉经过点（纯蒙皮）相比，
// 翻转的三角形和边的拉伸（p99、最大值）不多，股骨远端前面、髌骨、股骨髁后面的覆盖不少。
// 屈膝 90°、135° 和下蹲三个姿势，两副身体全量（两副约 3 秒，不需要缩减样本）。绑定尚未生成时跳过。
// The via-point gate (tools/rig/via-check.ts): in the same pose, the muscle meshes with via points against the same rig
// with the via points removed (plain skinning) have no more inverted triangles and no more edge stretch (p99 and max),
// and cover no less of the anterior distal femur, the patella and the posterior condyles. Knee flexion 90° and 135° and
// the squat, both bodies in full (about 3 s for the two, so no reduced sample is needed). Skipped while the rig is not built.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkBody } from '../tools/rig/via-check.ts'

for (const bodyId of ['male', 'female'] as const) {
  const DIR = join(import.meta.dirname, '../public/anatomy', bodyId)
  const present = existsSync(join(DIR, 'rig.json')) && existsSync(join(DIR, 'rig.bin')) && existsSync(join(DIR, 'anatomy.json'))

  describe.skipIf(!present)(`via-point gate (${bodyId})`, () => {
    it('with via points: no more inversions or stretch, no less bone coverage', { timeout: 60_000 }, async () => {
      const rows = await checkBody(bodyId)
      expect(rows.map((r) => r.pose)).toEqual(['flex90', 'flex135', 'squat'])
      for (const r of rows) {
        const at = `${r.body} ${r.pose}`
        expect(r.inverted[1], `${at}: inverted triangles`).toBeLessThanOrEqual(r.inverted[0])
        expect(r.stretchP99[1], `${at}: edge stretch p99`).toBeLessThanOrEqual(r.stretchP99[0])
        expect(r.stretchMax[1], `${at}: edge stretch max`).toBeLessThanOrEqual(r.stretchMax[0])
        for (const k of ['anteriorFemur', 'patella', 'posteriorCondyles'] as const) expect(r.coverage[k][1], `${at}: coverage of ${k}`).toBeGreaterThanOrEqual(r.coverage[k][0])
      }
    })
  })
}
