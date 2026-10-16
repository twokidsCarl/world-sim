// 肩部的权重：外部（MHR）皮肤权重换到本骨架之后的一处修正（girdleSplit）。抬臂时的拉伸和穿出不能只靠权重解决，剩下的由姿势校正形处理
// （tools/rig/corrective.ts）。试过、没有采用的（数字见 README）：把上臂到躯干的过渡沿皮肤摊宽（皮肤离开身体好几厘米）；肩部皮肤改随其下的
// 组织（拉伸更大）；浅层组织（脂肪、筋膜、背阔肌、皮神经）随皮肤（它们在皮下被剪切，最大边拉伸成倍增加）。
// Weights of the shoulder: one correction of the external (MHR) skin weights after they are mapped onto this rig
// (girdleSplit). Weights alone cannot settle the stretch and the parts coming through on raising the arm; the rest is left to
// the pose-corrective shapes (tools/rig/corrective.ts). Tried and not adopted (numbers in the README): spreading the arm–trunk
// transition along the skin (the skin left the body by several centimetres); shoulder skin following the tissue beneath
// (more stretch); superficial tissues (fat, fasciae, latissimus dorsi, cutaneous nerves) following the skin (they were
// sheared under the skin and their largest edge stretch rose several-fold).
//
//   girdleSplit  MHR 的“锁骨”关节带着整个肩带（锁骨和肩胛骨）绕胸锁关节转；本骨架把肩带分成胸锁关节（锁骨）和肩锁关节
//                （肩胛骨，上回旋在这里）。原来的映射把它全给了胸锁关节，于是肩胛骨和肩上的皮肤不随肩胛骨上回旋：抬臂时
//                三角肌、肩锁关节囊和肱骨头从肩部的皮肤里穿出来。这里把那一份按体内距离场在锁骨和肩胛骨之间重新分。
//                MHR's "clavicle" joint carries the whole girdle (clavicle and scapula) about the sternoclavicular joint; this rig
//                splits the girdle into the sternoclavicular joint (clavicle) and the acromioclavicular joint (scapula, where the
//                upward rotation is). The mapping gave all of it to the sternoclavicular joint, so the skin over the scapula and
//                the shoulder did not follow the scapula's upward rotation, and on raising the arm deltoid, the capsule of the
//                acromioclavicular joint and the humeral head came through the skin of the shoulder. Here that share is split
//                again between clavicle and scapula by the in-body distance field.

import type { Candidates } from './field.ts'
import type { V3 } from './math.ts'

export interface GirdleSplit {
  /** 被重新分的关节（正则，第 1 组是侧别 L / R）/ The joint whose share is split again (regular expression, group 1 = side L / R). */
  from: string
  /** 分给哪些关节（正则，{S} 换成侧别）/ The joints it goes to (regular expression, {S} becomes the side). */
  among: string
  beta: number
  /**
   * 可选：在关节 joint（{S} 换成侧别）中心之前 from 到 to（米，沿 +z 朝前）之间，重新分的份额渐渐退回 from 关节，再往前不分：
   * 胸前的皮肤盖在锁骨、胸骨和胸大肌上，肩胛骨只有喙突在深处。
   * Optional: between `from` and `to` (m, along +z, forwards) in front of the centre of `joint` ({S} becomes the side) the
   * share split again fades back to the `from` joint, and further forwards nothing is split: the skin of the front of the
   * chest lies over clavicle, sternum and pectoralis major, and of the scapula only the coracoid process lies deep there.
   */
  front?: { joint: string; from: number; to: number }
  why?: { zh: string; en: string }
}

export interface FieldLike {
  query(p: V3, allow?: (joint: number) => boolean): Candidates
  euclid(p: V3, jointList: number[], max?: number): Candidates
}

/**
 * 把 from 关节上的份额按距离场在 among 关节之间重新分。rows 原地修改；返回改过的行数。
 * Splits the share on the `from` joint again among the `among` joints by the distance field. `rows` is changed in place;
 * returns the number of rows changed.
 */
export function splitGirdle(rows: Map<number, number>[], pos: Float32Array, cfg: GirdleSplit, jointIds: readonly string[], field: FieldLike, weights: (c: Candidates, out: Map<number, number>) => void, centres?: readonly V3[]): number {
  const re = new RegExp(cfg.from)
  const tmp = new Map<number, number>()
  let changed = 0
  jointIds.forEach((id, j) => {
    const m = re.exec(id)
    if (!m) return
    const reA = new RegExp(cfg.among.replace('{S}', m[1] ?? ''))
    const among = jointIds.flatMap((x, k) => (reA.test(x) ? [k] : []))
    if (among.length < 2) return
    const ok = new Set(among)
    const fi = cfg.front && centres ? jointIds.indexOf(cfg.front.joint.replace('{S}', m[1] ?? '')) : -1
    const z0 = fi >= 0 ? centres![fi]![2] + cfg.front!.from : Infinity, z1 = fi >= 0 ? centres![fi]![2] + cfg.front!.to : Infinity
    rows.forEach((row, i) => {
      const share = row.get(j)
      if (!share) return
      const p: V3 = [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!]
      let c = field.query(p, (k) => ok.has(k))
      // 体素场在这里只记最近的几个关节；都不在其中时取欧氏距离 / the voxel field keeps only the nearest few joints here; when none of them is among those, Euclidean distance
      if (!c.joints.length) c = field.euclid(p, among)
      weights(c, tmp)
      if (!tmp.size) return
      // 胸前渐渐不分 / fading out towards the front of the chest
      let g = 1
      if (p[2] > z0) {
        const t = Math.min(1, (p[2] - z0) / (z1 - z0))
        g = 1 - t * t * (3 - 2 * t)
      }
      if (g < 1) {
        for (const [k, w] of tmp) tmp.set(k, g * w)
        tmp.set(j, (tmp.get(j) ?? 0) + (1 - g))
      }
      row.delete(j)
      for (const [k, w] of tmp) if (w > 0) row.set(k, (row.get(k) ?? 0) + share * w)
      changed++
    })
  })
  return changed
}
