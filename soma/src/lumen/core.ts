// "腔"显示的纯逻辑：充盈位移、网格里的顶点圈与中心线、体积、漫游路径。不依赖 three.js 和浏览器，可以单元测试。
// Pure logic of the lumina display: filling displacement, rings of vertices and centrelines in the meshes,
// volume, and the fly-through path. No three.js and no browser, so it can be unit-tested.

export type V3 = [number, number, number]

/** lumen-filling.json 里一个部件的条目 / One part's entry in lumen-filling.json. */
export interface FillingEntry {
  part: string
  /** 出厂几何所处的充盈度 / the filling the shipped geometry is at */
  rest: number
  /** 在 .bin 里的字节偏移 / byte offset in the .bin */
  offset: number
  vertices: number
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * 全局控制量 g（0 = 静止，1 = 充盈到壁允许的最大）换成某个部件的充盈度：f = rest + g·(1 − rest)。
 * 静止时就是满的部件（升结肠、横结肠）不随 g 变。
 * The global control g (0 = resting, 1 = as full as the wall allows) as one part's filling:
 * f = rest + g·(1 − rest). A part that is full at rest (ascending, transverse colon) does not change with g.
 */
export function partFilling(g: number, rest: number, override?: number): number {
  if (override !== undefined && Number.isFinite(override)) return clamp01(override)
  return clamp01(rest + clamp01(g) * (1 - rest))
}

/**
 * 充盈位移：out = base + (f − rest)·D。base 是 GLB 里的位置（已叠加体型等静止位移也可以）。
 * The filling displacement: out = base + (f − rest)·D, where base is the position from the GLB (or that
 * with other rest-space displacements already applied).
 */
export function applyFilling(base: ArrayLike<number>, d: ArrayLike<number>, f: number, rest: number, out: Float32Array): Float32Array {
  const k = f - rest
  const n = Math.min(base.length, d.length, out.length)
  if (k === 0) for (let i = 0; i < n; i++) out[i] = base[i]!
  else for (let i = 0; i < n; i++) out[i] = base[i]! + k * d[i]!
  return out
}

/** 位移是否全为零（口腔、咽、食管、输精管）/ Whether a displacement is zero throughout (mouth, pharynx, oesophagus, deferent ducts). */
export function isZeroDisplacement(d: ArrayLike<number>): boolean {
  for (let i = 0; i < d.length; i++) if (d[i] !== 0) return false
  return true
}

// ------------------------------------------------------------ 顶点圈 / rings

export interface RingMesh {
  /** 一圈一圈的顶点号，从一端到另一端 / rings of vertex numbers, from one end to the other */
  rings: Uint32Array[]
  /** 首、末两端是否由一个极点封住（盲端）/ whether the first and last end are closed by a pole vertex (a blind end) */
  poleStart: number | null
  poleEnd: number | null
}

/** 无向边的键 / key of an undirected edge */
const ekey = (a: number, b: number, n: number): number => (a < b ? a * n + b : b * n + a)

/** 边界上的环（只属于一个三角形的边连成的圈）/ Boundary loops (cycles of edges that belong to one triangle only). */
export function boundaryLoops(index: ArrayLike<number>, vertexCount: number, base = 0): number[][] {
  const count = new Map<number, number>()
  for (let t = 0; t + 2 < index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const e = ekey(index[t + k]! - base, index[t + ((k + 1) % 3)]! - base, vertexCount)
      count.set(e, (count.get(e) ?? 0) + 1)
    }
  }
  // 边界边按三角形里的方向存：a → b / boundary edges kept in the triangle's direction: a → b
  const next = new Map<number, number[]>()
  for (let t = 0; t + 2 < index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = index[t + k]! - base
      const b = index[t + ((k + 1) % 3)]! - base
      if (count.get(ekey(a, b, vertexCount)) !== 1) continue
      const list = next.get(a)
      if (list) list.push(b)
      else next.set(a, [b])
    }
  }
  const loops: number[][] = []
  const starts = [...next.keys()].sort((x, y) => x - y)
  for (const s of starts) {
    while (next.get(s)?.length) {
      const loop: number[] = []
      let v = s
      for (;;) {
        const out = next.get(v)
        if (!out?.length) break
        loop.push(v)
        v = out.pop()!
        if (v === s) break
      }
      if (loop.length >= 3) loops.push(loop)
    }
  }
  return loops
}

/**
 * 把一个管状网格的顶点分成一圈一圈。管线造的腔是"每站一圈、相邻两圈之间连成三角形带"，写 GLB 时顶点被
 * 重排过，所以这里只看连接关系：从一端（边界环，或封住盲端的极点）出发按边一层层向外扩，每一层就是一圈。
 * 不是这种结构的网格（口腔、咽的体素等值面）返回 null。
 * Split the vertices of a tubular mesh into rings. The pipeline's lumina are "a ring per station, a
 * triangle strip between neighbouring rings"; writing the GLB reorders the vertices, so only connectivity
 * is used: start at one end (a boundary loop, or the pole that closes a blind end) and grow outwards edge by
 * edge, each layer being one ring. A mesh without this structure (the voxel isosurfaces of mouth and
 * pharynx) gives null.
 */
export function ringsOf(index: ArrayLike<number>, vertexCount: number, base = 0): RingMesh | null {
  if (vertexCount < 6) return null
  const adj: number[][] = Array.from({ length: vertexCount }, () => [])
  const seen = new Set<number>()
  for (let t = 0; t + 2 < index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = index[t + k]! - base
      const b = index[t + ((k + 1) % 3)]! - base
      const e = ekey(a, b, vertexCount)
      if (seen.has(e)) continue
      seen.add(e)
      adj[a]!.push(b)
      adj[b]!.push(a)
    }
  }
  const loops = boundaryLoops(index, vertexCount, base)
  if (loops.length > 2) return null
  let first: number[]
  let poleStart: number | null = null
  if (loops.length > 0) {
    // 两端都开口时从含最小顶点号的那一圈开始（确定即可，方向由使用者再定）
    // with both ends open, start at the loop holding the smallest vertex number (any fixed choice; the caller orients)
    first = loops.reduce((a, b) => (Math.min(...a) <= Math.min(...b) ? a : b))
  } else {
    // 两端都封住：极点是度数最大的顶点，取号小的一个 / both ends closed: a pole is a vertex of the largest valence; take the lower-numbered
    let best = 0
    for (let v = 1; v < vertexCount; v++) if (adj[v]!.length > adj[best]!.length) best = v
    poleStart = best
    first = [...adj[best]!]
  }
  const sides = first.length
  if (sides < 3) return null
  const layer = new Int32Array(vertexCount).fill(-1)
  if (poleStart !== null) layer[poleStart] = -2
  for (const v of first) layer[v] = 0
  const rings: Uint32Array[] = [Uint32Array.from(first)]
  let poleEnd: number | null = null
  let assigned = first.length + (poleStart !== null ? 1 : 0)
  for (let cur = first; ; ) {
    const nextRing: number[] = []
    for (const v of cur) {
      for (const w of adj[v]!) {
        if (layer[w] !== -1) continue
        layer[w] = rings.length
        nextRing.push(w)
      }
    }
    if (nextRing.length === 0) break
    assigned += nextRing.length
    if (nextRing.length === 1) {
      poleEnd = nextRing[0]!
      break
    }
    if (nextRing.length !== sides) return null
    rings.push(Uint32Array.from(nextRing))
    cur = nextRing
  }
  if (assigned !== vertexCount || rings.length < 2) return null
  return { rings, poleStart, poleEnd }
}

