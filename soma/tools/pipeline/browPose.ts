// 眉的重新摆位：她的眉是男性的部件形变来的（粗、平、低）。头换成参数化头模型的女性头之后，把它搬到新眉弓上并收细。
// 位置和粗细取自头的外形目录 landmarks.json 的 browStandIn——那是皮肤作者渲染用的替身，是假定值，没有打开过女性眉位置的文献表。
// 做法（左右各做一次，在正面的平面里）：u = 离眼关节的外侧偏移，v = 高于眼关节的高度（毫米）。
//   原眉的 u 范围线性映到替身的 u 范围；原眉在每个 u 处的中线和半宽由分箱得到；
//   新的 v = 替身中线(u′) + (v − 原中线(u)) / 原半宽(u) × 替身半宽(u′)；
//   前后方向：保持它相对皮肤前表面的距离（搬之前和之后各向皮肤投一次）。之后仍由 appendages.ts 贴合到皮肤上。
//
// Re-posing the eyebrow: hers is the male part warped (thick, straight and low). With the head now the parametric model's
// female head it is moved onto the new brow and thinned. Position and thickness come from browStandIn in landmarks.json of
// the head outline — the stand-in the skin's author drew in the renders, an ASSUMPTION: no published table of female brow
// position was opened.
// Method (each side on its own, in the frontal plane): u = lateral offset from the eye joint, v = height above it (mm).
//   The u-range of the present brow is mapped linearly onto that of the stand-in; centre line and half width of the present
//   brow at each u come from bins;
//   new v = stand-in centre(u′) + (v − present centre(u)) / present half width(u) × stand-in half width(u′);
//   front to back it keeps its distance to the front surface of the skin (one projection onto the skin before the move and
//   one after). appendages.ts conforms it to the skin afterwards as before.

import type { Mesh } from './geometry.ts'

export interface BrowStandIn {
  bandOnTheRestHead_mmFromEyeJoint: { lateralOffset_u: number[]; centreHeightAboveEyeCentre: number[]; halfWidth_at_u: Record<string, number> }
}

const interp = (x: number, xs: number[], ys: number[]): number => {
  if (x <= xs[0]!) return ys[0]!
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]!) return ys[i - 1]! + ((x - xs[i - 1]!) / (xs[i]! - xs[i - 1]!)) * (ys[i]! - ys[i - 1]!)
  return ys[ys.length - 1]!
}

/** 皮肤前表面在 (x, y) 处的 z（最靠前的交点）；没有交点时为 NaN / z of the front surface of the skin at (x, y) (the foremost hit); NaN without one */
function frontZ(tris: Float32Array, x: number, y: number): number {
  let best = -Infinity
  for (let t = 0; t < tris.length; t += 9) {
    const ax = tris[t]!, ay = tris[t + 1]!, bx = tris[t + 3]!, by = tris[t + 4]!, cx = tris[t + 6]!, cy = tris[t + 7]!
    const w0 = (bx - x) * (cy - y) - (by - y) * (cx - x)
    const w1 = (cx - x) * (ay - y) - (cy - y) * (ax - x)
    const w2 = (ax - x) * (by - y) - (ay - y) * (bx - x)
    if (!((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0))) continue
    const s = w0 + w1 + w2
    if (s === 0) continue
    const z = (w0 * tris[t + 2]! + w1 * tris[t + 5]! + w2 * tris[t + 8]!) / s
    if (z > best) best = z
  }
  return best === -Infinity ? NaN : best
}

export interface BrowPoseResult {
  mesh: Mesh
  report: Record<string, unknown>
}

/**
 * 把眉部件搬到替身的位置并收细；`eyes` 是皮肤包的眼关节。返回新网格和报告（搬之前、之后的高度和半宽）。
 * Moves the eyebrow part to the stand-in's place and thins it; `eyes` are the eye joints of the skin package. Returns the new mesh and
 * a report (height and half width before and after).
 */
