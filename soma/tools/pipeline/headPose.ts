// 头的重新摆位：把颅骨（连同下颌骨、牙和头部软组织）绕寰枕关节刚性转一个角（屈或伸），使眶耳平面水平。
// 这里只找关节和标志点、给出旋转；软组织怎么跟见 headWarp.ts。
//   寰枕关节：枕骨与寰椎上关节面之间的接触区，左右各一；屈伸轴取过两个接触区中心的直线。
//   眶耳平面（Frankfurt 平面）：左右耳门上点（porion，骨性外耳道口上缘）和眶下点（orbitale，眶下缘最低点）。
//   角度是一个钉住的构建常数（PINNED_HEAD_FLEXION，做法同 female.ts 的 PINNED_ARM_ABDUCTION）：骨架指纹随它而变，
//   所以不能让它跟着输入的小变化跳动；每次构建仍然量眶耳平面在摆位前后的倾角并写进报告。
//
// Re-posing the head: one rigid rotation of the skull (with the mandible, the teeth and the soft parts of the head)
// about the flexion-extension axis of the atlanto-occipital joint, bringing the Frankfurt plane to the horizontal. This
// file only finds the joint and the landmarks and gives the rotation; how the soft tissue follows is in headWarp.ts.
//   Atlanto-occipital joint: the contact zones between the occipital bone and the superior articular facets of the
//   atlas, one on each side; the flexion axis is the line through the centres of both zones.
//   Frankfurt plane: porion (upper rim of the bony external acoustic meatus) and orbitale (lowest point of the
//   infraorbital margin) of both sides.
//   The angle is a pinned build constant (PINNED_HEAD_FLEXION, as PINNED_ARM_ABDUCTION in female.ts): the skeleton
//   fingerprint depends on it, so it must not jump with small changes of the input; every build still measures the
//   tilt of the Frankfurt plane before and after the re-pose and reports it.

import type { Mesh } from './geometry.ts'
import { PointIndex, surfacePoints, thinPoints } from './register.ts'
import { aboutPoint, contactZone, rotationFromVector, type RigidT, type V3 } from './shoulder.ts'

const DEG = 180 / Math.PI
const r1 = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d

