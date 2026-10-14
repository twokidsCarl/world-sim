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
}

const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/**
 * 把各段接成一条从口到肛门的路径。规则：
 *  · 两端开口的管：离上一段出口近的那一端是入口；
 *  · 一端是盲端的囊（胃、升结肠）：开口的一端是出口；上一段从侧面进来，入口取前六成里离上一段出口最近的
 *    一站，盲端那几站不走；
 *  · 段与段之间不相接时（咽到食管约 20 毫米、食管到胃、回肠到升结肠）直接连过去，这段长度记在 bridged 里。
 * Join the segments into one path from mouth to anus. Rules:
 *  · a tube open at both ends is entered at the end nearer the previous segment's exit;
 *  · a sac with a blind end (stomach, ascending colon) exits at its open end; the previous segment comes in
 *    from the side, so it is entered at the station nearest that exit among its first six tenths, and the
 *    stations of the blind end are skipped;
 *  · where consecutive segments do not meet (pharynx to oesophagus, about 20 mm; oesophagus to stomach;
 *    ileum to ascending colon) the path goes straight across, and that length is recorded as `bridged`.
 */
export function buildCanalPath(inputs: readonly PathSegmentInput[], step = 0.0015): CanalPath | null {
  const pts: V3[] = []
  const rad: number[] = []
  const segOf: number[] = []
  const meta: { id: string; from: number; bridged: number }[] = []
  let last: V3 | null = null
  for (const input of inputs) {
    let line: { c: V3; r: number }[]
    if (input.stations?.length) {
      let st = input.stations
      const blindStart = !!input.poleStart && !input.poleEnd
      const blindEnd = !!input.poleEnd && !input.poleStart
      if (blindEnd) st = [...st].reverse()
      else if (!blindStart && last && dist(last, st[st.length - 1]!.c) < dist(last, st[0]!.c)) st = [...st].reverse()
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
    radius[i] = rad[j]! > 0 && rad[j + 1]! > 0 ? rad[j]! + (rad[j + 1]! - rad[j]!) * t : 0
  }
  const segments = meta.map((m, k) => {
    const start = k === 0 ? 0 : acc[m.from]! - m.bridged
    const end = k + 1 < meta.length ? acc[meta[k + 1]!.from]! - meta[k + 1]!.bridged : length
    return { id: m.id, start, end, bridged: m.bridged }
  })
  return { points, seg, radius, step, length, segments }
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
  /** 漫游：null 为关；at 是段名、部件 id 或已走的毫米数 / fly-through: null = off; `at` is a segment key, a part id or millimetres travelled */
  fly: { at: string | number } | null
}

/**
 * 解析 lumen / fill / fly 三个参数。lumen 是 `1`，或 `canal`（同时只看消化道）。fill 是 `0.5`，或带个别部件的 `0.5,LUMEN_stomach:1`，也可以只有后者。
 * fly 是段名或部件 id（从那一段的起点开始播放），或一个毫米数（停在那里），空值或 `1` 表示从头。
 * Parse the three parameters lumen / fill / fly. `lumen` is `1`, or `canal` (the alimentary canal alone). `fill` is `0.5`, or with per-part values
 * `0.5,LUMEN_stomach:1`, or the latter alone. `fly` is a segment key or part id (play from that segment's
 * start) or a number of millimetres (hold there); empty or `1` means from the start.
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
    else if (/^[A-Za-z][\w-]*$/.test(t)) params.fly = { at: t }
    else warnings.push(`fly: 要段名、部件 id 或毫米数 / expected a segment key, a part id or millimetres, got "${t}"`)
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
    fly: p.fly ? (typeof p.fly.at === 'number' ? String(Math.round(p.fly.at)) : p.fly.at) : null,
  }
}
