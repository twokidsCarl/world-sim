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
  /** 设了的话，东西只放在它说“空着”的地方（形状不规则的对象的外面，见 outsideOf）/ when set, things go only where it says the place is free (outside a subject of irregular shape, see outsideOf) */
  free?: (p: V3) => boolean
}

/**
 * 形状不规则的对象（一段树突、一个突触）的“外面”：把对象各部分的位置记进一个粗格子，占了的格子向外胀一格，
 * 再从格子的边界往里灌水，灌得到的空格子就是外面。对象里面的空隙灌不到（只要膜在这个格子大小上是不漏的），所以不会被填上。
 * 返回一个判断某点是否在外面的函数。
 *
 * The "outside" of a subject of irregular shape (a stretch of dendrite, a synapse): the positions of
 * its parts are entered in a coarse grid, occupied cells are swollen by one cell, and the grid is
 * flooded from its boundary; the empty cells the flood reaches are the outside. Voids inside the
 * subject are not reached (so long as its membrane is watertight at this cell size) and so are not
 * filled. Returns a test of whether a point is outside.
 */
export function outsideOf(points: ArrayLike<number>, cell: number): (p: V3) => boolean {
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < points.length; i += 3) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k]!, points[i + k]!)
    hi[k] = Math.max(hi[k]!, points[i + k]!)
  }
  // 四周留三格空的，水从那里灌进来 / three empty cells all round, where the flood comes in
  const PAD = 3
  const n = [0, 1, 2].map((k) => Math.ceil((hi[k]! - lo[k]!) / cell) + 1 + PAD * 2) as V3
  const at = (x: number, y: number, z: number) => (z * n[1] + y) * n[0] + x
  const solid = new Uint8Array(n[0] * n[1] * n[2])
  for (let i = 0; i < points.length; i += 3) {
    const x = Math.floor((points[i]! - lo[0]) / cell) + PAD, y = Math.floor((points[i + 1]! - lo[1]) / cell) + PAD, z = Math.floor((points[i + 2]! - lo[2]) / cell) + PAD
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) solid[at(x + dx, y + dy, z + dz)] = 1
  }
  // 2 = 外面 / 2 = outside
  const stack = [0]
  solid[0] = 2
  while (stack.length) {
    const i = stack.pop()!
    const x = i % n[0], y = Math.floor(i / n[0]) % n[1], z = Math.floor(i / (n[0] * n[1]))
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const X = x + dx, Y = y + dy, Z = z + dz
      if (X < 0 || Y < 0 || Z < 0 || X >= n[0] || Y >= n[1] || Z >= n[2]) continue
      const j = at(X, Y, Z)
      if (solid[j] === 0) {
        solid[j] = 2
        stack.push(j)
      }
    }
  }
  return (p) => {
    const x = Math.floor((p[0] - lo[0]) / cell) + PAD, y = Math.floor((p[1] - lo[1]) / cell) + PAD, z = Math.floor((p[2] - lo[2]) / cell) + PAD
    if (x < 0 || y < 0 || z < 0 || x >= n[0] || y >= n[1] || z >= n[2]) return true
    return solid[at(x, y, z)] === 2
  }
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
/** 已摆好的东西的空间格子，免得每摆一个都把所有的查一遍 / a spatial grid of what is already placed, so that placing one does not mean checking them all */
const GRIDS = new WeakMap<Placed[], { cell: number; maxR: number; cells: Map<number, Placed[]>; seen: number }>()
const cellKey = (x: number, y: number, z: number) => (x + 2048) * 16777216 + (y + 2048) * 4096 + (z + 2048)

