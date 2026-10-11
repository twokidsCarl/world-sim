// 读 OpenSim 模型（.osim，4.x 格式），不运行 OpenSim，直接由肌肉路径点算“肌腱单元长度—关节角”曲线。
// Reads an OpenSim model (.osim, 4.x format) and computes muscle-tendon length versus joint angle
// straight from the muscle path points, without running OpenSim.
//
// 用途：作为独立参照，检验本骨架里“肌肉形状跟随关节”是否在解剖学上合理（tools/rig/validate.ts）。
// 支持：CustomJoint / PinJoint / WeldJoint；PathPoint、ConditionalPathPoint、MovingPathPoint；
// LinearFunction、Constant、SimmSpline（自然三次样条）、PiecewiseLinearFunction、MultiplierFunction；
// WrapCylinder（单个圆柱的最短缠绕）。不支持 WrapEllipsoid / WrapSphere / WrapTorus（忽略并记录）。
// Purpose: an independent reference to check that "muscle shape follows the joints" is anatomically
// sensible in this rig (tools/rig/validate.ts). Supported: CustomJoint / PinJoint / WeldJoint;
// PathPoint, ConditionalPathPoint, MovingPathPoint; LinearFunction, Constant, SimmSpline (natural
// cubic), PiecewiseLinearFunction, MultiplierFunction; WrapCylinder (shortest wrap about a single
// cylinder). WrapEllipsoid / WrapSphere / WrapTorus are ignored and reported.

import { type M3, type V3, type Xf, M3_ID, XF_ID, add, axisAngle, len, m3mul, mul, norm, sub, xfApply, xfInv, xfMul } from './math.ts'

// ── 极简 XML / minimal XML ────────────────────────────────────────────────────────────────────

export interface XmlNode {
  tag: string
  name?: string
  children: XmlNode[]
  text: string
}

export function parseXml(src: string): XmlNode {
  const s = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '')
  const root: XmlNode = { tag: '#root', children: [], text: '' }
  const stack: XmlNode[] = [root]
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g
  let last = 0
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const top = stack[stack.length - 1]!
    top.text += s.slice(last, m.index)
    last = re.lastIndex
    if (m[1]) {
      stack.pop()
      continue
    }
    const node: XmlNode = { tag: m[2]!, children: [], text: '' }
    const nm = /\bname\s*=\s*"([^"]*)"/.exec(m[3] ?? '')
    if (nm) node.name = nm[1]
    top.children.push(node)
    if (!m[4]) stack.push(node)
  }
  return root
}

const child = (n: XmlNode | undefined, tag: string): XmlNode | undefined => n?.children.find((c) => c.tag === tag)
const text = (n: XmlNode | undefined, tag: string): string => (child(n, tag)?.text ?? '').trim()
const nums = (t: string): number[] => t.trim().split(/\s+/).filter(Boolean).map(Number)
function* walk(n: XmlNode): Generator<XmlNode> {
  yield n
  for (const c of n.children) yield* walk(c)
}

// ── 函数 / functions ──────────────────────────────────────────────────────────────────────────

export type Fn = (x: number) => number

/** 自然三次样条（两端二阶导为零），区间外线性外推。 Natural cubic spline (zero second derivative at the ends), linear extrapolation outside. */
export function naturalSpline(xs: number[], ys: number[]): Fn {
  const n = xs.length
  if (n === 0) return () => 0
  if (n === 1) return () => ys[0]!
  if (n === 2) return (x) => ys[0]! + ((ys[1]! - ys[0]!) * (x - xs[0]!)) / (xs[1]! - xs[0]!)
  const y2 = new Array<number>(n).fill(0), u = new Array<number>(n).fill(0)
  for (let i = 1; i < n - 1; i++) {
    const sig = (xs[i]! - xs[i - 1]!) / (xs[i + 1]! - xs[i - 1]!)
    const p = sig * y2[i - 1]! + 2
    y2[i] = (sig - 1) / p
    const d = (ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]!) - (ys[i]! - ys[i - 1]!) / (xs[i]! - xs[i - 1]!)
    u[i] = ((6 * d) / (xs[i + 1]! - xs[i - 1]!) - sig * u[i - 1]!) / p
  }
  for (let k = n - 2; k >= 0; k--) y2[k] = y2[k]! * y2[k + 1]! + u[k]!
  const slope = (i: number, atRight: boolean): number => {
    const h = xs[i + 1]! - xs[i]!
    const d = (ys[i + 1]! - ys[i]!) / h
    return atRight ? d + (h * (y2[i]! + 2 * y2[i + 1]!)) / 6 : d - (h * (2 * y2[i]! + y2[i + 1]!)) / 6
  }
  return (x) => {
    if (x <= xs[0]!) return ys[0]! + slope(0, false) * (x - xs[0]!)
    if (x >= xs[n - 1]!) return ys[n - 1]! + slope(n - 2, true) * (x - xs[n - 1]!)
    let lo = 0, hi = n - 1
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (xs[m]! > x) hi = m
      else lo = m
    }
    const h = xs[hi]! - xs[lo]!
    const a = (xs[hi]! - x) / h, b = (x - xs[lo]!) / h
    return a * ys[lo]! + b * ys[hi]! + (((a * a * a - a) * y2[lo]! + (b * b * b - b) * y2[hi]!) * h * h) / 6
  }
}