export function reposeEyebrow(brow: Mesh, skin: Mesh, eyes: { L: readonly number[]; R: readonly number[] }, standIn: BrowStandIn, onSkin?: number): BrowPoseResult {
  const B = standIn.bandOnTheRestHead_mmFromEyeJoint
  const hwU = Object.keys(B.halfWidth_at_u).map(Number).sort((a, b) => a - b)
  const hwV = hwU.map((u) => B.halfWidth_at_u[String(u)]!)
  const U0 = B.lateralOffset_u[0]!
  const U1 = B.lateralOffset_u[B.lateralOffset_u.length - 1]!
  // 眉附近、朝前的皮肤三角形 / the forward-facing skin triangles near the brows
  const box = { x: 0.075, y0: Math.min(eyes.L[1]!, eyes.R[1]!) - 0.005, y1: Math.max(eyes.L[1]!, eyes.R[1]!) + 0.045, z: Math.min(eyes.L[2]!, eyes.R[2]!) - 0.03 }
  const near: number[] = []
  const P = skin.positions
  for (let t = 0; t < skin.indices.length; t += 3) {
    const i = [3 * skin.indices[t]!, 3 * skin.indices[t + 1]!, 3 * skin.indices[t + 2]!]
    if (i.every((a) => Math.abs(P[a]!) < box.x && P[a + 1]! > box.y0 && P[a + 1]! < box.y1 && P[a + 2]! > box.z)) for (const a of i) near.push(P[a]!, P[a + 1]!, P[a + 2]!)
  }
  const tris = Float32Array.from(near)
  const out = new Float32Array(brow.positions)
  const n = brow.positions.length / 3
  const rows: Record<string, unknown> = {}
  let unprojected = 0
  for (const [S, sg] of [['L', 1], ['R', -1]] as const) {
    const e = eyes[S]
    const idx: number[] = []
    for (let i = 0; i < n; i++) if (sg * brow.positions[3 * i]! > 0) idx.push(i)
    if (idx.length < 20) continue
    const u = idx.map((i) => sg * (brow.positions[3 * i]! - e[0]!) * 1000)
    const v = idx.map((i) => (brow.positions[3 * i + 1]! - e[1]!) * 1000)
    const uMin = Math.min(...u)
    const uMax = Math.max(...u)
    // 分箱：每箱的中线 = (最低 + 最高) / 2，半宽 = (最高 − 最低) / 2 / bins: centre = (lowest + highest) / 2, half width = (highest − lowest) / 2
    const NB = 8
    const lo = new Array<number>(NB).fill(Infinity)
    const hi = new Array<number>(NB).fill(-Infinity)
    const binOf = (x: number) => Math.min(NB - 1, Math.max(0, Math.floor(((x - uMin) / (uMax - uMin)) * NB)))
    u.forEach((x, k) => {
      const b = binOf(x)
      lo[b] = Math.min(lo[b]!, v[k]!)
      hi[b] = Math.max(hi[b]!, v[k]!)
    })
    const bu: number[] = []
    const bc: number[] = []
    const bh: number[] = []
    for (let b = 0; b < NB; b++) if (hi[b]! > -Infinity) {
      bu.push(uMin + ((b + 0.5) / NB) * (uMax - uMin))
      bc.push((lo[b]! + hi[b]!) / 2)
      bh.push(Math.max(0.3, (hi[b]! - lo[b]!) / 2))
    }
    idx.forEach((i, k) => {
      const u2 = U0 + ((u[k]! - uMin) / (uMax - uMin)) * (U1 - U0)
      const rel = Math.max(-1, Math.min(1, (v[k]! - interp(u[k]!, bu, bc)) / interp(u[k]!, bu, bh)))
      const v2 = interp(u2, B.lateralOffset_u, B.centreHeightAboveEyeCentre) + rel * interp(u2, hwU, hwV)
      const x0 = brow.positions[3 * i]!
      const y0 = brow.positions[3 * i + 1]!
      const x1 = e[0]! + (sg * u2) / 1000
      const y1 = e[1]! + v2 / 1000
      const z0 = frontZ(tris, x0, y0)
      const z1 = frontZ(tris, x1, y1)
      if (Number.isNaN(z0) || Number.isNaN(z1)) unprojected++
      out[3 * i] = x1
      out[3 * i + 1] = y1
      // onSkin 给了：整个壳贴在皮肤前表面之外这么远（米），不再保留它原来相对皮肤的深度——原来的壳有八成埋在皮肤下，看上去是断开的几段
      // with onSkin: the whole shell lies this far (m) in front of the skin instead of keeping its former depth - four fifths of the former shell lay under the skin and it read as broken dashes
      out[3 * i + 2] = onSkin !== undefined && !Number.isNaN(z1) ? z1 + onSkin : brow.positions[3 * i + 2]! + (Number.isNaN(z0) || Number.isNaN(z1) ? 0 : z1 - z0)
    })
    const r1 = (x: number) => Math.round(x * 10) / 10
    rows[S] = { vertices: idx.length, before: { lateralOffsetMm: [r1(uMin), r1(uMax)], centreHeightAboveEyeJointMm: bc.map(r1), halfWidthMm: bh.map(r1) }, after: { lateralOffsetMm: [U0, U1], centreHeightAboveEyeJointMm: B.centreHeightAboveEyeCentre, halfWidthMm: hwV, at_u: { centre: B.lateralOffset_u, halfWidth: hwU } } }
  }
  return { mesh: { positions: out, indices: brow.indices }, report: { applied: true, ...(onSkin !== undefined ? { onSkinMm: onSkin * 1000, onSkinRule: 'every vertex is put this far in front of the front surface of the skin (the shell has no thickness of its own)' } : {}), rule: 'the male-derived eyebrow part moved in the frontal plane onto browStandIn of the head outline (lateral range mapped linearly, centre line and half width replaced by the stand-in\'s) keeping its distance to the front of the skin; then conformed to the skin as every appendage', assumption: 'browStandIn is the stand-in strip of the skin author\'s renders (head and tail heights, peak 14 mm lateral to the pupil, 4 to 1.4 mm wide): an assumption, no published table of female brow position was opened; the head scale of the outline (about 2 %) is not applied to it', sides: rows, verticesWithoutASkinProjection: unprojected } }
}