export function scatter(count: number, radius: number, origin: V3, box: Box, rand: () => number, placed: Placed[], squeeze = 0.75): Float32Array[] {
  const out: Float32Array[] = []
  let grid = GRIDS.get(placed)
  if (!grid) GRIDS.set(placed, (grid = { cell: Math.max(40, radius * 2), maxR: 0, cells: new Map(), seen: 0 }))
  const add = (q: Placed) => {
    const k = cellKey(Math.floor(q.p[0] / grid!.cell), Math.floor(q.p[1] / grid!.cell), Math.floor(q.p[2] / grid!.cell))
    const list = grid!.cells.get(k)
    if (list) list.push(q)
    else grid!.cells.set(k, [q])
    grid!.maxR = Math.max(grid!.maxR, q.r)
  }
  for (; grid.seen < placed.length; grid.seen++) add(placed[grid.seen]!)
  for (let tries = 0; out.length < count && tries < count * 60; tries++) {
    const p: V3 = [box.centre[0] + (rand() * 2 - 1) * box.hx, box.centre[1] + (rand() * 2 - 1) * box.hy, box.centre[2] + box.z0 + rand() * (box.z1 - box.z0)]
    const far = Math.hypot(p[0] - box.centre[0], p[1] - box.centre[1], p[2] - box.centre[2])
    if (far < box.exclude + radius || (box.within !== undefined && far > box.within - radius * 0.8)) continue
    if (box.free && !box.free(p)) continue
    let clash = false
    const reach = Math.ceil(((grid.maxR + radius) * squeeze) / grid.cell)
    const cx = Math.floor(p[0] / grid.cell), cy = Math.floor(p[1] / grid.cell), cz = Math.floor(p[2] / grid.cell)
    for (let dx = -reach; dx <= reach && !clash; dx++) for (let dy = -reach; dy <= reach && !clash; dy++) for (let dz = -reach; dz <= reach && !clash; dz++) {
      const list = grid.cells.get(cellKey(cx + dx, cy + dy, cz + dz))
      if (!list) continue
      for (const q of list) {
        const d = (q.r + radius) * squeeze
        if (Math.hypot(q.p[0] - p[0], q.p[1] - p[1], q.p[2] - p[2]) < d) {
          clash = true
          break
        }
      }
    }
    if (clash) continue
    const mine = { p, r: radius }
    placed.push(mine)
    add(mine)
    grid.seen = placed.length
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
      if (far > box.exclude + 20 && (box.within === undefined || far < box.within - 20) && (!box.free || box.free(p))) break
    }
    // 各个方向一样：环境是立体的，从哪个角度看都成立 / the same in every direction: the environment is a solid, and holds from any angle of view
    let d = norm([rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1])
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
      d = norm([d[0] + (rand() * 2 - 1) * wander, d[1] + (rand() * 2 - 1) * wander, d[2] + (rand() * 2 - 1) * wander])
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
      const next: V3 = [p[0] + d[0] * step, p[1] + d[1] * step, p[2] + d[2] * step]
      // 前面不是空的（撞上了形状不规则的对象）：掉头，这一步不走 / what lies ahead is not free (it has met a subject of irregular shape): turn round and stay put this step
      // 也不许进对象的范围：贴着表面滑有时滑不开，线就钻进去挡在对象前面了；钻进去的那一步改成朝外走
      // nor may it enter the subject's range: sliding along the surface sometimes fails and the strand ends up inside, in front of the subject; a step that would enter goes outward instead
      const nr = Math.hypot(next[0] - box.centre[0], next[1] - box.centre[1], next[2] - box.centre[2])
      if (box.free && !box.free(next)) d = norm([-d[0] + (rand() - 0.5), -d[1] + (rand() - 0.5), d[2]])
      else if (box.exclude > 0 && nr < box.exclude + 6) {
        d = norm([(p[0] - box.centre[0]) / Math.max(1, nr) + (rand() - 0.5) * 0.6, (p[1] - box.centre[1]) / Math.max(1, nr) + (rand() - 0.5) * 0.6, (p[2] - box.centre[2]) / Math.max(1, nr) + (rand() - 0.5) * 0.6])
        // 分叉也可能伸进去；这里只管主线，分叉很短 / a branch may reach in as well; only the main course is handled here, and branches are short
      } else p = next
    }
  }
  return { pos: new Float32Array(pos), segments: new Uint32Array(seg) }
}

