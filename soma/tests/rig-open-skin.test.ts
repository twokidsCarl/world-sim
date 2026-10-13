// 开口皮肤（真正的口裂、睑裂）的绑定：按下标而不是按位置。
// Binding of an opened skin (real oral and palpebral fissures): by index, not by position.

import { describe, expect, it } from 'vitest'
import { weld, weldByIndex } from '../tools/rig/bind.ts'
import { checkOpenSkin } from '../tools/rig/skin-open-check.ts'

describe('welding by source index', () => {
  // 两个三角形共用一条“口裂”：顶点 1 与 4、2 与 5 位置重合但属于上、下两片
  // two triangles meeting along a "fissure": vertices 1 & 4 and 2 & 5 coincide in position but belong to the upper and the lower sheet
  const positions = Float32Array.from([0, 1, 0, -1, 0, 0, 1, 0, 0, 0, -1, 0, -1, 0, 0, 1, 0, 0])
  const indices = Uint32Array.from([0, 1, 2, 3, 5, 4])

  it('keeps coincident vertices apart where welding by position sews them together', () => {
    const byPos = weld(positions, indices)
    expect(byPos.n).toBe(4)
    expect(byPos.map[1]).toBe(byPos.map[4])
    const byIdx = weldByIndex(positions, indices, Uint32Array.from([10, 11, 12, 13, 14, 15]))
    expect(byIdx.n).toBe(6)
    expect(byIdx.map[1]).not.toBe(byIdx.map[4])
    // 上片的顶点 1 只与上片相邻 / vertex 1 of the upper sheet has neighbours in the upper sheet only
    const nb = Array.from(byIdx.adj.subarray(byIdx.adjStart[byIdx.map[1]!]!, byIdx.adjStart[byIdx.map[1]! + 1]!))
    expect(nb.sort()).toEqual([byIdx.map[0]!, byIdx.map[2]!].sort())
    expect(Array.from(byIdx.source)).toEqual([10, 11, 12, 13, 14, 15])
  })

  it('merges vertices that share a source index even when they were split', () => {
    // GLB 在法线接缝处拆开的顶点：位置相同、来源下标也相同 / vertices split at a normal seam of the GLB: same position and same source index
    const m = weldByIndex(positions, indices, Uint32Array.from([10, 11, 12, 13, 11, 12]))
    expect(m.n).toBe(4)
    expect(m.map[1]).toBe(m.map[4])
  })
})

for (const bodyId of ['male', 'female'] as const) {
  const r = checkOpenSkin(bodyId)
  describe.skipIf(!r)(`opened skin package (${bodyId}), bound by index with the identity map`, () => {
    it('keeps the upper lip margin off the jaw and the lower lip margin fully on it', () => {
      expect(r!.marginPairs).toBeGreaterThan(30)
      expect(r!.byIndex.upperMaxJaw).toBe(0)
      expect(r!.byIndex.lowerMinJaw).toBe(1)
      expect(r!.byIndex.uniqueVertices).toBe(r!.vertices)
      // 按位置的老办法把成对的唇缘顶点焊在了一起 / the old position-based way welds the paired margin vertices together
      expect(r!.byPosition.marginPairsWelded).toBe(r!.marginPairs)
    })

    it('opens the mouth cleanly at 10° and 25° of jaw opening', () => {
      for (const p of r!.poses) {
        // 上唇缘不动；下唇缘随下颌刚性运动 / the upper margin does not move; the lower moves rigidly with the jaw
        expect(p.upperMaxMoveMm, `${p.degrees}°`).toBeLessThan(0.01)
        expect(p.lowerMaxDeviationMm, `${p.degrees}°`).toBeLessThan(0.01)
        // 每一对唇缘顶点都分开了，开口宽度均匀 / every pair has parted and the opening is even
        expect(p.gapMinMm).toBeGreaterThan(p.degrees * 1.2)
        expect(p.gapMaxMm / p.gapMinMm).toBeLessThan(1.25)
      }
      expect(r!.poses[1]!.gapMidMm).toBeGreaterThan(2 * r!.poses[0]!.gapMidMm)
    })
  })
}