/**
 * 眉线的规则（女性）：下缘相对眶上缘的高度取自 Sclafani & Jung 2010, Arch Facial Plast Surg 12(2):123-127, doi:10.1001/archfacial.2010.17
 * 的摘要（2026-10-14 在机构的文献记录页上读到；正文没有打开）：女性希望眉的下缘在内眦处“略低于眶缘”、瞳孔中线处“在眶缘上”、
 * 外眦处“高于眶缘数毫米”，眉峰“在外眦稍内侧”。摘要没有给毫米数：这里取 −1、0、+3 mm（假定）；眉梢回到眶缘高度、眉宽（内侧 6 mm，
 * 向外收到 1.6 mm）也是假定。u = 离眼关节的外侧偏移（毫米）：内眦约 −15，外眦约 +14（假定）。
 * The rule of the brow line (women): the height of its lower border above the supraorbital rim is from the abstract of Sclafani & Jung
 * 2010, Arch Facial Plast Surg 12(2):123-127, doi:10.1001/archfacial.2010.17 (read on 2026-10-14 on an institutional record page; the
 * paper itself was not opened): women wanted the lower border "just below the orbital rim at the medial canthus, at the rim at the
 * midpupillary line and several millimeters above the rim at the lateral canthus", the peak "just medial to the lateral canthus". The
 * abstract gives no millimetres: -1, 0 and +3 mm are taken here (ASSUMPTIONS); that the tail returns to the level of the rim, and the
 * width (6 mm medially, tapering to 1.6 mm), are assumptions as well. u = lateral offset from the eye joint (mm): medial canthus about
 * -15, lateral canthus about +14 (assumed).
 */
export const BROW_RULE = {
  u: [-16, -8, 0, 8, 12, 14, 20, 27],
  lowerBorderAboveRimMm: [-1, -0.5, 0, 1.5, 3, 3, 2, 0],
  halfWidthMm: [3, 2.9, 2.6, 2.2, 1.9, 1.8, 1.3, 0.8],
  source: 'Sclafani & Jung 2010, Arch Facial Plast Surg 12(2):123-127, doi:10.1001/archfacial.2010.17 (abstract only)',
  assumptions: 'millimetre values of the three stated relations (-1, 0, +3 mm), the tail at the level of the rim, the width and its taper, and the positions of the canthi along u',
} as const