export interface Station {
  /** 圈的质心，米 / the ring's centroid, metres */
  c: V3
  /** 圈上各顶点到质心距离的均值和最小值，米 / mean and smallest distance of the ring's vertices from the centroid, metres */
  r: number
  rMin: number
}

/** 各圈的质心与半径 / Centroid and radius of every ring. */
export function ringStations(rings: readonly Uint32Array[], position: ArrayLike<number>): Station[] {
  return rings.map((ring) => {
    let x = 0, y = 0, z = 0
    for (const v of ring) {
      x += position[v * 3]!
      y += position[v * 3 + 1]!
      z += position[v * 3 + 2]!
    }
    const n = ring.length
    x /= n
    y /= n
    z /= n
    let sum = 0
    let min = Infinity
    for (const v of ring) {
      const d = Math.hypot(position[v * 3]! - x, position[v * 3 + 1]! - y, position[v * 3 + 2]! - z)
      sum += d
      if (d < min) min = d
    }
    return { c: [x, y, z], r: sum / n, rMin: min }
  })
}

/**
 * 漫游用的"撑开"：把每一圈上离圈心不到 minRadius 的顶点沿径向推到 minRadius。静止时食管在括约肌处、小肠在
 * 许多地方只是一条不到 1 毫米的缝，相机进不去；这只是为了看得见，不是充盈状态，也不是数据。就地改写。
 * The widening used by the fly-through: every vertex of a ring closer than minRadius to the ring's centre is
 * pushed radially out to minRadius. At rest the oesophagus at its sphincters and the small bowel in many
 * places are slits under 1 mm that a camera cannot enter; this only makes them visible, and is neither a
 * filling state nor data. Rewrites `position` in place.
 */
export function widenRings(position: Float32Array, rings: readonly Uint32Array[], minRadius: number): number {
  let moved = 0
  for (const ring of rings) {
    let x = 0, y = 0, z = 0
    for (const v of ring) {
      x += position[v * 3]!
      y += position[v * 3 + 1]!
      z += position[v * 3 + 2]!
    }
    x /= ring.length
    y /= ring.length
    z /= ring.length
    for (const v of ring) {
      const dx = position[v * 3]! - x, dy = position[v * 3 + 1]! - y, dz = position[v * 3 + 2]! - z
      const d = Math.hypot(dx, dy, dz)
      if (d >= minRadius || d < 1e-9) continue
      const k = minRadius / d
      position[v * 3] = x + dx * k
      position[v * 3 + 1] = y + dy * k
      position[v * 3 + 2] = z + dz * k
      moved++
    }
  }
  return moved
}

// ------------------------------------------------------------ 体积 / volume

/**
 * 网格围住的体积（立方米，取绝对值）。开口的管（两端的圈与邻段共用）先虚拟地封上：每个边界环用"环的
 * 质心到各边"的扇形补上。口腔和咽的边界环不是平的，所以只是近似。
 * The volume a mesh encloses (m³, absolute). An open tube (whose end rings are shared with its
 * neighbours) is closed virtually first: every boundary loop is capped by the fan from its centroid to its
 * edges. The loops of mouth and pharynx are not flat, so this is an approximation.
 */
export function closedVolume(position: ArrayLike<number>, index: ArrayLike<number>, base = 0): { volume: number; openLoops: number } {
  const n = position.length / 3
  if (n === 0) return { volume: 0, openLoops: 0 }
  const ox = position[0]!, oy = position[1]!, oz = position[2]!
  const tet = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number =>
    ((ax - ox) * ((by - oy) * (cz - oz) - (bz - oz) * (cy - oy)) + (ay - oy) * ((bz - oz) * (cx - ox) - (bx - ox) * (cz - oz)) + (az - oz) * ((bx - ox) * (cy - oy) - (by - oy) * (cx - ox))) / 6
  let v = 0
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = (index[t]! - base) * 3, b = (index[t + 1]! - base) * 3, c = (index[t + 2]! - base) * 3
    v += tet(position[a]!, position[a + 1]!, position[a + 2]!, position[b]!, position[b + 1]!, position[b + 2]!, position[c]!, position[c + 1]!, position[c + 2]!)
  }
  const loops = boundaryLoops(index, n, base)
  for (const loop of loops) {
    let cx = 0, cy = 0, cz = 0
    for (const p of loop) {
      cx += position[p * 3]!
      cy += position[p * 3 + 1]!
      cz += position[p * 3 + 2]!
    }
    cx /= loop.length
    cy /= loop.length
    cz /= loop.length
    // 边界边在三角形里是 a → b，补上的三角形要反过来走：(b, a, 质心)
    // a boundary edge runs a → b in its triangle, so the closing triangle runs the other way: (b, a, centroid)
    for (let k = 0; k < loop.length; k++) {
      const a = loop[k]! * 3
      const b = loop[(k + 1) % loop.length]! * 3
      v += tet(position[b]!, position[b + 1]!, position[b + 2]!, position[a]!, position[a + 1]!, position[a + 2]!, cx, cy, cz)
    }
  }
  return { volume: Math.abs(v), openLoops: loops.length }
}

// ------------------------------------------------------------ 来历 / origin

export const ORIGIN_DERIVED = 0
export const ORIGIN_BOUNDED = 1
export const ORIGIN_CONSTRUCTION = 2
/** 一个部件里构造的和不是构造的混在一起，而数据没有给出逐顶点的标记 / construction and the rest are mixed in one part and the data has no per-vertex marking */
export const ORIGIN_MIXED = 3

export interface OriginSummary {
  kind: 0 | 1 | 2 | 3
  /** 构造的顶点所占的份额 / share of constructed vertices */
  constructionShare: number
}

/** 构造的份额低于这个值时按非构造的那一类着色（胃：849 个顶点里 1 个；直肠：736 里 16 个）/ below this share of construction a part takes the colour of its other class (stomach: 1 of 849 vertices; rectum: 16 of 736). */
export const MIXED_MIN_SHARE = 0.05

/**
 * 一个腔部件的来历，由 composition 的顶点数得到。写 GLB 时顶点被重排，composition 里各片的先后顺序和顶点
 * 顺序对不上（胃唯一的构造顶点是盲端的极点，在顶点序的开头而不是末尾），所以这里不做逐顶点的划分，
 * 只给整件的类别；构造的份额不小而又不是全部时记为"混合"。
 * The origin of a lumen part from the vertex counts of its `composition`. Writing the GLB reorders the
 * vertices, so the order of the pieces does not match the vertex order (the stomach's single constructed
 * vertex is the pole of its blind end, at the start of the vertex order, not the end); hence no per-vertex
 * split here, only a class for the whole part, "mixed" when construction is a sizeable share but not all.
 */
