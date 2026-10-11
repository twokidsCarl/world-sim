/**
 * 圆台胶囊（两个半径不同的球的凸包）与一条沿 -z 方向的视线的交点。渲染器里的片元着色器是这段算式
 * 的逐行转写；放在这里是为了能单独测试。只算侧面（圆台那一段），两端的球冠由球的绘制负责。
 *
 * Where a line of sight along -z meets a round cone (the convex hull of two spheres of different
 * radii). The fragment shader in the renderer is a line-by-line transcription of this; it lives
 * here so that it can be tested on its own. Only the side (the cone part) is found; the end caps
 * are left to the drawing of the spheres.
 *
 * 算式来自 Inigo Quilez 的 round cone 求交。/ The algebra is Inigo Quilez's round-cone intersection.
 */
export function roundConeSideZ(x: number, y: number, pa: [number, number, number], ra: number, pb: [number, number, number], rb: number): number | null {
  const top = Math.max(pa[2] + ra, pb[2] + rb)
  const ba = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]] as const
  const oa = [x - pa[0], y - pa[1], top - pa[2]] as const
  const rr = ra - rb
  const m0 = ba[0] * ba[0] + ba[1] * ba[1] + ba[2] * ba[2]
  const d2 = m0 - rr * rr
  // 一个球包在另一个里面：没有侧面 / one sphere inside the other: there is no side
  if (d2 <= 0) return null
  const m1 = ba[0] * oa[0] + ba[1] * oa[1] + ba[2] * oa[2]
  const m2 = -ba[2], m3 = -oa[2]
  const m5 = oa[0] * oa[0] + oa[1] * oa[1] + oa[2] * oa[2]
  const k2 = d2 - m2 * m2
  const k1 = d2 * m3 - m1 * m2 + m2 * rr * ra
  const k0 = d2 * m5 - m1 * m1 + m1 * rr * ra * 2 - m0 * ra * ra
  const h = k1 * k1 - k0 * k2
  if (h < 0 || Math.abs(k2) < 1e-7 * m0) return null
  const sq = Math.sqrt(h)
  let t = Infinity
  for (const cand of [(-k1 - sq) / k2, (-k1 + sq) / k2]) {
    const along = m1 - ra * rr + cand * m2
    if (along > 0 && along < d2 && cand < t) t = cand
  }
  return Number.isFinite(t) ? top - t : null
}