function parseFunction(n: XmlNode | undefined): Fn {
  if (!n) return () => 0
  switch (n.tag) {
    case 'Constant': return ((v) => () => v)(Number(text(n, 'value')) || 0)
    case 'LinearFunction': {
      const c = nums(text(n, 'coefficients'))
      return (x) => (c[0] ?? 1) * x + (c[1] ?? 0)
    }
    case 'SimmSpline':
    case 'NaturalCubicSpline': return naturalSpline(nums(text(n, 'x')), nums(text(n, 'y')))
    case 'PiecewiseLinearFunction': {
      const xs = nums(text(n, 'x')), ys = nums(text(n, 'y'))
      return (x) => {
        if (x <= xs[0]!) return ys[0]!
        for (let i = 1; i < xs.length; i++) if (x <= xs[i]!) return ys[i - 1]! + ((ys[i]! - ys[i - 1]!) * (x - xs[i - 1]!)) / (xs[i]! - xs[i - 1]!)
        return ys[ys.length - 1]!
      }
    }
    case 'MultiplierFunction': {
      const inner = parseFunction(child(n, 'function')?.children[0])
      const k = Number(text(n, 'scale')) || 1
      return (x) => k * inner(x)
    }
  }
  // 包装元素（<function> 或 <x_location> 等）：取里面第一个函数 / a wrapper element: take the first function inside
  return n.children.length ? parseFunction(n.children[0]) : () => 0
}

// ── 模型 / model ──────────────────────────────────────────────────────────────────────────────

const eulerXyz = (r: number[]): M3 => m3mul(m3mul(axisAngle([1, 0, 0], r[0] ?? 0), axisAngle([0, 1, 0], r[1] ?? 0)), axisAngle([0, 0, 1], r[2] ?? 0))
const last = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

interface OsJoint {
  parent: string
  child: string
  parentOffset: Xf
  childOffset: Xf
  motion: (q: Record<string, number>) => Xf
}

interface OsPathPoint {
  body: string
  location: (q: Record<string, number>) => V3
  active: (q: Record<string, number>) => boolean
}

interface OsWrap {
  body: string
  /** 圆柱坐标系 → 所在骨的坐标系。 Cylinder frame → body frame. */
  frame: Xf
  radius: number
  range: [number, number]
}

export interface OsMuscle {
  name: string
  points: OsPathPoint[]
  wraps: OsWrap[]
  /** 被忽略的缠绕面（椭球等）。 Wrap surfaces that were ignored (ellipsoids …). */
  ignoredWraps: string[]
}

export class OsimModel {
  readonly joints = new Map<string, OsJoint>()
  readonly muscles = new Map<string, OsMuscle>()
  readonly coordinates: string[] = []
  readonly credits: string