/**
 * 头绕寰枕关节的转角（度；正 = 前屈，负 = 后伸），钉住的构建常数，以及定这个数时量到的值
 * （2026-10-13，在她重新摆位之前的骨上）。现在的值是 −5°：后伸 5°。
 * 两条判据给出同一个方向和相近的大小：
 *   1. 眶耳平面（porion → orbitale，按本文件的找法）在摆位之前前端低 5.4°（左 −5.1°、右 −5.7°）；后伸 5° 之后是 −0.4°，即水平。
 *   2. 与皮肤模型放平的头对齐：头顶保持在身高处、寰枕关节不动、整头只能在水平面内平移时，对面部和眶周的标志点
 *      （皮肤标志点减软组织厚度）及两个眼球中心做最小二乘，最优是后伸 5.2°，整头平移 x +3.5 mm、z −26.3 mm，
 *      残差均方根 10.1 mm（不转时 13.2 mm）。
 * 与任务说明里预期的方向相反（预期前屈 7–11°）。那个预期来自上一版皮肤拟合里头的俯仰角（上仰 10.9°），不是从骨上量的：
 * 那一版皮肤把耳放在她骨性外耳道口下方约 30 mm 处。她是仰卧扫描，头垫高时颅骨相对颈椎是前屈的，后伸是把它放回来。
 * 需要知道的另外两点：
 *   · 如果允许整头同时上下平移（即不守住身高），最吻合的反而是前屈 5.6°、头下移 20 mm，残差只有 3.8 mm：
 *     她面颅的形状与模型的脸很接近，差的是她眼以上的颅顶比模型的高约 10–20 mm。守住身高 1.6155 m 时这段高度差
 *     只能由形变吸收（面部相对寰枕关节上移约 10 mm，颅顶压低）。骨架标准化时头的缩放本来想取 0.896，被限制在 0.97。
 *   · 两副颅骨的颞骨都很粗（约 800 个三角形），耳门上点有几毫米的不确定；男性的颅骨按同样的找法是 −9.5°。
 *     所以这个角有 ±4° 左右的不确定，是建模上的选择，不是测量结果。
 * 活动范围的出处（本轮打开读到的）：Zhou C 等 2020, J Biomech 98:109418, doi:10.1016/j.jbiomech.2019.109418
 * （PMC6938025，作者稿）：活体颈部屈伸动作中 C0–C1 的屈伸活动范围 6.3 ± 1.6°；同文引 Panjabi 等 1988 的离体值
 * 约 24.5°（那篇没有打开）。5° 在两者之内。她现在处于这个范围的什么位置不知道（仰卧 CT，没有中立位的参照）。
 *
 * The rotation of the head about the atlanto-occipital joint in degrees (positive = flexion, negative = extension), a
 * pinned build constant, with what was measured when it was chosen (2026-10-13, on her bones before the re-pose).
 * The present value is −5°: an extension by 5°.
 * Two criteria give the same direction and nearly the same size:
 *   1. The Frankfurt plane (porion → orbitale, found the way this file finds them) dips 5.4° towards the front before
 *      the re-pose (left −5.1°, right −5.7°); after an extension by 5° it reads −0.4°, i.e. horizontal.
 *   2. Matching the levelled head of the skin model: with the top of the head held at the stature, the
 *      atlanto-occipital joint fixed and the head free to translate horizontally only, a least-squares fit over the
 *      landmarks of face and orbits (skin landmark minus soft-tissue depth) and the two globe centres has its optimum
 *      at an extension of 5.2°, head translation x +3.5 mm and z −26.3 mm, RMS residual 10.1 mm (13.2 mm without
 *      rotation).
 * This is the opposite of what the task statement expected (7–11° of flexion). That expectation came from the pitch of
 * the head in the previous skin fit (10.9° face-up) and was not measured on bone: that skin put the ear about 30 mm
 * below her bony external acoustic meatus. She was scanned supine; with the head raised on a support the skull is
 * flexed on the cervical spine, and the extension puts it back.
 * Two more things to know:
 *   · If the head were also free to move vertically (i.e. the stature not held), the best match would be a FLEXION of
 *     5.6° with the head 20 mm lower, and a residual of only 3.8 mm: the shape of her facial skeleton is close to the
 *     model's face, and what differs is that her vault above the eyes is some 10–20 mm taller than the model's. With
 *     the stature held at 1.6155 m that height can only be taken up by the warp (the face moves up by about 10 mm
 *     against the atlanto-occipital joint and the vault is lowered). The skeleton standardisation wanted a head scale
 *     of 0.896 and was limited to 0.97.
 *   · The temporal bones of both skulls are coarse (about 800 triangles) and porion is uncertain by a few
 *     millimetres; the male skull reads −9.5° by the same rule. The angle is therefore uncertain by about ±4° and is
 *     a modelling choice, not a measurement.
 * Source of the range (opened and read this round): Zhou C et al. 2020, J Biomech 98:109418,
 * doi:10.1016/j.jbiomech.2019.109418 (PMC6938025, author manuscript): the flexion-extension range of C0-C1 during
 * in vivo neck flexion-extension is 6.3 ± 1.6°; the same text quotes about 24.5° in vitro from Panjabi et al. 1988
 * (not opened). 5° is inside both. Where in that range she is now is not known (a supine CT, no neutral reference).
 *
 * 2026-10-14 改定：角改为 0°（不转头），身高改钉在 1.606 m（PINNED_FEMALE_STATURE）。上面的后伸 5° 是守住 1.6155 m 时的结果：
 * 那时面颅被形变相对寰枕关节上抬约 10 mm。身高放开后同一个最小二乘把头往下放；身高限制在 1.606 m ± 3 mm 之内时，
 * 1.606 m 处最吻合的转角是 −0.06°，残差 6.2 mm（1.609 m：−1.67°、7.4 mm；1.603 m：+1.54°、5.1 mm）。
 * 眶耳平面于是保持她原来的 −5.4°（男性颅骨按同样的找法是 −9.5°，所以这条判据本来就弱）。
 * 用同一份部件快照试算的结果（后伸 5°、1.6155 m → 0°、1.606 m）：形变的局部尺度最小值 0.22 → 0.50，下颌体长 −12 % → −8.5 %，
 * 各骨非刚性位移的均方根大多降了三分之一到一半；代价是颅顶压得更多（颅顶点—鼻根 −4.1 % → −7.1 %）。
 *
 * Revised 2026-10-14: the angle is now 0° (the head is not turned) and the stature is pinned at 1.606 m
 * (PINNED_FEMALE_STATURE). The extension by 5° above was the outcome with 1.6155 m held, when the warp lifted the facial
 * skeleton about 10 mm against the atlanto-occipital joint. With the stature released the same least-squares fit lowers
 * the head; inside 1.606 m ± 3 mm the best rotation at 1.606 m is −0.06° with a residual of 6.2 mm (1.609 m: −1.67°,
 * 7.4 mm; 1.603 m: +1.54°, 5.1 mm). The Frankfurt plane therefore keeps her −5.4° (the male skull reads −9.5° by the
 * same rule, so that criterion was weak to begin with).
 * Trial on one part snapshot (5° extension at 1.6155 m → 0° at 1.606 m): least local scale of the warp 0.22 → 0.50,
 * mandibular body length −12 % → −8.5 %, RMS non-rigid displacement of most bones down by a third to a half; the price
 * is a flatter vault (vertex–nasion −4.1 % → −7.1 %).
 */
