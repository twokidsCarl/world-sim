/**
 * 两个通用工具：“填环境”和“穿线”。Goodsell 的多数画是“场景”：对象泡在拥挤的环境里，铺满整张纸，底色是深的。
 * 模型数据里只有对象本身，环境要另外补。补上去的东西是示意：种类有依据（写在目录条目里），位置是随机摆的、不重叠，
 * 数量按“铺满画面”定，不是测到的。
 *
 * Two general tools: "fill the environment" and "thread a strand". Most of Goodsell's paintings are
 * "scenes": the subject sits in a crowded environment that fills the sheet, on a dark ground. Model
 * data holds the subject alone, and its surroundings have to be supplied. What is supplied is
 * schematic: the kinds have grounds (stated in the catalogue entry), positions are random without
 * overlap, and numbers are set to fill the picture rather than measured.
 */
type V3 = [number, number, number]

export interface Box {
  /** 中心，以及 x、y 方向的半宽 / centre, and half-widths along x and y */
  centre: V3
  hx: number
  hy: number
  /** z 的范围（相对中心）：环境只铺在切面后面的一层里 / the range of z relative to the centre: the environment is laid in one layer behind the cut */
  z0: number
  z1: number
  /** 这个半径以内是对象自己，不放东西 / inside this radius is the subject itself, and nothing is put there */
  exclude: number
  /** 设了的话，东西只放在这个半径以内（填对象的里面，而不是周围）/ when set, things go only inside this radius (filling the inside of the subject instead of its surroundings) */
  within?: number
}

/** 均匀的随机旋转（列主序 3x3 的九个数）/ a uniform random rotation (nine numbers of a column-major 3x3) */
export function randomRotation(rand: () => number): number[] {
  const u = rand(), v = rand() * 2 * Math.PI, w = rand() * 2 * Math.PI
  const a = Math.sqrt(1 - u), b = Math.sqrt(u)
  const x = a * Math.sin(v), y = a * Math.cos(v), z = b * Math.sin(w), s = b * Math.cos(w)
  return [1 - 2 * (y * y + z * z), 2 * (x * y + z * s), 2 * (x * z - y * s), 2 * (x * y - z * s), 1 - 2 * (x * x + z * z), 2 * (y * z + x * s), 2 * (x * z + y * s), 2 * (y * z - x * s), 1 - 2 * (x * x + y * y)]
}

export interface Placed {
  p: V3
  r: number
}

/**
 * 在盒子里随机摆 `count` 个半径为 `radius` 的东西：不进对象的范围，彼此不重叠（按球算，允许压进 `squeeze` 的比例）。
 * 摆不下就少摆，返回实际摆下的。每个返回一个列主序 4x4：先绕 `origin` 随机转，再把 `origin` 搬到那个位置。
 * Scatter `count` things of radius `radius` in the box: outside the subject's range and not
 * overlapping one another (as spheres, allowed to press in by the share `squeeze`). What does not
 * fit is left out, and what was placed is returned, each as a column-major 4x4 that turns at random
 * about `origin` and then carries `origin` to its place.
 */
export function scatter(count: number, radius: number, origin: V3, box: Box, rand: () => number, placed: Placed[], squeeze = 0.75): Float32Array[] {
  const out: Float32Array[] = []
  for (let tries = 0; out.length < count && tries < count * 60; tries++) {
    const p: V3 = [box.centre[0] + (rand() * 2 - 1) * box.hx, box.centre[1] + (rand() * 2 - 1) * box.hy, box.centre[2] + box.z0 + rand() * (box.z1 - box.z0)]
    const far = Math.hypot(p[0] - box.centre[0], p[1] - box.centre[1], p[2] - box.centre[2])
    if (far < box.exclude + radius * 0.6 || (box.within !== undefined && far > box.within - radius * 0.8)) continue
    let clash = false
    for (const q of placed) {
      const d = (q.r + radius) * squeeze
      if (Math.abs(q.p[0] - p[0]) < d && Math.abs(q.p[1] - p[1]) < d && Math.hypot(q.p[0] - p[0], q.p[1] - p[1], q.p[2] - p[2]) < d) {
        clash = true
        break
      }
    }
    if (clash) continue
    placed.push({ p, r: radius })
    const R = randomRotation(rand)
    out.push(new Float32Array([
      R[0]!, R[1]!, R[2]!, 0, R[3]!, R[4]!, R[5]!, 0, R[6]!, R[7]!, R[8]!, 0,
      p[0] - (R[0]! * origin[0] + R[3]! * origin[1] + R[6]! * origin[2]),
      p[1] - (R[1]! * origin[0] + R[4]! * origin[1] + R[7]! * origin[2]),
      p[2] - (R[2]! * origin[0] + R[5]! * origin[1] + R[8]! * origin[2]),
      1,
    ]))
  }
  return out
}