/**
 * 串珠：给一串“珠子”（比如病毒里一个个核蛋白团块）补上把它们串起来的那条线。珠子的位置是数据里的，线是推断的。
 * 先按“每次去最近的还没串过的那个”排出顺序，再用样条把它们光滑地连起来；线在每个珠子朝观察者的那一面上经过（否则埋在珠子里看不见），
 * 并左右摆一摆，像缠在上面。`plane` 是切面的 z：线不超过它，免得被切掉。返回点和把相邻的点连起来的线段。
 *
 * Beads on a string: supply the strand that strings a set of "beads" together (the clumps of
 * nucleoprotein in a virus, say). Where the beads are comes from the data; the strand is inferred.
 * The beads are ordered by always going to the nearest one not yet strung, then joined smoothly by
 * a spline; the strand passes over the side of each bead that faces the viewer (or it would lie
 * hidden inside) and sways from side to side, as if wound on. `plane` is the z of the cut, which
 * the strand does not pass, so that it is not cut away. Returns points and the segments joining
 * neighbours.
 */
export function stringThrough(beads: V3[], lift: number, plane: number, step = 6): { pos: Float32Array; segments: Uint32Array; order: number[] } {
  if (beads.length < 2) return { pos: new Float32Array(0), segments: new Uint32Array(0), order: beads.map((_, i) => i) }
  const left = new Set(beads.map((_, i) => i))
  // 从最靠边的一个开始，线才不会一上来就把中间穿乱 / start from the outermost bead, so that the strand does not begin by crossing the middle
  const mean: V3 = [0, 0, 0]
  for (const b of beads) for (let k = 0; k < 3; k++) mean[k]! += b[k]! / beads.length
  let at = 0, far = -1
  beads.forEach((b, i) => {
    const d = Math.hypot(b[0] - mean[0], b[1] - mean[1], b[2] - mean[2])
    if (d > far) {
      far = d
      at = i
    }
  })
  const order = [at]
  left.delete(at)
  while (left.size) {
    let best = -1, bd = Infinity
    for (const i of left) {
      const d = Math.hypot(beads[i]![0] - beads[at]![0], beads[i]![1] - beads[at]![1], beads[i]![2] - beads[at]![2])
      if (d < bd) {
        bd = d
        best = i
      }
    }
    order.push(best)
    left.delete(best)
    at = best
  }
  // 控制点都在每个珠子朝观察者的那一面上 / the control points all lie on the side of each bead that faces the viewer
  const ctrl: V3[] = []
  order.forEach((i, k) => {
    const b = beads[i]!, prev = beads[order[Math.max(0, k - 1)]!]!, next = beads[order[Math.min(order.length - 1, k + 1)]!]!
    let dx = next[0] - prev[0], dy = next[1] - prev[1]
    const l = Math.hypot(dx, dy) || 1
    dx /= l
    dy /= l
    const z = Math.min(b[2] + lift * 0.9, plane - 4), side = (k % 2 ? 1 : -1) * lift * 0.6
    // 三个点：进、中、出，左右交替，线在珠子上走一个 S 形 / three points, in, middle and out, alternating sides, so that the strand runs an S over the bead
    for (const [along, across] of [[-0.7, 1], [0, -1], [0.7, 1]] as const) ctrl.push([b[0] + dx * lift * along - dy * side * across, b[1] + dy * lift * along + dx * side * across, z])
  })
  // Catmull-Rom 样条 / a Catmull-Rom spline
  const pos: number[] = [], seg: number[] = []
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)]!, p1 = ctrl[i]!, p2 = ctrl[i + 1]!, p3 = ctrl[Math.min(ctrl.length - 1, i + 2)]!
    const n = Math.max(2, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]) / step))
    for (let j = 0; j < n; j++) {
      const t = j / n, t2 = t * t, t3 = t2 * t
      if (pos.length) seg.push(pos.length / 3 - 1, pos.length / 3)
      for (let k = 0; k < 3; k++) pos.push(0.5 * (2 * p1[k]! + (-p0[k]! + p2[k]!) * t + (2 * p0[k]! - 5 * p1[k]! + 4 * p2[k]! - p3[k]!) * t2 + (-p0[k]! + 3 * p1[k]! - 3 * p2[k]! + p3[k]!) * t3))
    }
  }
  return { pos: new Float32Array(pos), segments: new Uint32Array(seg), order }
}

