// GarmentCode 裁片规格 → 带缝合对的三角网格。
// 边按弧长均匀取样（缝在一起的两条边取同样的段数），压缩服装的负放松量在取样后缩放；
// 缝合对的方向照 GarmentCode 的约定（缺省“swap”：第一条边反向）。
// GarmentCode pattern specification → a triangle mesh with stitch pairs. Edges are sampled uniformly
// by arc length (two edges sewn together get the same number of segments); the negative ease of the
// compression garments is applied after sampling; stitch pairing follows GarmentCode's convention
// (by default "swap": the first edge reversed).

import { triangulatePolygon } from './triangulate.ts'

type V2 = [number, number]

export interface GcEdge {
  endpoints: [number, number]
  curvature?: number[] | { type: 'quadratic' | 'cubic' | 'circle'; params: number[] | number[][] }
  label?: string
}
export interface GcPanel {
  vertices: V2[]
  edges: GcEdge[]
  translation: [number, number, number]
  rotation: [number, number, number]
  part: string
  grain: 'x' | 'y'
}
export interface GcSpec {
  pattern: {
    panels: Record<string, GcPanel>
    stitches: ({ panel: string; edge: number } | string)[][]
  }
  soma: { body: string; garment: string; fabric: string; ease: number; lengthScale: number }
}

/** 边的类型（不缝的边）/ Kinds of edge (unsewn ones). */
export type EdgeKind = 'seam' | 'hem' | 'neckline' | 'armhole' | 'cuff' | 'waistband' | 'edge'
export const EDGE_KINDS: EdgeKind[] = ['seam', 'hem', 'neckline', 'armhole', 'cuff', 'waistband', 'edge']

export interface PanelMesh {
  name: string
  part: string
  /** 正面（GarmentCode 摆放在身前）/ Front (placed in front of the body by GarmentCode). */
  front: boolean
  /** 第一个顶点的全局下标 / Global index of the first vertex. */
  offset: number
  count: number
  /** 裁片局部二维坐标（米，已缩放）/ Local 2-D panel coordinates (metres, scaled). */
  local: Float64Array
  /** GarmentCode 摆放后的三维位置（米，地面 y = 0）/ 3-D positions as placed by GarmentCode (metres, floor at y = 0). */
  placed: Float64Array
  /** 每条边在边界上的顶点下标（局部，含两端）/ Local vertex indices of each edge along the boundary (both ends included). */
  edgeVerts: number[][]
  /** 边界多边形（局部顶点下标顺序）/ The boundary polygon (local vertex order). */
  boundaryCount: number
}

export interface GarmentMesh {
  spec: GcSpec
  panels: PanelMesh[]
  /** 布纹坐标（米），u = 纬向，v = 经向 / Fabric coordinates (metres), u = weft, v = warp. */
  uv: Float64Array
  /** GarmentCode 摆放（米，地面 y = 0）/ GarmentCode placement (metres, floor at y = 0). */
  placed: Float64Array
  triangles: Uint32Array
  panelOf: Int32Array
  stitches: Uint32Array
  /** 每个顶点的边类型（EDGE_KINDS 下标；内部点为 −1）/ Edge kind of each vertex (index into EDGE_KINDS; −1 inside). */
  edgeKind: Int8Array
  missingSegments: number
}

function relToAbs(a: V2, b: V2, rel: number[]): V2 {
  const ex = b[0] - a[0], ey = b[1] - a[1]
  return [a[0] + rel[0]! * ex - rel[1]! * ey, a[1] + rel[0]! * ey + rel[1]! * ex]
}