export function originOf(composition: readonly { provenance: string; vertices: number; what?: { en: string } }[] | undefined): OriginSummary {
  let made = 0, bounded = 0, total = 0
  for (const c of composition ?? []) {
    total += c.vertices
    if (c.provenance === 'construction') made += c.vertices
    else if (/^bounded by/i.test(c.what?.en ?? '')) bounded += c.vertices
  }
  if (total === 0) return { kind: ORIGIN_DERIVED, constructionShare: 0 }
  const share = made / total
  if (made === total) return { kind: ORIGIN_CONSTRUCTION, constructionShare: 1 }
  if (share >= MIXED_MIN_SHARE) return { kind: ORIGIN_MIXED, constructionShare: share }
  return { kind: bounded > total - made - bounded ? ORIGIN_BOUNDED : ORIGIN_DERIVED, constructionShare: share }
}

// ------------------------------------------------------------ 漫游路径 / fly-through path

export interface PathSegmentInput {
  id: string
  /** 网格上一圈一圈的站（按 ringsOf 的顺序）；没有时用 guide / stations of the mesh's rings (in ringsOf order); `guide` when absent */
  stations?: Station[]
  poleStart?: boolean
  poleEnd?: boolean
  /** 引导线上的点，米（口腔、咽）/ guide points, metres (mouth, pharynx) */
  guide?: V3[]
  /**
   * 既没有顶点圈也没有引导线的腔（标本自己的直肠腔、阴道腔、宫颈管、子宫腔）：由网格本身的测地等值线求中心线
   * （见 meshCentreline），起点取离上一段出口最近的地方。
   * A lumen with neither rings nor a guide (the specimen's own rectal, vaginal, cervical and uterine lumina): its
   * centreline comes from the geodesic level sets of the mesh itself (see meshCentreline), starting where it
   * is nearest the previous segment's exit.
   */
  mesh?: { position: ArrayLike<number>; index: ArrayLike<number>; base?: number }
}

export interface CanalPath {
  /** 等间隔重采样后的点（xyz 连排），米 / resampled points at equal spacing (flat xyz), metres */
  points: Float32Array
  /** 每个点所在段在 segments 里的下标 / index into `segments` of the segment each point is in */
  seg: Uint8Array
  /** 每个点处腔的半径，米；引导线上未知，为 0 / lumen radius at each point, metres; 0 where unknown (guide lines) */
  radius: Float32Array
  step: number
  length: number
  segments: { id: string; start: number; end: number; bridged: number }[]
  /** 每个点在输入的站序列里的位置（站号 + 小数）；同样的站数时用来在重建后找回同一处 / each point's place in the input stations (index + fraction); with the same station count it finds the same place again after a rebuild */
  u: Float32Array
  /** 输入的站数 / the number of input stations */
  stations: number
}

const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

// ------------------------------------------------------------ 网格中心线 / mesh centreline

/**
 * 没有顶点圈的管状或囊状网格的中心线：从起点所在的顶点出发，沿网格的边求测地距离（Dijkstra），按距离每 step
 * 分一层，每层顶点的质心是一站（再做两遍 1-2-1 平滑），半径是层内顶点到中心线的平均垂直距离。起点：给了 from 就取离它
 * 最近的顶点；只给了 to 就取离 to 最远的顶点（入口在远离下一段的那一端）；都没有时取测地直径的一端。
 * 只走起点所在的连通块。少于两站时返回 null。
 * The centreline of a tubular or sac-like mesh without rings: geodesic distance along the mesh's edges from
 * the start vertex (Dijkstra), cut into layers every `step`; each layer's vertex centroid is a station (two
 * passes of 1-2-1 smoothing follow) and its radius the mean distance of the layer's vertices from the
 * centreline, measured normal to it.
 * The start: with `from`, the vertex nearest to it; with only `to`, the vertex farthest from it (entered at the
 * end away from the next segment); with neither, one end of the geodesic diameter. Only the connected piece of
 * the start vertex is walked. Null for fewer than two stations.
 */