/**
 * 由她（形变后）的额骨求眉线（纯函数）：每个 u 处的眶上缘高度 = 额骨顶点里、该 x 附近 3.5 mm、眼关节上方 6–30 mm、不在眼关节后 5 mm 以后的
 * 点中 (z − 0.3 y) 最大者的 y（取最靠前、偏下的一点：缘下的眶顶陡然向后，缘上的额骨缓缓后倾；系数 0.3 在本次构建上试过 0.3 和 1，1 在内侧落到额突上）；左右取平均、沿 u 平滑两遍；再加 BROW_RULE。
 * The brow line from her (warped) frontal bone (pure): the height of the supraorbital rim at each u = y of the frontal vertex with the
 * largest (z - 0.3 y) among those within 3.5 mm of that x, 6 to 30 mm above the eye joint and not more than 5 mm behind it; both sides are
 * averaged and smoothed twice along u; then BROW_RULE is added (the most anterior, lowish point: below the rim the orbital roof recedes steeply, above it the frontal bone slopes back gently; with 1 instead of 0.3 the medial stations fell onto the frontal process in this build). A station without a rim is filled from its neighbours; null when fewer than five stations find one.
 */
export function browBandFromRim(frontal: ArrayLike<number>, eyes: { L: readonly number[]; R: readonly number[] }): { band: BrowStandIn; rimAboveEyeJointMm: number[] } | null {
  const rim: number[] = []
  for (const u of BROW_RULE.u) {
    let sum = 0
    for (const [S, sg] of [['L', 1], ['R', -1]] as const) {
      const e = eyes[S]
      const x0 = e[0]! + (sg * u) / 1000
      let best = -Infinity
      let y = NaN
      for (let i = 0; i < frontal.length; i += 3) {
        if (Math.abs(frontal[i]! - x0) > 0.0035) continue
        const dy = frontal[i + 1]! - e[1]!
        if (dy < 0.006 || dy > 0.03 || frontal[i + 2]! < e[2]! - 0.005) continue
        const sc = frontal[i + 2]! - 0.3 * frontal[i + 1]!
        if (sc > best) {
          best = sc
          y = dy * 1000
        }
      }
      if (Number.isNaN(y)) {
        sum = NaN
        break
      }
      sum += y / 2
    }
    rim.push(sum)
  }
  // 找不到眶缘的站点按相邻站点线性插补；找到的不足五个时返回 null / stations without a rim are filled linearly from their neighbours; null when fewer than five were found
  const ok = rim.map((v, i) => (Number.isNaN(v) ? -1 : i)).filter((i) => i >= 0)
  if (ok.length < 5) return null
  const us = ok.map((i) => BROW_RULE.u[i]!)
  const ys = ok.map((i) => rim[i]!)
  const filled = BROW_RULE.u.map((u, i) => (Number.isNaN(rim[i]!) ? interp(u, us, ys) : rim[i]!))
  let r = filled
  for (let k = 0; k < 2; k++) r = r.map((v, i) => (i === 0 || i === r.length - 1 ? v : 0.25 * r[i - 1]! + 0.5 * v + 0.25 * r[i + 1]!))
  const r1 = (x: number) => Math.round(x * 10) / 10
  const centre = r.map((v, i) => r1(v + BROW_RULE.lowerBorderAboveRimMm[i]! + BROW_RULE.halfWidthMm[i]!))
  return { band: { bandOnTheRestHead_mmFromEyeJoint: { lateralOffset_u: [...BROW_RULE.u], centreHeightAboveEyeCentre: centre, halfWidth_at_u: Object.fromEntries(BROW_RULE.u.map((u, i) => [String(u), BROW_RULE.halfWidthMm[i]!])) } }, rimAboveEyeJointMm: r.map(r1) }
}