/** 曲边的参数式（t ∈ [0, 1]）/ The edge curve as a function of t ∈ [0, 1]. */
export function edgeCurve(panel: GcPanel, e: GcEdge): (t: number) => V2 {
  const a = panel.vertices[e.endpoints[0]]!, b = panel.vertices[e.endpoints[1]]!
  const c = e.curvature
  if (!c) return (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  if (Array.isArray(c) || c.type === 'quadratic') {
    const rel = Array.isArray(c) ? c : ((c.params as number[][])[0] as number[])
    const p = relToAbs(a, b, rel)
    return (t) => {
      const s = 1 - t
      return [s * s * a[0] + 2 * s * t * p[0] + t * t * b[0], s * s * a[1] + 2 * s * t * p[1] + t * t * b[1]]
    }
  }
  if (c.type === 'cubic') {
    const [r1, r2] = c.params as number[][]
    const p = relToAbs(a, b, r1!), q = relToAbs(a, b, r2!)
    return (t) => {
      const s = 1 - t
      return [
        s * s * s * a[0] + 3 * s * s * t * p[0] + 3 * s * t * t * q[0] + t * t * t * b[0],
        s * s * s * a[1] + 3 * s * s * t * p[1] + 3 * s * t * t * q[1] + t * t * t * b[1],
      ]
    }
  }
  // SVG 圆弧（端点参数化，W3C SVG 1.1 附录 F.6.5；svgpathtools 同样不翻转 y）
  // an SVG arc (endpoint parameterisation, W3C SVG 1.1 appendix F.6.5; svgpathtools does not flip y either)
  const [r0, large, sweep] = c.params as number[]
  const x1p = (a[0] - b[0]) / 2, y1p = (a[1] - b[1]) / 2
  let r = r0!
  const lam = (x1p * x1p + y1p * y1p) / (r * r)
  if (lam > 1) r *= Math.sqrt(lam)
  const num = r * r - (x1p * x1p + y1p * y1p)
  const coef = (Boolean(large) !== Boolean(sweep) ? 1 : -1) * Math.sqrt(Math.max(0, num / (x1p * x1p + y1p * y1p)))
  const cxp = coef * y1p, cyp = -coef * x1p
  const cx = cxp + (a[0] + b[0]) / 2, cy = cyp + (a[1] + b[1]) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number): number => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const th1 = ang(1, 0, (x1p - cxp) / r, (y1p - cyp) / r)
  let dth = ang((x1p - cxp) / r, (y1p - cyp) / r, (-x1p - cxp) / r, (-y1p - cyp) / r)
  if (!sweep && dth > 0) dth -= 2 * Math.PI
  if (sweep && dth < 0) dth += 2 * Math.PI
  return (t) => [cx + r * Math.cos(th1 + t * dth), cy + r * Math.sin(th1 + t * dth)]
}

/** 取样一条边：n 段、n + 1 个点，按（缩放后的）弧长均匀 / Sample an edge: n segments, n + 1 points, uniform in (scaled) arc length. */
function sampleEdge(f: (t: number) => V2, n: number, sx: number, sy: number): V2[] {
  const dense = 400
  const pts: V2[] = []
  const cum = [0]
  for (let i = 0; i <= dense; i++) {
    const p = f(i / dense)
    pts.push([p[0] * sx, p[1] * sy])
    if (i > 0) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]))
  }
  const L = cum[dense]!
  const out: V2[] = []
  let j = 0
  for (let k = 0; k <= n; k++) {
    const s = (L * k) / n
    while (j < dense - 1 && cum[j + 1]! < s) j++
    const t = cum[j + 1]! > cum[j]! ? (s - cum[j]!) / (cum[j + 1]! - cum[j]!) : 0
    out.push([pts[j]![0] + (pts[j + 1]![0] - pts[j]![0]) * t, pts[j]![1] + (pts[j + 1]![1] - pts[j]![1]) * t])
  }
  out[0] = pts[0]!
  out[n] = pts[dense]!
  return out
}

function edgeLength(f: (t: number) => V2, sx: number, sy: number): number {
  let L = 0
  let p = f(0)
  for (let i = 1; i <= 200; i++) {
    const q = f(i / 200)
    L += Math.hypot((q[0] - p[0]) * sx, (q[1] - p[1]) * sy)
    p = q
  }
  return L
}

/** Maya 约定的 xyz 内旋欧拉角（度）→ 矩阵，R = Rz·Ry·Rx / Maya-style intrinsic xyz Euler angles (degrees) → matrix, R = Rz·Ry·Rx. */
function eulerXYZ(e: [number, number, number]): number[] {
  const [x, y, z] = e.map((d) => (d * Math.PI) / 180) as [number, number, number]
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z)
  // Rz·Ry·Rx，行主序 / row-major
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ]
}

/**
 * 给整件衣服划网格。`spacing`：目标边长（米）。
 * Mesh a whole garment. `spacing`: the target edge length (metres).
 */