export function meshCentreline(position: ArrayLike<number>, index: ArrayLike<number>, opts: { from?: V3 | null; to?: V3 | null; step?: number; base?: number } = {}): Station[] | null {
  const n = Math.floor(position.length / 3)
  if (n < 4 || index.length < 3) return null
  const base = opts.base ?? 0
  const step = opts.step ?? 0.003
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (let t = 0; t + 2 < index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = index[t + k]! - base
      const b = index[t + ((k + 1) % 3)]! - base
      if (a < 0 || b < 0 || a >= n || b >= n || a === b) continue
      adj[a]!.push(b)
      adj[b]!.push(a)
    }
  }
  const len = (a: number, b: number): number => Math.hypot(position[a * 3]! - position[b * 3]!, position[a * 3 + 1]! - position[b * 3 + 1]!, position[a * 3 + 2]! - position[b * 3 + 2]!)
  const nearest = (p: V3): number => {
    let best = Infinity
    let at = 0
    for (let v = 0; v < n; v++) {
      const d = (position[v * 3]! - p[0]) ** 2 + (position[v * 3 + 1]! - p[1]) ** 2 + (position[v * 3 + 2]! - p[2]) ** 2
      if (d < best) {
        best = d
        at = v
      }
    }
    return at
  }
  const geodesic = (src: number): Float64Array => {
    const d = new Float64Array(n).fill(Infinity)
    d[src] = 0
    // 二叉堆（允许重复入堆，取出时跳过过时的）/ a binary heap (duplicates allowed; stale entries skipped when popped)
    const heap: [number, number][] = [[0, src]]
    while (heap.length) {
      const top = heap[0]!
      const tail = heap.pop()!
      if (heap.length) {
        heap[0] = tail
        for (let i = 0; ; ) {
          const l = i * 2 + 1, r = l + 1
          let m = i
          if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l
          if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r
          if (m === i) break
          ;[heap[i], heap[m]] = [heap[m]!, heap[i]!]
          i = m
        }
      }
      const [dv, v] = top
      if (dv > d[v]!) continue
      for (const w of adj[v]!) {
        const dw = dv + len(v, w)
        if (dw >= d[w]!) continue
        d[w] = dw
        heap.push([dw, w])
        for (let i = heap.length - 1; i > 0; ) {
          const p = (i - 1) >> 1
          if (heap[p]![0] <= heap[i]![0]) break
          ;[heap[i], heap[p]] = [heap[p]!, heap[i]!]
          i = p
        }
      }
    }
    return d
  }
  const farthest = (d: Float64Array): number => {
    let at = -1
    for (let v = 0; v < n; v++) if (Number.isFinite(d[v]!) && (at < 0 || d[v]! > d[at]!)) at = v
    return Math.max(0, at)
  }
  let start: number
  if (opts.from) start = nearest(opts.from)
  else if (opts.to) start = farthest(geodesic(nearest(opts.to)))
  else start = farthest(geodesic(farthest(geodesic(0))))
  const d = geodesic(start)
  let max = 0
  for (let v = 0; v < n; v++) if (Number.isFinite(d[v]!) && d[v]! > max) max = d[v]!
  const layers = Math.max(1, Math.ceil(max / step))
  const sum = new Float64Array(layers * 3)
  const count = new Uint32Array(layers)
  const layerOf = new Int32Array(n).fill(-1)
  for (let v = 0; v < n; v++) {
    if (!Number.isFinite(d[v]!)) continue
    const k = Math.min(layers - 1, Math.floor(d[v]! / step))
    layerOf[v] = k
    sum[k * 3] = sum[k * 3]! + position[v * 3]!
    sum[k * 3 + 1] = sum[k * 3 + 1]! + position[v * 3 + 1]!
    sum[k * 3 + 2] = sum[k * 3 + 2]! + position[v * 3 + 2]!
    count[k] = count[k]! + 1
  }
  let c: V3[] = []
  const slot = new Int32Array(layers).fill(-1)
  const sizes: number[] = []
  for (let k = 0; k < layers; k++) {
    if (!count[k]) continue
    slot[k] = c.length
    sizes.push(count[k]!)
    c.push([sum[k * 3]! / count[k]!, sum[k * 3 + 1]! / count[k]!, sum[k * 3 + 2]! / count[k]!])
  }
  if (c.length < 2) return null
  for (let pass = 0; pass < 2; pass++) {
    const prev = c
    c = prev.map((p, i) => (i === 0 || i === prev.length - 1 ? p : [0, 1, 2].map((j) => (prev[i - 1]![j]! + 2 * p[j]! + prev[i + 1]![j]!) / 4) as V3))
  }
  // 半径量的是与中心线垂直的距离：层是斜切的（测地距离从壁上一点算起），直接取到质心的距离会偏大
  // the radius is measured normal to the centreline: the layers are cut obliquely (geodesic distance from a point on the wall), so the plain distance to the centroid would come out too large
  const tangent = c.map((_, i) => {
    const a = c[Math.max(0, i - 1)]!, b = c[Math.min(c.length - 1, i + 1)]!
    const t: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const l = Math.hypot(t[0], t[1], t[2]) || 1
    return [t[0] / l, t[1] / l, t[2] / l] as V3
  })
  const rsum = new Float64Array(c.length)
  for (let v = 0; v < n; v++) {
    const i = layerOf[v]! >= 0 ? slot[layerOf[v]!]! : -1
    if (i < 0) continue
    const p = c[i]!, t = tangent[i]!
    const dx = position[v * 3]! - p[0], dy = position[v * 3 + 1]! - p[1], dz = position[v * 3 + 2]! - p[2]
    const along = dx * t[0] + dy * t[1] + dz * t[2]
    rsum[i] = rsum[i]! + Math.hypot(dx - along * t[0], dy - along * t[1], dz - along * t[2])
  }
  return c.map((p, i) => {
    const r = rsum[i]! / sizes[i]!
    return { c: p, r, rMin: r }
  })
}

/** 一段输入的大致位置（用于给第一段定方向）/ A rough location of an input (used to orient the first segment). */
function inputCentre(input: PathSegmentInput): V3 | null {
  const pts = input.mesh?.position
  if (pts && pts.length >= 3) {
    let x = 0, y = 0, z = 0
    const n = Math.floor(pts.length / 3)
    for (let v = 0; v < n; v++) {
      x += pts[v * 3]!
      y += pts[v * 3 + 1]!
      z += pts[v * 3 + 2]!
    }
    return [x / n, y / n, z / n]
  }
  const line = input.stations?.map((s) => s.c) ?? input.guide
  if (!line?.length) return null
  const a = line[0]!, b = line[line.length - 1]!
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
}

/**
 * 把各段接成一条从口到肛门的路径。规则：
 *  · 两端开口的管：离上一段出口近的那一端是入口；
 *  · 一端是盲端的囊（胃、升结肠）：开口的一端是出口；上一段从侧面进来，入口取前六成里离上一段出口最近的
 *    一站，盲端那几站不走；
 *  · 段与段之间不相接时（咽到食管约 20 毫米、食管到胃、回肠到升结肠）直接连过去，这段长度记在 bridged 里；
 *  · 第一段的入口在离下一段远的那一端；没有顶点圈也没有引导线、只给了网格的段用 meshCentreline。
 * Join the segments into one path from mouth to anus. Rules:
 *  · a tube open at both ends is entered at the end nearer the previous segment's exit;
 *  · a sac with a blind end (stomach, ascending colon) exits at its open end; the previous segment comes in
 *    from the side, so it is entered at the station nearest that exit among its first six tenths, and the
 *    stations of the blind end are skipped;
 *  · where consecutive segments do not meet (pharynx to oesophagus, about 20 mm; oesophagus to stomach;
 *    ileum to ascending colon) the path goes straight across, and that length is recorded as `bridged`;
 *  · the first segment is entered at the end away from the next one; a segment given only as a mesh (no
 *    rings, no guide) takes its centreline from meshCentreline.
 */