export const PINNED_HEAD_FLEXION = {
  angleDeg: 0,
  reason: {
    zh: '钉在 0°（不转头）：身高钉在 1.606 m 时，与皮肤模型放平的头做标志点最小二乘，最吻合的转角是 −0.06°。原来的后伸 5° 是守住 1.6155 m 时的结果。骨架指纹取决于它，不能随输入的小变化跳动。',
    en: 'pinned at 0° (the head is not turned): with the stature pinned at 1.606 m the least-squares match of the landmarks to the levelled head of the skin model has its best rotation at −0.06°. The earlier extension by 5° was the outcome with 1.6155 m held. The skeleton fingerprint depends on it and must not jump with small changes of the input.',
  },
  revised: { on: '2026-10-14', previousAngleDeg: -5, bestRotationDeg_rmsMm_byStatureM: { '1.609': [-1.67, 7.4], '1.6075': [-0.87, 6.8], '1.606': [-0.06, 6.2], '1.6045': [0.74, 5.6], '1.603': [1.54, 5.1] } },
  measuredWhenPinned: {
    frankfurtRiseBeforeDeg: { left: -5.14, right: -5.66, mean: -5.4 },
    frankfurtRiseOfTheMaleSkullDeg: -9.47,
    bestFitToTheLevelHead: { statureHeld: { rotationDeg: -5.16, headShiftMm: { x: 3.5, z: -26.3 }, rmsResidualMm: 10.1, rmsWithoutRotationMm: 13.2 }, headFreeToMoveVertically: { rotationDeg: 5.59, headShiftMm: { x: 3.5, y: -20.1, z: -24.7 }, rmsResidualMm: 3.8 } },
    landmarksOfTheFit: 'face and orbit landmarks of landmarks.json with a bone point, without the loosely paired ones (zygion, gonion, mid-ramus, mastoid, euryon, subnasale) and without vertex and opisthocranion, plus both globe centres',
    uncertaintyDeg: 4,
  },
  range: {
    source: 'Zhou C et al. 2020, J Biomech 98:109418, doi:10.1016/j.jbiomech.2019.109418 (PMC6938025, author manuscript; opened 2026-10-13)',
    inVivoFlexionExtensionRomDeg: { mean: 6.3, sd: 1.6 },
    inVitroFlexionExtensionRomDeg: 24.5,
    inVitroNote: 'as quoted there from Panjabi et al. 1988, which was not opened',
  },
  /** 超过它就不做，构建报错 / beyond this the build fails instead of re-posing */
  maxDeg: 15,
}