/**
 * 把一个圆形的截面用一条来回折的波浪线铺满，沿线等间隔地给出“珠子”的位置：核酸串着蛋白、挤满一个腔的画法。
 * 行与行之间隔 `spacing`，线本身带小波浪（珠子在波峰波谷的另一侧，线从它们之间绕过去），整行再慢慢地起伏，免得像格子。
 * 返回线上的点、把相邻的点连起来的线段，和珠子的位置。全部是生成的，不是数据。
 *
 * Fill a circular section with one wavy line folded back and forth, with "bead" sites at even
 * intervals along it: the way of drawing nucleic acid strung with protein and packed into a
 * cavity. Rows are `spacing` apart; the line carries a small wave (beads sit opposite its crests and
 * troughs, and the line winds between them) and each row drifts slowly as a whole, so that it does not
 * read as a grid. Returns the points of the line, the segments joining neighbours, and the bead
 * sites. All of it is generated, none of it data.
 */
export function serpentine(centre: V3, radius: number, spacing: number, z: number, rand: () => number, turn = 0): { pos: Float32Array; segments: Uint32Array; beads: V3[] } {
  const pos: number[] = [], seg: number[] = [], beads: V3[] = []
  const cos = Math.cos(turn), sin = Math.sin(turn)
  const put = (x: number, y: number): V3 => [centre[0] + x * cos - y * sin, centre[1] + x * sin + y * cos, centre[2] + z]
  const rows = Math.max(1, Math.floor((radius * 2) / spacing))
  const step = 5, wave = spacing * 1.7, amp = spacing * 0.2
  const phase = rand() * 6.28
  // 每个波峰、波谷各一个珠子，放在线摆过去的另一侧：线就从珠子之间一左一右地绕过去
  // one bead at every crest and trough, on the side the line swings away from, so that the line winds between the beads, left and right by turns
  let along = 0, nextBead = wave / 4
  for (let r = 0; r < rows; r++) {
    const y0 = -radius + spacing * (r + 0.5) + (radius * 2 - rows * spacing) / 2
    const half = Math.sqrt(Math.max(0, radius * radius - y0 * y0)) - spacing * 0.35
    if (half < spacing * 0.5) continue
    const dir = r % 2 === 0 ? 1 : -1
    const n = Math.max(2, Math.round((half * 2) / step))
    for (let i = 0; i <= n; i++) {
      const x = dir * (-half + (2 * half * i) / n)
      // 小波浪加整行的慢起伏 / the small wave plus the slow drift of the whole row
      const y = y0 + Math.sin((along / wave) * 6.2831853) * amp + Math.sin(x / (radius * 0.45) + phase + r * 0.9) * spacing * 0.18
      if (pos.length) seg.push(pos.length / 3 - 1, pos.length / 3)
      pos.push(...put(x, y))
      if (along >= nextBead) {
        beads.push(put(x, y0 - Math.sin((along / wave) * 6.2831853) * amp * 1.5 + Math.sin(x / (radius * 0.45) + phase + r * 0.9) * spacing * 0.18))
        nextBead += wave / 2
      }
      along += (2 * half) / n
    }
  }
  return { pos: new Float32Array(pos), segments: new Uint32Array(seg), beads }
}