export function buildCanalPath(inputs: readonly PathSegmentInput[], step = 0.0015): CanalPath | null {
  const pts: V3[] = []
  const rad: number[] = []
  const segOf: number[] = []
  const meta: { id: string; from: number; bridged: number }[] = []
  let last: V3 | null = null
  for (let q = 0; q < inputs.length; q++) {
    let input = inputs[q]!
    // 第一段没有"上一段的出口"：入口取离下一段远的那一端 / the first segment has no previous exit: it is entered at the end away from the next segment
    const next = !last && q + 1 < inputs.length ? inputCentre(inputs[q + 1]!) : null
    if (!input.stations?.length && !input.guide?.length && input.mesh) {
      // 没有顶点圈的网格：从上一段的出口求中心线 / a mesh without rings: its centreline from the previous segment's exit
      // 半径不进读数（记为 0）：这些腔多是塌陷的缝，"直径"量出来的是缝宽 / the radius stays out of the readout (set to 0): these lumina are mostly collapsed slits, and a "diameter" would measure the slit's width
      const stations = meshCentreline(input.mesh.position, input.mesh.index, { from: last, to: next, base: input.mesh.base })
      input = stations ? { id: input.id, stations: stations.map((st) => ({ ...st, r: 0 })) } : input
    }
    let line: { c: V3; r: number }[]
    if (input.stations?.length) {
      let st = input.stations
      const blindStart = !!input.poleStart && !input.poleEnd
      const blindEnd = !!input.poleEnd && !input.poleStart
      if (blindEnd) st = [...st].reverse()
      else if (!blindStart && last && dist(last, st[st.length - 1]!.c) < dist(last, st[0]!.c)) st = [...st].reverse()
      else if (!blindStart && !last && next && dist(next, st[0]!.c) < dist(next, st[st.length - 1]!.c)) st = [...st].reverse()
      let from = 0
      if ((blindStart || blindEnd) && last) {
        const limit = Math.max(1, Math.floor(st.length * 0.6))
        let best = Infinity
        for (let k = 0; k < limit; k++) {
          const d = dist(last, st[k]!.c)
          if (d < best) {
            best = d
            from = k
          }
        }
      }
      line = st.slice(from).map((s) => ({ c: s.c, r: s.r }))
    } else if (input.guide?.length) {
      line = input.guide.map((c) => ({ c, r: 0 }))
    } else continue
    if (line.length === 0) continue
    const k = meta.length
    meta.push({ id: input.id, from: pts.length, bridged: last ? dist(last, line[0]!.c) : 0 })
    for (const p of line) {
      pts.push(p.c)
      rad.push(p.r)
      segOf.push(k)
    }
    last = line[line.length - 1]!.c
  }
  if (pts.length < 2) return null
  // 累计弧长，再等间隔重采样 / cumulative arc length, then resample at equal spacing
  const acc = new Float64Array(pts.length)
  for (let i = 1; i < pts.length; i++) acc[i] = acc[i - 1]! + dist(pts[i - 1]!, pts[i]!)
  const length = acc[pts.length - 1]!
  const n = Math.max(2, Math.floor(length / step) + 1)
  const points = new Float32Array(n * 3)
  const radius = new Float32Array(n)
  const seg = new Uint8Array(n)
  const u = new Float32Array(n)
  let j = 0
  for (let i = 0; i < n; i++) {
    const s = Math.min(length, i * step)
    while (j < pts.length - 2 && acc[j + 1]! < s) j++
    const span = acc[j + 1]! - acc[j]!
    const t = span > 0 ? (s - acc[j]!) / span : 0
    const a = pts[j]!, b = pts[j + 1]!
    points[i * 3] = a[0] + (b[0] - a[0]) * t
    points[i * 3 + 1] = a[1] + (b[1] - a[1]) * t
    points[i * 3 + 2] = a[2] + (b[2] - a[2]) * t
    // 跨段的那一小段归后一段 / the stretch between two segments belongs to the later one
    seg[i] = segOf[j + 1]!
    u[i] = j + t
    radius[i] = rad[j]! > 0 && rad[j + 1]! > 0 ? rad[j]! + (rad[j + 1]! - rad[j]!) * t : 0
  }
  const segments = meta.map((m, k) => {
    const start = k === 0 ? 0 : acc[m.from]! - m.bridged
    const end = k + 1 < meta.length ? acc[meta[k + 1]!.from]! - meta[k + 1]!.bridged : length
    return { id: m.id, start, end, bridged: m.bridged }
  })
  return { points, seg, radius, step, length, segments, u, stations: pts.length }
}

/** 路径上弧长 s 处的点（线性插值）/ The point at arc length s on the path (linear interpolation). */
export function pathPoint(path: CanalPath, s: number, out: V3 = [0, 0, 0]): V3 {
  const n = path.seg.length
  const u = Math.min(n - 1, Math.max(0, s / path.step))
  const i = Math.min(n - 2, Math.floor(u))
  const t = u - i
  for (let c = 0; c < 3; c++) out[c] = path.points[i * 3 + c]! + (path.points[(i + 1) * 3 + c]! - path.points[i * 3 + c]!) * t
  return out
}

/** 弧长 s 处所在的段 / The segment at arc length s. */
export function segmentAt(path: CanalPath, s: number): number {
  const i = Math.min(path.seg.length - 1, Math.max(0, Math.round(s / path.step)))
  return path.seg[i]!
}

/** 弧长 s 处的半径（米），未知为 0 / Radius at arc length s (metres), 0 where unknown. */
export function radiusAt(path: CanalPath, s: number): number {
  return path.radius[Math.min(path.seg.length - 1, Math.max(0, Math.round(s / path.step)))]!
}

/**
 * 路径重建之后（充盈、呼吸、姿势）相机该在哪里：站数没变时回到同一站之间的同一处（跟着组织走）；否则在同一段里
 * 的同一比例处；两条路径的段对不上时按总长的比例。
 * Where the camera belongs after the path is rebuilt (filling, breathing, a pose): with the same number of
 * stations, the same place between the same two stations (it moves with the tissue); otherwise the same
 * fraction of the same segment; by the fraction of the whole length when the segments do not match.
 */
export function keepPlace(from: CanalPath, to: CanalPath, s: number): number {
  const same = from.segments.length === to.segments.length && from.segments.every((x, k) => x.id === to.segments[k]!.id)
  if (!same) return from.length > 0 ? (s / from.length) * to.length : 0
  if (from.stations === to.stations && to.u.length > 1) {
    const x = Math.min(from.u.length - 1, Math.max(0, s / from.step))
    const i = Math.min(from.u.length - 2, Math.floor(x))
    const want = from.u[i]! + (from.u[i + 1]! - from.u[i]!) * (x - i)
    // u 沿路径不减：二分 / u never decreases along the path: bisect
    let lo = 0, hi = to.u.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (to.u[mid]! <= want) lo = mid
      else hi = mid
    }
    const span = to.u[hi]! - to.u[lo]!
    const t = span > 0 ? Math.min(1, Math.max(0, (want - to.u[lo]!) / span)) : 0
    return Math.min(to.length, (lo + t) * to.step)
  }
  const k = Math.max(0, from.segments.findIndex((x) => s <= x.end))
  const a = from.segments[k]!, b = to.segments[k]!
  const t = a.end > a.start ? (s - a.start) / (a.end - a.start) : 0
  return Math.min(to.length, Math.max(0, b.start + t * (b.end - b.start)))
}

// ------------------------------------------------------------ 漫游相机 / fly-through camera

/**
 * 漫游相机的参数。视线：先取"指向前方 ahead 处的弦"，再沿路径按 sigma 做高斯平滑——小肠在一两毫米里折返的
 * 地方，原来视线每毫米转 50° 以上（一闪而过），平滑后转角摊到二三十毫米上。"上"方向沿路径平行移动（每一步
 * 只做把上一站视线转到这一站视线的最小旋转），所以只取决于在路径上的位置，拖动、跳段、反向都得到同一个朝向，
 * 不会翻转；同时每毫米向"身体的上方"（视线接近竖直时不管）回正 righting 的一份，免得走完几米以后画面是倒的。
 * 位置取前后各 spread 的平均。
 * The fly-through camera's parameters. The view: first the chord to the point `ahead` along the path, then
 * Gaussian smoothing along the path with `sigma` — where the small bowel doubles back within a millimetre or
 * two the view used to turn by over 50° per millimetre (a flash), and the smoothing spreads the turn over
 * twenty or thirty millimetres. "Up" is parallel-transported along the path (each step only applies the
 * smallest rotation taking one station's view to the next), so it depends only on the place on the path:
 * scrubbing, jumping and reversing all give the same orientation, and it never flips; each millimetre it is
 * also turned back by the share `righting` towards the body's up (left alone when the view is near vertical),
 * so the picture is not upside down after a few metres. The position averages `spread` either side.
 */