/**
 * 钉住的女性身高（米）：头的外形（head_outline.py --stature）按它放置。项目的标准女性身高是 1.606 m；已发布的皮肤是 1.6155 m，
 * 只因为原来的头贴着她偏高的颅顶。不加限制时标志点的吻合会把头一直放到 1.5955 m（并前屈 5.6°）；协调者定的范围是 1.606 m ± 3 mm，
 * 这里取 1.606 m 本身（此处不必转头）。她的颅顶仍比模型的高约 11 mm，由颅顶的形变吸收。头模型放上去后实际量到的身高写在报告里。
 * The pinned female stature (m): the head outline (head_outline.py --stature) is placed by it. The project's standard
 * female stature is 1.606 m; the shipped skin stands 1.6155 m only because the old head lay on her tall vault. Unbounded,
 * the landmark match would lower the head to 1.5955 m (with 5.6° of flexion); the coordinator set the range
 * 1.606 m ± 3 mm and 1.606 m itself is taken (no rotation is needed there). Her vault is still about 11 mm taller than
 * the model's, which the warp of the vault takes up. The stature actually measured on the outline goes into the report.
 */
export const PINNED_FEMALE_STATURE = { statureM: 1.606, toleranceM: 0.003, previousM: 1.6155, vertexBoneAboveItsTargetMm: 11.2, decidedBy: 'coordinator, 2026-10-14: natural fit constrained to 1.606 m ± 3 mm' }

/** 属于头、随寰枕关节一起转的骨（按名称） / the bones that belong to the head and turn about the atlanto-occipital joint (by name) */
export const HEAD_BONE = /^(Frontal bone|Occipital bone|Sphenoid bone|Ethmoid|Vomer|Mandible|(Left|Right) (parietal bone|temporal bone|zygomatic bone|nasal bone|maxilla|lacrimal bone|palatine bone|inferior nasal concha))$/

export interface AtlantoOccipital {
  /** 左、右接触区的中心 / centres of the left and right contact zones */
  left: V3
  right: V3
  /** 屈伸轴：单位向量，由右指向左 / the flexion axis: unit vector from right to left */
  axis: V3
  /** 两侧关节间隙（毫米）：最小值和中位数 / joint gaps on both sides (mm): least and median */
  gapMm: { left: { min: number; median: number }; right: { min: number; median: number } }
}

/**
 * 寰枕关节：枕骨与寰椎的接触区（各自的最小间隙 + 2 mm 以内），左右各一。
 * The atlanto-occipital joint: the contact zones of occipital bone and atlas (within the least gap + 2 mm), one on each side.
 */
export function atlantoOccipitalJoint(occipital: Mesh, atlas: Mesh): AtlantoOccipital {
  const so = thinPoints(surfacePoints(occipital, 0.001), 0.0008)
  const sa = thinPoints(surfacePoints(atlas, 0.001), 0.0008)
  // 中线取寰椎左右范围的中点；离中线 4 mm 以内的不算（齿突、前后弓） / the midline is the middle of the atlas' left-right extent; within 4 mm of it nothing counts (dens, arches)
  let x0 = Infinity
  let x1 = -Infinity
  for (let i = 0; i < sa.length; i += 3) {
    x0 = Math.min(x0, sa[i]!)
    x1 = Math.max(x1, sa[i]!)
  }
  const xm = (x0 + x1) / 2
  const side = (pts: Float32Array, sg: number) => {
    const out: number[] = []
    for (let i = 0; i < pts.length; i += 3) if (sg * (pts[i]! - xm) > 0.004) out.push(pts[i]!, pts[i + 1]!, pts[i + 2]!)
    return Float32Array.from(out)
  }
  const zone = (sg: number) => contactZone(side(so, sg), new PointIndex(side(sa, sg), 0.004), 0.002, 0.02)
  const L = zone(1)
  const R = zone(-1)
  const d: V3 = [L.centre[0] - R.centre[0], L.centre[1] - R.centre[1], L.centre[2] - R.centre[2]]
  const l = Math.hypot(d[0], d[1], d[2])
  return { left: L.centre, right: R.centre, axis: [d[0] / l, d[1] / l, d[2] / l], gapMm: { left: { min: r1(L.min * 1000, 2), median: r1(L.median * 1000, 2) }, right: { min: r1(R.min * 1000, 2), median: r1(R.median * 1000, 2) } } }
}

/**
 * 网格在 (y, z) 处最靠外侧的面的 |x|（side = +1 左、−1 右）；没有碰到时为 NaN。
 * |x| of the most lateral surface of a mesh at (y, z) (side = +1 left, −1 right); NaN where the mesh is not met.
 */