  constructor(src: string) {
    const root = parseXml(src)
    const model = [...walk(root)].find((n) => n.tag === 'Model')!
    this.credits = text(model, 'credits')
    for (const j of child(child(model, 'JointSet'), 'objects')?.children ?? []) {
      const frames = new Map<string, { body: string; xf: Xf }>()
      for (const f of child(j, 'frames')?.children ?? []) {
        frames.set(f.name ?? '', { body: last(text(f, 'socket_parent')), xf: { r: eulerXyz(nums(text(f, 'orientation'))), t: (nums(text(f, 'translation')) as V3).length === 3 ? (nums(text(f, 'translation')) as V3) : [0, 0, 0] } })
      }
      const pf = frames.get(last(text(j, 'socket_parent_frame'))), cf = frames.get(last(text(j, 'socket_child_frame')))
      if (!pf || !cf) continue
      const coords = (child(j, 'coordinates')?.children ?? []).map((c) => c.name ?? '')
      this.coordinates.push(...coords)
      let motion: OsJoint['motion'] = () => XF_ID
      if (j.tag === 'CustomJoint') {
        const axes = (child(j, 'SpatialTransform')?.children ?? []).map((a) => ({
          axis: norm(nums(text(a, 'axis')) as V3),
          coord: text(a, 'coordinates').split(/\s+/)[0] ?? '',
          fn: parseFunction(a.children.find((c) => !['coordinates', 'axis'].includes(c.tag))),
        }))
        motion = (q) => {
          let r: M3 = M3_ID
          let t: V3 = [0, 0, 0]
          axes.forEach((a, i) => {
            const v = a.fn(a.coord ? (q[a.coord] ?? 0) : 0)
            if (i < 3) r = m3mul(r, axisAngle(a.axis, v))
            else t = add(t, mul(a.axis, v))
          })
          return { r, t }
        }
      } else if (j.tag === 'PinJoint') {
        const c = coords[0] ?? ''
        motion = (q) => ({ r: axisAngle([0, 0, 1], q[c] ?? 0), t: [0, 0, 0] })
      }
      this.joints.set(cf.body, { parent: pf.body, child: cf.body, parentOffset: pf.xf, childOffset: cf.xf, motion })
    }
    // 缠绕面：按名字查，记下所在的骨 / wrap surfaces by name, with the body they sit on
    const wrapObjects = new Map<string, { body: string; node: XmlNode }>()
    for (const b of child(child(model, 'BodySet'), 'objects')?.children ?? []) {
      for (const w of child(child(b, 'WrapObjectSet'), 'objects')?.children ?? []) wrapObjects.set(w.name ?? '', { body: b.name ?? '', node: w })
    }
    for (const f of child(child(model, 'ForceSet'), 'objects')?.children ?? []) {
      const gp = child(f, 'GeometryPath')
      const pps = child(child(gp, 'PathPointSet'), 'objects')
      if (!pps || !f.name) continue
      const points: OsPathPoint[] = pps.children.map((p) => {
        const body = last(text(p, 'socket_parent_frame'))
        if (p.tag === 'MovingPathPoint') {
          const fx = parseFunction(child(p, 'x_location')), fy = parseFunction(child(p, 'y_location')), fz = parseFunction(child(p, 'z_location'))
          const cx = last(text(p, 'socket_x_coordinate')), cy = last(text(p, 'socket_y_coordinate')), cz = last(text(p, 'socket_z_coordinate'))
          return { body, location: (q) => [fx(q[cx] ?? 0), fy(q[cy] ?? 0), fz(q[cz] ?? 0)], active: () => true }
        }
        const loc = nums(text(p, 'location')) as V3
        if (p.tag === 'ConditionalPathPoint') {
          const r = nums(text(p, 'range')), c = last(text(p, 'socket_coordinate'))
          return { body, location: () => loc, active: (q) => (q[c] ?? 0) >= r[0]! && (q[c] ?? 0) <= r[1]! }
        }
        return { body, location: () => loc, active: () => true }
      })
      const wraps: OsWrap[] = [], ignored: string[] = []
      for (const w of child(child(gp, 'PathWrapSet'), 'objects')?.children ?? []) {
        const obj = wrapObjects.get(text(w, 'wrap_object'))
        if (!obj) continue
        if (obj.node.tag !== 'WrapCylinder') {
          ignored.push(`${text(w, 'wrap_object')} (${obj.node.tag})`)
          continue
        }
        const rg = nums(text(w, 'range'))
        wraps.push({ body: obj.body, frame: { r: eulerXyz(nums(text(obj.node, 'xyz_body_rotation'))), t: nums(text(obj.node, 'translation')) as V3 }, radius: Number(text(obj.node, 'radius')), range: [rg[0] ?? -1, rg[1] ?? -1] })
      }
      this.muscles.set(f.name, { name: f.name, points, wraps, ignoredWraps: ignored })
    }
  }