export const FLY_CAMERA = { ahead: 0.008, sigma: 0.006, maxTurn: (8 * Math.PI) / 180, spread: 0.002, righting: 0.02 }
const FLY_CANCEL = 1e-3

export interface FlyFrames {
  /** 每个路径点的视线方向和"上"方向（单位向量，xyz 连排）/ view direction and up at every path point (unit vectors, flat xyz) */
  dir: Float32Array
  up: Float32Array
}

type Vec = [number, number, number]
const dot3 = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross3 = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm3 = (a: Vec): number => Math.hypot(a[0], a[1], a[2])
const unit3 = (a: Vec, fallback: Vec): Vec => {
  const l = norm3(a)
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : fallback
}
/** 去掉沿 d 的分量 / drop the component along d */
const flat3 = (u: Vec, d: Vec): Vec => {
  const k = dot3(u, d)
  return [u[0] - k * d[0], u[1] - k * d[1], u[2] - k * d[2]]
}
/** 绕单位轴 k 转 angle / rotate about the unit axis k by angle */
const rotate3 = (u: Vec, k: Vec, angle: number): Vec => {
  const c = Math.cos(angle), s = Math.sin(angle)
  const kxu = cross3(k, u)
  const kd = dot3(k, u) * (1 - c)
  return [u[0] * c + kxu[0] * s + k[0] * kd, u[1] * c + kxu[1] * s + k[1] * kd, u[2] * c + kxu[2] * s + k[2] * kd]
}

/** 身体的上方（+y）；视线接近竖直时用前方（+z）/ The body's up (+y); the front (+z) when the view is near vertical. */
function initialUp(d: Vec): Vec {
  const y: Vec = [0, 1, 0]
  const ref: Vec = Math.abs(dot3(d, y)) < 0.9 ? y : [0, 0, 1]
  return unit3(flat3(ref, d), [1, 0, 0])
}

/** 三维长度（Math.hypot 在热循环里慢得多）/ A 3-D length (Math.hypot is much slower in hot loops). */
const len3 = (x: number, y: number, z: number): number => Math.sqrt(x * x + y * y + z * z)

/** 预先算好整条路径上的视线和"上"方向 / Precompute the view direction and up along the whole path. */
export function flyFrames(path: CanalPath, opts: Partial<typeof FLY_CAMERA> = {}): FlyFrames {
  const { ahead, sigma, righting, maxTurn } = { ...FLY_CAMERA, ...opts }
  const n = path.seg.length
  const step = path.step
  const P = path.points
  // 这一函数在呼吸时每帧都要跑，所以全用定长数组、不分配小对象 / this runs every frame while breathing, so it uses flat arrays and allocates no small objects
  const at = (s: number, k: number): number => {
    const x = Math.min(n - 1, Math.max(0, s / step))
    const i = Math.min(n - 2, Math.floor(x))
    const t = x - i
    return P[i * 3 + k]! + (P[(i + 1) * 3 + k]! - P[i * 3 + k]!) * t
  }
  const raw = new Float64Array(n * 3)
  for (let i = 0; i < n; i++) {
    const s = i * step
    const fwd = s + ahead <= path.length
    let dx: number, dy: number, dz: number
    if (fwd) {
      dx = at(s + ahead, 0) - P[i * 3]!
      dy = at(s + ahead, 1) - P[i * 3 + 1]!
      dz = at(s + ahead, 2) - P[i * 3 + 2]!
    } else {
      dx = P[i * 3]! - at(s - ahead, 0)
      dy = P[i * 3 + 1]! - at(s - ahead, 1)
      dz = P[i * 3 + 2]! - at(s - ahead, 2)
    }
    const l = len3(dx, dy, dz)
    if (l > 1e-12) {
      raw[i * 3] = dx / l
      raw[i * 3 + 1] = dy / l
      raw[i * 3 + 2] = dz / l
    } else if (i > 0) raw.copyWithin(i * 3, i * 3 - 3, i * 3)
    else raw[1] = -1
  }
  // 沿路径的高斯平滑 / Gaussian smoothing along the path
  const w = sigma > 0 ? Math.ceil((3 * sigma) / step) : 0
  const g = new Float64Array(w + 1)
  for (let k = 0; k <= w; k++) g[k] = sigma > 0 ? Math.exp(-0.5 * ((k * step) / sigma) ** 2) : 1
  const D = new Float64Array(n * 3)
  for (let i = 0; i < n; i++) {
    let ax = 0, ay = 0, az = 0, total = 0
    for (let k = -w; k <= w; k++) {
      const j = Math.min(n - 1, Math.max(0, i + k)) * 3
      const gk = g[k < 0 ? -k : k]!
      ax += raw[j]! * gk
      ay += raw[j + 1]! * gk
      az += raw[j + 2]! * gk
      total += gk
    }
    // 折返处平均几乎抵消，剩下的是横向的分量，正是该看的方向；完全抵消时退回原始方向
    // at a doubling-back the average nearly cancels and what is left is sideways, which is the way to look; if it cancels completely, fall back to the raw direction
    const l = len3(ax, ay, az)
    if (l > FLY_CANCEL * total) {
      D[i * 3] = ax / l
      D[i * 3 + 1] = ay / l
      D[i * 3 + 2] = az / l
    } else D.set(raw.subarray(i * 3, i * 3 + 3), i * 3)
  }
  // 转角限速：沿路径往前，每毫米最多转 maxTurn；正好掉头时沿上一步的转轴继续转，免得转轴来回跳
  // a turn-rate limit: going along the path, at most `maxTurn` per millimetre; on an exact about-turn keep turning about the previous axis so the axis does not flicker
  if (maxTurn > 0) {
    const limit = maxTurn * (step / 0.001)
    let kx = 0, ky = 0, kz = 0, haveAxis = false
    for (let i = 1; i < n; i++) {
      const o = (i - 1) * 3, q = i * 3
      const px = D[o]!, py = D[o + 1]!, pz = D[o + 2]!
      const dx = D[q]!, dy = D[q + 1]!, dz = D[q + 2]!
      const cos = Math.min(1, Math.max(-1, px * dx + py * dy + pz * dz))
      if (Math.acos(cos) <= limit) {
        haveAxis = false
        continue
      }
      let ax = py * dz - pz * dy, ay = pz * dx - px * dz, az = px * dy - py * dx
      if (len3(ax, ay, az) < 0.05 && haveAxis) {
        ax = kx
        ay = ky
        az = kz
      }
      // 转轴与 p 垂直、单位长 / the axis normal to p, of unit length
      const ap = ax * px + ay * py + az * pz
      ax -= ap * px
      ay -= ap * py
      az -= ap * pz
      let al = len3(ax, ay, az)
      if (al < 1e-9) {
        // 没有可用的转轴：取与 p 垂直的任一方向 / no usable axis: any direction normal to p
        ;[ax, ay, az] = Math.abs(py) < 0.9 ? [pz, 0, -px] : [0, -pz, py]
        al = len3(ax, ay, az)
      }
      kx = ax / al
      ky = ay / al
      kz = az / al
      haveAxis = true
      // p 绕 k 转 limit（k ⟂ p）：p·cos + (k × p)·sin / p rotated about k by `limit` (k ⟂ p)
      const c = Math.cos(limit), s = Math.sin(limit)
      let rx = px * c + (ky * pz - kz * py) * s
      let ry = py * c + (kz * px - kx * pz) * s
      let rz = pz * c + (kx * py - ky * px) * s
      const rl = len3(rx, ry, rz)
      rx /= rl
      ry /= rl
      rz /= rl
      D[q] = rx
      D[q + 1] = ry
      D[q + 2] = rz
    }
  }
  const dir = Float32Array.from(D)
  const up = new Float32Array(n * 3)
  const perMm = 1 - Math.pow(1 - Math.min(1, Math.max(0, righting)), step / 0.001)
  let [ux, uy, uz] = initialUp([D[0]!, D[1]!, D[2]!])
  for (let i = 0; i < n; i++) {
    const q = i * 3
    const dx = D[q]!, dy = D[q + 1]!, dz = D[q + 2]!
    if (i > 0) {
      // 把上一站的视线转到这一站的最小旋转，同样作用在"上"上（平行移动）/ the smallest rotation taking the previous view to this one, applied to up as well (parallel transport)
      const px = D[q - 3]!, py = D[q - 2]!, pz = D[q - 1]!
      let ax = py * dz - pz * dy, ay = pz * dx - px * dz, az = px * dy - py * dx
      const sin = len3(ax, ay, az)
      if (sin > 1e-9) {
        ax /= sin
        ay /= sin
        az /= sin
        const angle = Math.atan2(sin, px * dx + py * dy + pz * dz)
        const c = Math.cos(angle), s = Math.sin(angle)
        const kd = (ax * ux + ay * uy + az * uz) * (1 - c)
        const nx = ux * c + (ay * uz - az * uy) * s + ax * kd
        const ny = uy * c + (az * ux - ax * uz) * s + ay * kd
        const nz = uz * c + (ax * uy - ay * ux) * s + az * kd
        ux = nx
        uy = ny
        uz = nz
      }
      // 去掉沿视线的分量 / drop the component along the view
      let k = ux * dx + uy * dy + uz * dz
      ux -= k * dx
      uy -= k * dy
      uz -= k * dz
      let l = len3(ux, uy, uz)
      if (l < 1e-9) [ux, uy, uz] = initialUp([dx, dy, dz])
      else {
        ux /= l
        uy /= l
        uz /= l
      }
      // 向身体的上方回正一点 / turn back a little towards the body's up
      let tx = -dy * dx, ty = 1 - dy * dy, tz = -dy * dz
      const tl = len3(tx, ty, tz)
      if (perMm > 0 && tl > 1e-3) {
        tx /= tl
        ty /= tl
        tz /= tl
        // u 与 t 都与 d 垂直：绕 d 从 u 转到 t 的有符号角 / u and t are both normal to d: the signed angle about d from u to t
        const cx = uy * tz - uz * ty, cy = uz * tx - ux * tz, cz = ux * ty - uy * tx
        const angle = Math.atan2(cx * dx + cy * dy + cz * dz, ux * tx + uy * ty + uz * tz) * perMm * tl ** 4
        const c = Math.cos(angle), s = Math.sin(angle)
        // 绕 d 转（u ⟂ d）/ rotate about d (u ⟂ d)
        const nx = ux * c + (dy * uz - dz * uy) * s
        const ny = uy * c + (dz * ux - dx * uz) * s
        const nz = uz * c + (dx * uy - dy * ux) * s
        k = nx * dx + ny * dy + nz * dz
        ux = nx - k * dx
        uy = ny - k * dy
        uz = nz - k * dz
        l = len3(ux, uy, uz)
        ux /= l
        uy /= l
        uz /= l
      }
    }
    up[q] = ux
    up[q + 1] = uy
    up[q + 2] = uz
  }
  return { dir, up }
}