export function lateralDepth(mesh: Mesh, side: 1 | -1, y: number, z: number): number {
  const p = mesh.positions
  const I = mesh.indices
  let best = -Infinity
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t]!
    const b = 3 * I[t + 1]!
    const c = 3 * I[t + 2]!
    const w0 = (p[b + 1]! - y) * (p[c + 2]! - z) - (p[b + 2]! - z) * (p[c + 1]! - y)
    const w1 = (p[c + 1]! - y) * (p[a + 2]! - z) - (p[c + 2]! - z) * (p[a + 1]! - y)
    const w2 = (p[a + 1]! - y) * (p[b + 2]! - z) - (p[a + 2]! - z) * (p[b + 1]! - y)
    if (!((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0))) continue
    const s = w0 + w1 + w2
    if (s === 0) continue
    const x = (side * (w0 * p[a]! + w1 * p[b]! + w2 * p[c]!)) / s
    if (x > best) best = x
  }
  return best === -Infinity ? NaN : best
}

/**
 * 耳门上点：从外侧看颞骨的深度图上最深的凹陷（骨性外耳道口），沿 +y 走到骨面回到外表面处，即道口的上缘。
 * 凹陷的评分 = 周围 8 mm 处（八个方向）外表面 |x| 的中位数 − 本格的 |x|；只在颞骨上下各去掉 12 mm 的范围内找。
 * Porion: the deepest pit of the temporal bone's depth map seen from lateral (the bony external acoustic meatus),
 * followed along +y to where the bone returns to the outer surface, i.e. the upper rim of the meatus. A cell's pit
 * score = median |x| of the outer surface 8 mm around it (eight directions) − its own |x|; searched in the temporal
 * bone less 12 mm at the top and at the bottom.
 */
export function porion(temporal: Mesh, side: 1 | -1): { point: V3; pit: V3; pitDepthMm: number } {
  const p = temporal.positions
  let y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (let i = 0; i < p.length; i += 3) {
    y0 = Math.min(y0, p[i + 1]!)
    y1 = Math.max(y1, p[i + 1]!)
    z0 = Math.min(z0, p[i + 2]!)
    z1 = Math.max(z1, p[i + 2]!)
  }
  const H = 0.001
  const ny = Math.ceil((y1 - y0) / H) + 1
  const nz = Math.ceil((z1 - z0) / H) + 1
  const D = new Float32Array(ny * nz)
  for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) D[j * nz + k] = lateralDepth(temporal, side, y0 + j * H, z0 + k * H)
  const at = (j: number, k: number) => (j < 0 || k < 0 || j >= ny || k >= nz ? NaN : D[j * nz + k]!)
  const RING = [[8, 0], [-8, 0], [0, 8], [0, -8], [6, 6], [6, -6], [-6, 6], [-6, -6]] as const
  let best = { score: -Infinity, j: 0, k: 0 }
  for (let j = 12; j < ny - 12; j++) for (let k = 0; k < nz; k++) {
    const d = at(j, k)
    if (Number.isNaN(d)) continue
    const ring = RING.map(([a, b]) => at(j + a, k + b)).filter((v) => !Number.isNaN(v)).sort((a, b) => a - b)
    if (ring.length < 6) continue
    const score = ring[ring.length >> 1]! - d
    if (score > best.score) best = { score, j, k }
  }
  // 上缘：自凹陷向上，第一格 |x| 回到“上方 8 mm 处外表面 − 2 mm”以内的 / the upper rim: going up from the pit, the first cell whose |x| is back within 2 mm of the outer surface 8 mm above
  const surface = at(best.j + 8, best.k)
  let j = best.j
  while (j < best.j + 8 && !(at(j, best.k) >= surface - 0.002)) j++
  const x = at(j, best.k)
  return { point: [side * x, y0 + j * H, z0 + best.k * H], pit: [side * at(best.j, best.k), y0 + best.j * H, z0 + best.k * H], pitDepthMm: r1(best.score * 1000) }
}