export function meshGarment(spec: GcSpec, spacing: number): GarmentMesh {
  const names = Object.keys(spec.pattern.panels).sort()
  const ease = spec.soma.ease ?? 1, lengthScale = spec.soma.lengthScale ?? 1
  const scaleOf = (p: GcPanel): [number, number] => {
    // 厘米 → 米；围度方向乘 ease，布纹方向乘 lengthScale / cm → m; ease across the girth, lengthScale along the grain
    const s = 0.01
    return p.grain === 'x' ? [s * lengthScale, s * ease] : [s * ease, s * lengthScale]
  }
  // 每条边的段数：缝在一起的取两边的较大者 / segments per edge: the larger of the two for sewn edges
  const segs = new Map<string, number>()
  const curve = (name: string, i: number): ((t: number) => V2) => edgeCurve(spec.pattern.panels[name]!, spec.pattern.panels[name]!.edges[i]!)
  const lenOf = (name: string, i: number): number => {
    const [sx, sy] = scaleOf(spec.pattern.panels[name]!)
    return edgeLength(curve(name, i), sx, sy)
  }
  const stitched = new Set<string>()
  const stitchList: [{ panel: string; edge: number }, { panel: string; edge: number }, boolean][] = []
  for (const s of spec.pattern.stitches) {
    const a = s[0] as { panel: string; edge: number }, b = s[1] as { panel: string; edge: number }
    const swap = !(s.length === 3 && s[2] === 'right_wrong')
    stitchList.push([a, b, swap])
    const n = Math.max(1, Math.ceil(Math.max(lenOf(a.panel, a.edge), lenOf(b.panel, b.edge)) / spacing))
    for (const e of [a, b]) {
      const k = `${e.panel}/${e.edge}`
      segs.set(k, Math.max(segs.get(k) ?? 0, n))
      stitched.add(k)
    }
  }
  // 同一条边若参与两条缝：两边都取最大段数，再同步一次 / an edge in two stitches: both take the max, then synchronise once more
  for (let pass = 0; pass < 3; pass++) {
    for (const [a, b] of stitchList) {
      const ka = `${a.panel}/${a.edge}`, kb = `${b.panel}/${b.edge}`
      const n = Math.max(segs.get(ka)!, segs.get(kb)!)
      segs.set(ka, n)
      segs.set(kb, n)
    }
  }

  const panels: PanelMesh[] = []
  const uvAll: number[] = [], placedAll: number[] = [], triAll: number[] = [], panelOf: number[] = [], kindAll: number[] = []
  let missingSegments = 0
  names.forEach((name, pi) => {
    const p = spec.pattern.panels[name]!
    const [sx, sy] = scaleOf(p)
    const boundary: number[] = []
    const edgeVerts: number[][] = []
    const edgeKindOf: EdgeKind[] = []
    // 边界：各边首尾相接 / boundary: edges joined end to start
    for (let i = 0; i < p.edges.length; i++) {
      const e = p.edges[i]!
      const k = `${name}/${i}`
      const n = segs.get(k) ?? Math.max(1, Math.ceil(lenOf(name, i) / spacing))
      const pts = sampleEdge(curve(name, i), n, sx, sy)
      const start = boundary.length / 2
      const ids: number[] = []
      for (let q = 0; q < n; q++) {
        boundary.push(pts[q]![0], pts[q]![1])
        ids.push(start + q)
      }
      ids.push(-1) // 终点：下一条边的起点，稍后填 / the end point: the next edge's start, filled in below
      edgeVerts.push(ids)
      edgeKindOf.push(stitched.has(k) ? 'seam' : 'edge')
      if (i > 0 && p.edges[i - 1]!.endpoints[1] !== e.endpoints[0]) throw new Error(`cloth: ${name} edge ${i} does not continue edge ${i - 1}`)
    }
    const nb = boundary.length / 2
    for (const ids of edgeVerts) ids[ids.length - 1] = (ids[ids.length - 2]! + 1) % nb
    // 不缝的边的类型：GarmentCode 的标签，或按位置 / unsewn edge kinds: GarmentCode's label, or by position
    const R = eulerXYZ(p.translation ? p.rotation : [0, 0, 0])
    const toPlaced = (x: number, y: number): [number, number, number] => {
      // GarmentCode：厘米；局部坐标先还原到未缩放（摆放按原裁片定）/ GarmentCode works in cm; local coordinates are unscaled first (placement is for the original panel)
      const lx = (x / sx) , ly = (y / sy)
      return [
        (R[0]! * lx + R[1]! * ly + p.translation[0]) / 100,
        (R[3]! * lx + R[4]! * ly + p.translation[1]) / 100,
        (R[6]! * lx + R[7]! * ly + p.translation[2]) / 100,
      ]
    }
    let minY = Infinity, maxY = -Infinity
    for (let q = 0; q < nb; q++) {
      const y = toPlaced(boundary[q * 2]!, boundary[q * 2 + 1]!)[1]
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
    p.edges.forEach((e, i) => {
      if (edgeKindOf[i] === 'seam') return
      const label = e.label ?? ''
      if (label.includes('collar')) edgeKindOf[i] = 'neckline'
      else if (label.includes('armhole')) edgeKindOf[i] = 'armhole'
      else if (p.part.startsWith('arm')) edgeKindOf[i] = 'cuff'
      else {
        const ys = edgeVerts[i]!.map((v) => toPlaced(boundary[v * 2]!, boundary[v * 2 + 1]!)[1])
        const my = ys.reduce((s, y) => s + y, 0) / ys.length
        if (name.startsWith('wb')) edgeKindOf[i] = my > (minY + maxY) / 2 ? 'waistband' : 'edge'
        else if (my < minY + 0.25 * (maxY - minY)) edgeKindOf[i] = 'hem'
        else edgeKindOf[i] = 'neckline'
      }
    })
    const tri = triangulatePolygon(boundary, spacing)
    missingSegments += tri.missing
    const count = tri.points.length / 2
    const offset = uvAll.length / 2
    const local = Float64Array.from(tri.points)
    const placed = new Float64Array(count * 3)
    let front = 0
    for (let q = 0; q < count; q++) {
      const x = local[q * 2]!, y = local[q * 2 + 1]!
      // 布纹坐标：经向（v）沿布纹轴；袖片旋转 90°（不镜像，三角形朝向不变）
      // fabric coordinates: warp (v) along the grain axis; sleeves rotated by 90° (no mirroring, triangle orientation kept)
      if (p.grain === 'x') uvAll.push(-y, x)
      else uvAll.push(x, y)
      const P = toPlaced(x, y)
      placed.set(P, q * 3)
      placedAll.push(...P)
      front += P[2]
      panelOf.push(pi)
      kindAll.push(-1)
    }
    for (let i = 0; i < edgeVerts.length; i++) {
      const k = EDGE_KINDS.indexOf(edgeKindOf[i]!)
      for (const v of edgeVerts[i]!) {
        // 角点同属两条边：缝合优先于其他 / a corner belongs to two edges: seams take precedence
        const cur = kindAll[offset + v]!
        if (cur === -1 || EDGE_KINDS[cur] !== 'seam') kindAll[offset + v] = k
      }
    }
    for (let t = 0; t < tri.triangles.length; t++) triAll.push(tri.triangles[t]! + offset)
    panels.push({ name, part: p.part, front: front / count > 0, offset, count, local, placed, edgeVerts, boundaryCount: nb })
  })

  // 缝合对 / stitch pairs
  const byName = new Map(panels.map((p) => [p.name, p]))
  const pairs: number[] = []
  for (const [a, b, swap] of stitchList) {
    const pa = byName.get(a.panel)!, pb = byName.get(b.panel)!
    let ra = pa.edgeVerts[a.edge]!.map((v) => v + pa.offset)
    const rb = pb.edgeVerts[b.edge]!.map((v) => v + pb.offset)
    if (swap) ra = ra.slice().reverse()
    if (ra.length !== rb.length) throw new Error(`cloth: stitch ${a.panel}/${a.edge} – ${b.panel}/${b.edge} has ${ra.length} and ${rb.length} points`)
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) pairs.push(ra[i]!, rb[i]!)
  }
  return {
    spec,
    panels,
    uv: Float64Array.from(uvAll),
    placed: Float64Array.from(placedAll),
    triangles: Uint32Array.from(triAll),
    panelOf: Int32Array.from(panelOf),
    stitches: Uint32Array.from(pairs),
    edgeKind: Int8Array.from(kindAll),
    missingSegments,
  }
}