export interface FlyPose {
  pos: V3
  /** 视线（反向时朝路径的反方向）/ the view (against the path when reversed) */
  dir: V3
  up: V3
}

/** 弧长 s 处的相机 / The camera at arc length s. */
export function flyPose(path: CanalPath, frames: FlyFrames, s: number, reverse = false, spread = FLY_CAMERA.spread): FlyPose {
  const a: V3 = [0, 0, 0], b: V3 = [0, 0, 0], c: V3 = [0, 0, 0]
  pathPoint(path, s - spread, a)
  pathPoint(path, s, b)
  pathPoint(path, s + spread, c)
  const pos: V3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]
  const n = path.seg.length
  const x = Math.min(n - 1, Math.max(0, s / path.step))
  const i = Math.min(n - 2, Math.floor(x))
  const t = Math.max(0, x - i)
  const lerp = (arr: Float32Array): Vec => [0, 1, 2].map((k) => arr[i * 3 + k]! + (arr[(i + 1) * 3 + k]! - arr[i * 3 + k]!) * t) as Vec
  const d = unit3(lerp(frames.dir), [frames.dir[i * 3]!, frames.dir[i * 3 + 1]!, frames.dir[i * 3 + 2]!])
  const u = unit3(flat3(lerp(frames.up), d), initialUp(d))
  return { pos, dir: reverse ? [-d[0], -d[1], -d[2]] : d, up: u }
}

// ------------------------------------------------------------ 漫游路线 / fly-through routes

export interface FlyRoute {
  /** 路线的短名（地址参数里用）/ the route's short key (used in the URL) */
  key: string
  /** 按顺序的腔部件 / the lumen parts in order */
  parts: string[]
}

/**
 * 消化道以外的路线：每条按顺序列出可能有的腔，这副人体里没有的跳过；第一个腔不在时整条路线不给。
 * 男性没有尿道的腔；女性的尿道腔数据到了就自动接在膀胱后面。
 * The routes besides the alimentary canal: each lists, in order, the lumina it may have; those missing from
 * this body are skipped, and a route whose first lumen is missing is not offered. The male has no urethral
 * lumen; the female's urethral lumen joins after the bladder by itself once its data is there.
 */
export const FLY_ROUTE_DEFS: readonly FlyRoute[] = [
  { key: 'ureter_l', parts: ['LUMEN_ureter_L', 'LUMEN_urinary_bladder', 'LUMEN_urethra'] },
  { key: 'ureter_r', parts: ['LUMEN_ureter_R', 'LUMEN_urinary_bladder', 'LUMEN_urethra'] },
  { key: 'deferent_l', parts: ['LUMEN_deferent_duct_L', 'LUMEN_seminal_vesicle_L'] },
  { key: 'deferent_r', parts: ['LUMEN_deferent_duct_R', 'LUMEN_seminal_vesicle_R'] },
  { key: 'uterine_l', parts: ['WU_vaginal_lumen', 'WU_cervical_canal', 'WU_uterine_cavity', 'LUMEN_uterine_tube_L'] },
  { key: 'uterine_r', parts: ['WU_vaginal_lumen', 'WU_cervical_canal', 'WU_uterine_cavity', 'LUMEN_uterine_tube_R'] },
]