/**
 * 穿线：在盒子里生成 `count` 条弯弯曲曲的长线，每条长 `length`，每 `step` 一个点。方向带惯性地随机变（所以线是顺的），
 * 碰到对象的范围或盒子的边就拐开。返回点（x, y, z）和把相邻的点连起来的线段，可以直接交给圆台图元画。
 * Thread strands: `count` wandering long strands in the box, each `length` long with a point every
 * `step`. The direction changes at random with inertia (so a strand runs smoothly) and turns away
 * on meeting the subject's range or a wall of the box. Returns points (x, y, z) and the segments
 * joining neighbours, ready for the round-cone primitive.
 */
export function threads(count: number, length: number, step: number, box: Box, rand: () => number, branches = 0, wander = 0.32): { pos: Float32Array; segments: Uint32Array } {
  const pos: number[] = [], seg: number[] = []
  const norm = (v: V3): V3 => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / l, v[1] / l, v[2] / l]
  }
  for (let s = 0; s < count; s++) {
    let p: V3 = [0, 0, 0]
    for (let t = 0; t < 40; t++) {
      p = [box.centre[0] + (rand() * 2 - 1) * box.hx, box.centre[1] + (rand() * 2 - 1) * box.hy, box.centre[2] + box.z0 + rand() * (box.z1 - box.z0)]
      const far = Math.hypot(p[0] - box.centre[0], p[1] - box.centre[1], p[2] - box.centre[2])
      if (far > box.exclude + 20 && (box.within === undefined || far < box.within - 20)) break
    }
    // 主要在画面平面里走，深度方向只小幅起伏 / it runs mostly in the plane of the picture, wavering only a little in depth
    let d = norm([rand() * 2 - 1, rand() * 2 - 1, (rand() * 2 - 1) * 0.2])
    const n = Math.round(length / step)
    let last = -1
    for (let i = 0; i < n; i++) {
      if (i > 0) seg.push(last, pos.length / 3)
      last = pos.length / 3
      pos.push(p[0], p[1], p[2])
      // 分叉：每隔几步向旁边伸出一小段（黏蛋白上的糖链，Goodsell 把它画成刷子状）
      // branches: every few steps a short side piece (the glycans on mucin, which Goodsell paints as a brush)
      if (branches > 0 && i % 3 === 1) {
        const side = norm([d[1] * (rand() < 0.5 ? 1 : -1) + (rand() - 0.5) * 0.6, -d[0] * (rand() < 0.5 ? 1 : -1) + (rand() - 0.5) * 0.6, (rand() - 0.5) * 0.6])
        let from = last
        for (let b = 1; b <= branches; b++) {
          seg.push(from, pos.length / 3)
          from = pos.length / 3
          pos.push(p[0] + side[0] * step * 0.8 * b, p[1] + side[1] * step * 0.8 * b, p[2] + side[2] * step * 0.8 * b)
        }
      }
      // 方向每步只偏一点：长链是平缓的弯，不是乱团（偏得多时几十条线缠成一张网）
      // the heading shifts only a little each step: a long chain bends gently and does not tangle (with more, a few dozen strands knot into a net)
      d = norm([d[0] + (rand() * 2 - 1) * wander, d[1] + (rand() * 2 - 1) * wander, d[2] + (rand() * 2 - 1) * wander * 0.3])
      // 碰到对象就沿着它的表面滑开；碰到盒子的边就折回 / on meeting the subject it slides off along its surface; on meeting a wall it turns back
      const q: V3 = [p[0] + d[0] * step, p[1] + d[1] * step, p[2] + d[2] * step]
      const c: V3 = [q[0] - box.centre[0], q[1] - box.centre[1], q[2] - box.centre[2]]
      const r = Math.hypot(c[0], c[1], c[2])
      if (r < box.exclude + 12) {
        const out = norm(c), along = d[0] * out[0] + d[1] * out[1] + d[2] * out[2]
        d = norm([d[0] - out[0] * Math.min(0, along) + out[0] * 0.3, d[1] - out[1] * Math.min(0, along) + out[1] * 0.3, d[2] - out[2] * Math.min(0, along) + out[2] * 0.3])
      }
      // 填里面时碰到外壁就沿壁滑回来 / when filling the inside, it slides back along the wall on meeting it
      if (box.within !== undefined && r > box.within - 14) {
        const out = norm(c), along = d[0] * out[0] + d[1] * out[1] + d[2] * out[2]
        d = norm([d[0] - out[0] * Math.max(0, along) - out[0] * 0.3, d[1] - out[1] * Math.max(0, along) - out[1] * 0.3, d[2] - out[2] * Math.max(0, along) - out[2] * 0.3])
      }
      if (Math.abs(c[0]) > box.hx) d[0] = -Math.sign(c[0]) * Math.abs(d[0])
      if (Math.abs(c[1]) > box.hy) d[1] = -Math.sign(c[1]) * Math.abs(d[1])
      if (c[2] < box.z0) d[2] = Math.abs(d[2])
      if (c[2] > box.z1) d[2] = -Math.abs(d[2])
      p = [p[0] + d[0] * step, p[1] + d[1] * step, p[2] + d[2] * step]
    }
  }
  return { pos: new Float32Array(pos), segments: new Uint32Array(seg) }
}