  /** 各骨在地面坐标系中的位姿。 Pose of every body in the ground frame. */
  bodyTransforms(q: Record<string, number>): Map<string, Xf> {
    const out = new Map<string, Xf>([['ground', XF_ID]])
    const visit = (b: string, depth: number): Xf => {
      const done = out.get(b)
      if (done) return done
      const j = this.joints.get(b)
      if (!j || depth > 64) {
        out.set(b, XF_ID)
        return XF_ID
      }
      const xf = xfMul(xfMul(xfMul(visit(j.parent, depth + 1), j.parentOffset), j.motion(q)), xfInv(j.childOffset))
      out.set(b, xf)
      return xf
    }
    for (const b of this.joints.keys()) visit(b, 0)
    return out
  }

  /** 肌腱单元长度（米）。 Muscle-tendon length, metres. */
  length(muscle: string, q: Record<string, number>): number {
    const m = this.muscles.get(muscle)
    if (!m) throw new Error(`opensim: no muscle ${muscle}`)
    const bodies = this.bodyTransforms(q)
    const pts = m.points.filter((p) => p.active(q)).map((p) => xfApply(bodies.get(p.body) ?? XF_ID, p.location(q)))
    const segLen = pts.slice(1).map((p, i) => len(sub(p, pts[i]!)))
    // 每个圆柱：只缠绕它切入最深的那一段 / every cylinder wraps only the segment it cuts deepest
    for (const w of m.wraps) {
      const world = xfMul(bodies.get(w.body) ?? XF_ID, w.frame)
      const inv = xfInv(world)
      let best = -1, bestDepth = 0, bestLen = 0
      for (let i = 0; i + 1 < pts.length; i++) {
        const r = wrapCylinder(xfApply(inv, pts[i]!), xfApply(inv, pts[i + 1]!), w.radius)
        if (r && r.depth > bestDepth) (best = i), (bestDepth = r.depth), (bestLen = r.length)
      }
      if (best >= 0) segLen[best] = Math.max(segLen[best]!, bestLen)
    }
    return segLen.reduce((a, b) => a + b, 0)
  }
}

/**
 * 两点绕无限长圆柱（轴为 z，半径 r）的最短路径长度；线段不与圆柱相交时返回 null。
 * Length of the shortest path between two points around an infinite cylinder (axis z, radius r);
 * null when the straight segment does not cut the cylinder.
 */
export function wrapCylinder(p: V3, s: V3, r: number): { length: number; depth: number } | null {
  const P: [number, number] = [p[0], p[1]], S: [number, number] = [s[0], s[1]]
  const dp = Math.hypot(P[0], P[1]), ds = Math.hypot(S[0], S[1])
  if (dp <= r || ds <= r) return null
  const d: [number, number] = [S[0] - P[0], S[1] - P[1]]
  const l2 = d[0] * d[0] + d[1] * d[1]
  if (l2 < 1e-12) return null
  const t = -(P[0] * d[0] + P[1] * d[1]) / l2
  if (t <= 0 || t >= 1) return null
  const cx = P[0] + t * d[0], cy = P[1] + t * d[1]
  const dist = Math.hypot(cx, cy)
  if (dist >= r) return null
  // 两条切线之间的弧：从 P 的切点到 S 的切点，走线段经过的那一侧（短弧）
  // the arc between the tangent points of P and S, on the side the segment passes (the short way)
  const aP = Math.atan2(P[1], P[0]), aS = Math.atan2(S[1], S[0])
  let between = aS - aP
  while (between > Math.PI) between -= 2 * Math.PI
  while (between < -Math.PI) between += 2 * Math.PI
  const arc = Math.abs(between) - Math.acos(r / dp) - Math.acos(r / ds)
  if (arc <= 0) return null
  const lxy = Math.sqrt(dp * dp - r * r) + Math.sqrt(ds * ds - r * r) + r * arc
  return { length: Math.hypot(lxy, s[2] - p[2]), depth: r - dist }
}