export const CANAL_ROUTE = 'canal'

/** 这副人体能飞的路线：先是消化道，再是其余各条 / The routes this body can fly: the canal first, then the others. */
export function flyRoutes(canal: readonly string[], has: (id: string) => boolean): FlyRoute[] {
  const out: FlyRoute[] = []
  const c = canal.filter(has)
  if (c.length) out.push({ key: CANAL_ROUTE, parts: c })
  for (const r of FLY_ROUTE_DEFS) if (has(r.parts[0]!)) out.push({ key: r.key, parts: r.parts.filter(has) })
  return out
}

/**
 * 漫游从哪里开始：路线的短名（从头）、部件 id 或段名（那一段的起点；先找 prefer 这条路线，再找消化道，再找其余）。
 * 数字（毫米）在 prefer 这条路线上，没有就是消化道。找不到时返回 null。
 * Where a fly-through starts: a route key (its start), or a part id or segment key (that segment's start;
 * looked up in the `prefer` route first, then the canal, then the rest). A number (millimetres) is on the
 * `prefer` route, else the canal. Null when nothing matches.
 */
export function findFlyStart(routes: readonly FlyRoute[], at: string | number, prefer: string | null, keyOf: (id: string) => string = (id) => id): { route: FlyRoute; part: string | null; mm: number | null } | null {
  const order = [...routes].sort((a, b) => rank(a) - rank(b))
  function rank(r: FlyRoute): number {
    return r.key === prefer ? 0 : r.key === CANAL_ROUTE ? 1 : 2
  }
  if (typeof at === 'number') return order[0] ? { route: order[0], part: null, mm: at } : null
  const want = at.toLowerCase().replace(/^oesophagus$/, 'esophagus')
  const byKey = routes.find((r) => r.key === want)
  if (byKey) return { route: byKey, part: null, mm: null }
  for (const r of order) {
    const part = r.parts.find((id) => id === at || keyOf(id) === want)
    if (part) return { route: r, part, mm: null }
  }
  return null
}

// ------------------------------------------------------------ 地址参数 / URL parameters

/** 段的短名：英文名去掉 "Lumen of" / "Cavity of"，小写，空格换成下划线 / A segment's short key: its English name without "Lumen of" / "Cavity of", lower case, spaces as underscores. */
export function segmentKey(name: string): string {
  return name
    .replace(/^(lumen|cavity) of (the )?/i, '')
    .replace(/ proper$/i, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
}

export interface LumenParams {
  mode: boolean
  /** 只看消化道：消化道的腔和它们的壁，其余隐藏（lumen=canal）/ the alimentary canal alone: its lumina and their walls, everything else hidden (lumen=canal) */
  canal: boolean
  /** 全局充盈控制量 0–1 / global filling control 0–1 */
  fill: number
  /** 个别部件自己的充盈度 / per-part filling */
  overrides: Record<string, number>
  /**
   * 漫游：null 为关；at 是路线的短名、段名、部件 id 或已走的毫米数；route 是毫米数所在的路线（没有就是消化道）
   * fly-through: null = off; `at` is a route key, a segment key, a part id or millimetres travelled; `route` is
   * the route the millimetres are on (the canal when absent)
   */
  fly: { at: string | number; route?: string } | null
}

/**
 * 解析 lumen / fill / fly 三个参数。lumen 是 `1`，或 `canal`（同时只看消化道）。fill 是 `0.5`，或带个别部件的 `0.5,LUMEN_stomach:1`，也可以只有后者。
 * fly 是路线的短名、段名或部件 id（从那里开始播放），或一个毫米数（在消化道上，停在那里），或"路线:毫米数"
 * （在那条路线上停住，如 `ureter_l:120`）；空值或 `1` 表示从头。
 * Parse the three parameters lumen / fill / fly. `lumen` is `1`, or `canal` (the alimentary canal alone). `fill` is `0.5`, or with per-part values
 * `0.5,LUMEN_stomach:1`, or the latter alone. `fly` is a route key, a segment key or a part id (play from
 * there), or a number of millimetres (on the canal, hold there), or "route:millimetres" (hold on that route,
 * e.g. `ureter_l:120`); empty or `1` means from the start.
 */
export function parseLumenParams(search: string): { params: LumenParams; warnings: string[] } {
  const q = new URLSearchParams(search)
  const warnings: string[] = []
  const lumen = q.get('lumen')
  const params: LumenParams = { mode: lumen === '1' || lumen === 'canal', canal: lumen === 'canal', fill: 0, overrides: {}, fly: null }
  if (lumen !== null && !['0', '1', 'canal'].includes(lumen)) warnings.push(`lumen: 只接受 1 或 canal / expected 1 or canal, got "${lumen}"`)
  const fill = q.get('fill')
  if (fill !== null) {
    for (const token of fill.split(',')) {
      const t = token.trim()
      if (!t) continue
      const colon = t.lastIndexOf(':')
      const value = Number(colon >= 0 ? t.slice(colon + 1) : t)
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        warnings.push(`fill: 充盈度要在 0 到 1 之间 / a filling must be within 0–1, got "${t}"`)
        continue
      }
      if (colon > 0) params.overrides[t.slice(0, colon)] = value
      else params.fill = value
    }
  }
  const fly = q.get('fly')
  if (fly !== null) {
    const t = fly.trim()
    if (t === '' || t === '1') params.fly = { at: 0 }
    else if (/^\d+(\.\d+)?$/.test(t)) params.fly = { at: Number(t) }
    else if (/^[A-Za-z][\w-]*:\d+(\.\d+)?$/.test(t)) {
      const colon = t.lastIndexOf(':')
      params.fly = { at: Number(t.slice(colon + 1)), route: t.slice(0, colon) }
    } else if (/^[A-Za-z][\w-]*$/.test(t)) params.fly = { at: t }
    else warnings.push(`fly: 要路线名、段名、部件 id、毫米数或"路线:毫米数" / expected a route key, a segment key, a part id, millimetres or "route:millimetres", got "${t}"`)
  }
  return { params, warnings }
}

const num = (v: number): string => String(Math.round(v * 100) / 100)

/** 写回地址栏的三个值；null 表示不写 / The three values to write back; null = omit. */
export function formatLumenParams(p: LumenParams): { lumen: string | null; fill: string | null; fly: string | null } {
  const parts: string[] = []
  if (p.fill > 0) parts.push(num(p.fill))
  for (const id of Object.keys(p.overrides).sort()) parts.push(`${id}:${num(p.overrides[id]!)}`)
  return {
    lumen: p.mode ? (p.canal ? 'canal' : '1') : null,
    fill: parts.length ? parts.join(',') : null,
    fly: p.fly ? (typeof p.fly.at === 'number' ? (p.fly.route && p.fly.route !== CANAL_ROUTE ? `${p.fly.route}:` : '') + String(Math.round(p.fly.at)) : p.fly.at) : null,
  }
}