/**
 * 眶下点：眶下缘的最低点。在眼球中心下方、左右 ±12 mm 以内每隔 1 mm 取一个矢状切面，切面上上颌骨和颧骨的点里
 * (y + z) 最大的一个是该处的眶缘嵴（由朝上的眶底转为朝前的面颊面之处）；各切面的嵴点里最低的即眶下点。
 * Orbitale: the lowest point of the infraorbital margin. In sagittal slices 1 mm apart within ±12 mm of the globe
 * centre, below it, the point of maxilla and zygomatic bone with the largest (y + z) is the crest of the margin
 * there (where the orbital floor, facing up, turns into the anterior surface, facing forwards); the lowest of these
 * crest points is orbitale.
 */
export function orbitale(bones: Mesh[], globe: V3): V3 {
  const pts = thinPoints(Float32Array.from(bones.flatMap((m) => Array.from(surfacePoints(m, 0.0007)))), 0.0005)
  let low: V3 | null = null
  for (let dx = -0.012; dx <= 0.012001; dx += 0.001) {
    let crest: V3 | null = null
    let s = -Infinity
    for (let i = 0; i < pts.length; i += 3) {
      if (Math.abs(pts[i]! - globe[0] - dx) > 0.001) continue
      const y = pts[i + 1]!
      const z = pts[i + 2]!
      if (y > globe[1] - 0.006 || y < globe[1] - 0.03 || z < globe[2] - 0.005) continue
      if (y + z > s) {
        s = y + z
        crest = [pts[i]!, y, z]
      }
    }
    if (crest && (!low || crest[1] < low[1])) low = crest
  }
  if (!low) throw new Error('orbitale: no infraorbital margin found under the globe')
  return low
}

export interface FrankfurtPlane {
  porion: { left: V3; right: V3 }
  orbitale: { left: V3; right: V3 }
  /** 眶耳平面前端上翘的角（度，矢状面内；正 = 面朝上） / rise of the Frankfurt plane towards the front (degrees, in the sagittal plane; positive = face up) */
  riseDeg: { left: number; right: number; mean: number }
  /** 外耳道凹陷的深度：太浅说明没有找到道口 / depth of the meatus pits: a shallow one means the meatus was not found */
  meatusPitDepthMm: { left: number; right: number }
}

export function frankfurtPlane(b: { temporalL: Mesh; temporalR: Mesh; infraorbitalL: Mesh[]; infraorbitalR: Mesh[]; globeL: V3; globeR: V3 }): FrankfurtPlane {
  const pl = porion(b.temporalL, 1)
  const pr = porion(b.temporalR, -1)
  const ol = orbitale(b.infraorbitalL, b.globeL)
  const or = orbitale(b.infraorbitalR, b.globeR)
  const rise = (p: V3, o: V3) => Math.atan2(o[1] - p[1], o[2] - p[2]) * DEG
  const l = rise(pl.point, ol)
  const r = rise(pr.point, or)
  return { porion: { left: pl.point, right: pr.point }, orbitale: { left: ol, right: or }, riseDeg: { left: r1(l, 2), right: r1(r, 2), mean: r1((l + r) / 2, 2) }, meatusPitDepthMm: { left: pl.pitDepthMm, right: pr.pitDepthMm } }
}

/**
 * 绕寰枕关节屈伸轴前屈 `angleDeg`（正 = 低头，面部向下向前）的刚性变换。
 * 轴由右指向左（+X），前屈是绕它的正向旋转（见函数内的说明）。
 * The rigid transform of a flexion by `angleDeg` about the flexion axis of the atlanto-occipital joint (positive = nodding,
 * the face goes down). The axis runs from right to left (+X) and flexion is the positive rotation about it (see inside).
 */
export function headFlexion(joint: AtlantoOccipital, angleDeg: number): RigidT {
  const a = angleDeg / DEG
  // 右手定则：绕 +X 转 +θ，(0,0,1) → (0, −sin θ, cos θ)：前方的点下降，即前屈 / right-hand rule: by +θ about +X, (0,0,1) → (0, −sin θ, cos θ): a point in front goes down, which is flexion
  const r = rotationFromVector([joint.axis[0] * a, joint.axis[1] * a, joint.axis[2] * a])
  const pivot: V3 = [(joint.left[0] + joint.right[0]) / 2, (joint.left[1] + joint.right[1]) / 2, (joint.left[2] + joint.right[2]) / 2]
  return aboutPoint(r, pivot)
}
