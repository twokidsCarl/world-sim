// 把 Z-Anatomy / Open3DModel 包（神经、淋巴结、甲状腺、韧带、筋膜）导入 BodyParts3D 4.0 空间。
//
// 该包自带锚点：源图谱中与我们的部件匹配的结构，每个都带有一个变到我们空间的刚性 ICP 变换。
// 与 3.0 版（import3.ts）一样，锚点表面采样点经各自的刚性拟合映射后，驱动一个平滑形变场
// （register.buildDeformation）——但这里每个源坐标系、每个身体侧别各有一个形变场：
//   坐标系 "za"（Z-Anatomy）与 "o3d"（Open3DModel）的骨不同，所以各用各的锚点；
//          Open3DModel 只带有它重新建模的骨（四肢、肢带、胸骨、C1–C2、骶骨），因此凡是
//          Open3DModel 自身没有的结构（椎骨、肋骨、颅骨、未改动的软组织），都把 Z-Anatomy 的
//          锚点以较低权重加进去——Open3DModel 源自 Z-Anatomy，两个坐标系在这些地方一致
//   侧别   Open3DModel 的左半是镜像复制，而 BodyParts3D 并不对称，所以左侧条目只由左侧 +
//          中线锚点驱动，右侧条目只由右侧 + 中线锚点驱动
//
// 神经不作为网格来形变：先对其中心线做形变，清除与骨的碰撞，简化，再重建管状网格（tube.ts），
// 并保留源数据的半径。
//
// Importing the Z-Anatomy / Open3DModel package (nerves, lymph nodes, thyroid, ligaments, fasciae)
// into BodyParts3D 4.0 space.
//
// The package ships anchors: source-atlas structures matched to our parts, each with a rigid ICP
// transform into our space. As for release 3.0 (import3.ts), anchor surface points mapped through
// their own rigid fit drive one smooth deformation (register.buildDeformation) — but here one
// deformation per source frame and body side:
//   frame  "za" (Z-Anatomy) and "o3d" (Open3DModel) have different bones, so each uses its own
//          anchors; Open3DModel only ships the bones it remodelled (limbs, girdles, sternum,
//          C1–C2, sacrum), so Z-Anatomy anchors for every structure Open3DModel does not have
//          itself (vertebrae, ribs, skull, unchanged soft tissue) are added to it at reduced
//          weight — Open3DModel started from Z-Anatomy and the frames agree there
//   side   Open3DModel's left half is a mirror copy while BodyParts3D is not symmetric, so a
//          left item is driven by left + midline anchors only, a right item by right + midline
//
// Nerves are not warped as meshes: their centrelines are warped, cleaned of bone collisions,
// simplified, and the tubes rebuilt (tube.ts), keeping the source radii.

import type { Mesh } from './geometry.ts'
import { HARD_TISSUES, pushOutOfSolids, type ExistingPart, type SurfaceField } from './import3.ts'
import { applyRigid, buildDeformation, icp, PointIndex, surfacePoints, thinPoints, type Deformation, type Rigid } from './register.ts'
import { buildTube, mergeMeshes, polylineLength, simplifyPolyline, type Polyline } from './tube.ts'
import type { ZaAnchor, ZaBranch, ZaPackage } from './zanatomy.ts'

export interface ZaRegisterOptions {
  anchorSpacing: number
  minSigma: number
  k: number
  /** 置信度 / confidence = 1 / (1 + (p95 / softP95)²) */
  softP95: number
  /** 标记为 `resculpted` 的锚点的额外系数 / extra factor on anchors flagged `resculpted` */
  resculptedWeight: number
  /**
   * Z-Anatomy 锚点用于 Open3DModel 坐标系时的权重系数（0 = 不使用）
   * weight factor of Z-Anatomy anchors when used for the Open3DModel frame (0 = unused)
   */
  crossFrameWeight: number
  /**
   * 骨锚点：刚性拟合之后，若 BodyParts3D 骨表面上的最近点在 `snapDistance` 以内，就把锚点
   * 移到该最近点上。各图谱之间的骨被重新雕刻过（股骨、髋骨、胫骨：刚性 p95 为 4–8 mm），
   * 而神经沿骨表面走行，所以必须对应的是表面，而不是刚性位姿。0 表示禁用。
   *
   * Bone anchors: after the rigid fit, each anchor point is moved onto the nearest point of the
   * BodyParts3D bone surface when that is within `snapDistance`. Bones were re-sculpted between
   * the atlases (femur, hip bone, tibia: rigid p95 4–8 mm), and nerves run along bone surfaces,
   * so the surface, not the rigid pose, is what must correspond. 0 disables.
   */
  snapDistance: number
}

export const ZA_REGISTER_DEFAULTS: ZaRegisterOptions = {
  anchorSpacing: 0.005,
  minSigma: 0.008,
  k: 32,
  softP95: 0.002,
  resculptedWeight: 0.5,
  crossFrameWeight: 0.5,
  snapDistance: 0.012,
}

interface AnchorPoints {
  anchor: ZaAnchor
  from: Float32Array
  to: Float32Array
  conf: number
}

export type FrameSide = `${'za' | 'o3d'}:${'L' | 'R' | 'M'}`

export interface ZaRegistration {
  /** 给定坐标系和侧别的条目所用的形变场 / Deformation for an item of the given frame and side. */
  deformation(frame: 'za' | 'o3d', side: 'L' | 'R' | 'M'): Deformation
  /**
   * 按坐标系/侧别：所用锚点数、锚点采样点数、锚点处的拟合残差（各结构的均值，米）
   * per frame/side: anchors used, anchor points, fit residual at the anchors (per structure mean, m)
   */
  stats(): Record<string, { structures: number; bone: number; soft: number; crossFrame: number; points: number; residualMedian: number; residualP90: number; residualMax: number }>
  /**
   * 每个锚点的留结构交叉验证误差（米），针对它所属的坐标系/侧别形变场
   * leave-structures-out error per anchor (m), for the frame/side deformation it belongs to
   */
  crossValidate(folds?: number): { frame: string; side: string; name: string; anchorClass: string; error: number }[]
  anchorsUsed: number
  anchorsSkipped: { name: string; side: string; source: string; reason: string }[]
}

const applyIcp = (a: ZaAnchor, pts: Float32Array): Float32Array => {
  const [r0, r1, r2] = a.icp.R as [number[], number[], number[]]
  const t = a.icp.t
  const out = new Float32Array(pts.length)
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i]!
    const y = pts[i + 1]!
    const z = pts[i + 2]!
    out[i] = r0[0]! * x + r0[1]! * y + r0[2]! * z + t[0]
    out[i + 1] = r1[0]! * x + r1[1]! * y + r1[2]! * z + t[1]
    out[i + 2] = r2[0]! * x + r2[1]! * y + r2[2]! * z + t[2]
  }
  return out
}

const concat = (arrays: Float32Array[]): Float32Array => {
  const out = new Float32Array(arrays.reduce((s, a) => s + a.length, 0))
  let o = 0
  for (const a of arrays) {
    out.set(a, o)
    o += a.length
  }
  return out
}
const quantile = (values: number[], p: number): number => {
  const s = [...values].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]! : 0
}

export function registerZa(pkg: ZaPackage, field: SurfaceField, opts: ZaRegisterOptions = ZA_REGISTER_DEFAULTS): ZaRegistration {
  const indexOf = new Map(field.parts.map((p, i) => [p.id, i]))
  const I = new Int32Array(1)
  const D = new Float64Array(1)
  const byFrame: Record<'za' | 'o3d', AnchorPoints[]> = { za: [], o3d: [] }
  const skipped: ZaRegistration['anchorsSkipped'] = []
  for (const a of pkg.anchors) {
    if (!a.bp3dIds.every((id) => indexOf.has(id))) {
      skipped.push({ name: a.name, side: a.side, source: a.source, reason: 'its BodyParts3D part is not in the dataset' })
      continue
    }
    const from = thinPoints(surfacePoints(pkg.mesh(a.files.mesh), opts.anchorSpacing), opts.anchorSpacing)
    if (!from.length) continue
    const to = applyIcp(a, from)
    let snapped = false
    if (a.anchorClass === 'bone' && opts.snapDistance > 0) {
      const targets = a.bp3dIds.map((id) => field.surfaceIndex(indexOf.get(id)!))
      for (let i = 0; i < to.length; i += 3) {
        let best = opts.snapDistance * opts.snapDistance
        let bx = NaN
        let by = 0
        let bz = 0
        for (const t of targets) {
          if (!t.nearest(to[i]!, to[i + 1]!, to[i + 2]!, 1, I, D, opts.snapDistance) || D[0]! >= best) continue
          best = D[0]!
          bx = t.points[3 * I[0]!]!
          by = t.points[3 * I[0]! + 1]!
          bz = t.points[3 * I[0]! + 2]!
        }
        if (Number.isNaN(bx)) continue
        to[i] = bx
        to[i + 1] = by
        to[i + 2] = bz
        snapped = true
      }
    }
    // 已吸附的骨在吸附半径内可信；否则置信度随刚性残差下降
    // a snapped bone is trusted to the snap radius; otherwise confidence falls with the rigid residual
    const conf = snapped ? (a.resculpted ? 0.7 : 1) : (1 / (1 + (a.residualP95Mm / 1000 / opts.softP95) ** 2)) * (a.resculpted ? opts.resculptedWeight : 1)
    byFrame[a.frame].push({ anchor: a, from, to, conf })
  }
  const select = (frame: 'za' | 'o3d', side: 'L' | 'R' | 'M'): { list: AnchorPoints[]; weights: number[] } => {
    const sideOk = (a: ZaAnchor) => side === 'M' || a.side === 'M' || a.side === side
    const list = byFrame[frame].filter((x) => sideOk(x.anchor))
    const weights = list.map((x) => x.conf)
    if (frame === 'o3d' && opts.crossFrameWeight > 0) {
      const own = new Set(byFrame.o3d.map((x) => x.anchor.name))
      for (const x of byFrame.za) {
        if (own.has(x.anchor.name) || !sideOk(x.anchor)) continue
        list.push(x)
        weights.push(x.conf * opts.crossFrameWeight)
      }
    }
    return { list, weights }
  }
  const build = (list: AnchorPoints[], weights: number[]): Deformation => {
    const w: number[] = []
    list.forEach((x, i) => {
      for (let k = 0; k < x.from.length / 3; k++) w.push(weights[i]!)
    })
    return buildDeformation(concat(list.map((x) => x.from)), concat(list.map((x) => x.to)), { minSigma: opts.minSigma, k: opts.k, weights: Float32Array.from(w) })
  }
  const cache = new Map<string, Deformation>()
  const deformation = (frame: 'za' | 'o3d', side: 'L' | 'R' | 'M'): Deformation => {
    const key = `${frame}:${side}`
    let d = cache.get(key)
    if (!d) {
      const { list, weights } = select(frame, side)
      if (!list.length) throw new Error(`no anchors for ${key}`)
      cache.set(key, (d = build(list, weights)))
    }
    return d
  }
  const meanError = (def: Deformation, x: AnchorPoints): number => {
    const out = def.apply(x.from)
    let sum = 0
    for (let i = 0; i < out.length; i += 3) sum += Math.hypot(out[i]! - x.to[i]!, out[i + 1]! - x.to[i + 1]!, out[i + 2]! - x.to[i + 2]!)
    return sum / (out.length / 3)
  }
  const KEYS: ['za' | 'o3d', 'L' | 'R' | 'M'][] = [['za', 'L'], ['za', 'R'], ['za', 'M'], ['o3d', 'L'], ['o3d', 'R']]
  return {
    deformation,
    anchorsUsed: byFrame.za.length + byFrame.o3d.length,
    anchorsSkipped: skipped,
    stats() {
      const out: ReturnType<ZaRegistration['stats']> = {}
      for (const [frame, side] of KEYS) {
        const { list } = select(frame, side)
        if (!list.length) continue
        const def = deformation(frame, side)
        const res = list.map((x) => meanError(def, x))
        out[`${frame}:${side}`] = {
          structures: list.length,
          bone: list.filter((x) => x.anchor.frame === frame && x.anchor.anchorClass === 'bone').length,
          soft: list.filter((x) => x.anchor.frame === frame && x.anchor.anchorClass === 'soft').length,
          crossFrame: list.filter((x) => x.anchor.frame !== frame).length,
          points: list.reduce((s, x) => s + x.from.length / 3, 0),
          residualMedian: quantile(res, 0.5),
          residualP90: quantile(res, 0.9),
          residualMax: quantile(res, 1),
        }
      }
      return out
    },
    crossValidate(folds = 8) {
      const out: ReturnType<ZaRegistration['crossValidate']> = []
      for (const [frame, side] of KEYS) {
        if (side === 'M' && frame === 'o3d') continue
        const { list, weights } = select(frame, side)
        for (let f = 0; f < folds; f++) {
          const keep = list.map((_, i) => i % folds !== f)
          const def = build(list.filter((_, i) => keep[i]), weights.filter((_, i) => keep[i]))
          list.forEach((x, i) => {
            // 每个锚点只计分一次，用它自身侧别的形变场（中线锚点用 M）
            // an anchor is scored once, under the deformation of its own side (midline under M)
            if (keep[i] || x.anchor.frame !== frame || (side === 'M' ? x.anchor.side !== 'M' : x.anchor.side !== side)) return
            out.push({ frame, side, name: x.anchor.name, anchorClass: x.anchor.anchorClass, error: meanError(def, x) })
          })
        }
      }
      return out
    },
  }
}

// ── 神经 / Nerves ────────────────────────────────────────────────────────────────────────────────────

/** 米 / m */
export const MIN_NERVE_RADIUS = 0.00005

export const toPolyline = (b: ZaBranch): Polyline => {
  const points = new Float32Array(b.points.length * 3)
  b.points.forEach((p, i) => points.set(p, 3 * i))
  // 有些源管状体在末端收细到半径 0；保留发丝般的宽度，以免环塌缩
  // some source tubes taper to radius 0 at their tips; keep a hair's width so rings do not collapse
  return { points, radius: Float32Array.from(b.radius, (r) => Math.max(r, MIN_NERVE_RADIUS)) }
}

/**
 * 把折线重采样为间距不超过 `step` 的点（保留原有的点）。
 * Resample a polyline to points at most `step` apart (keeps the original points).
 */
export function densify(line: Polyline, step: number): Polyline {
  const n = line.points.length / 3
  const pts: number[] = []
  const rad: number[] = []
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const ax = line.points[3 * i - 3]!
      const ay = line.points[3 * i - 2]!
      const az = line.points[3 * i - 1]!
      const dx = line.points[3 * i]! - ax
      const dy = line.points[3 * i + 1]! - ay
      const dz = line.points[3 * i + 2]! - az
      const m = Math.ceil(Math.hypot(dx, dy, dz) / step)
      for (let k = 1; k < m; k++) {
        const t = k / m
        pts.push(ax + dx * t, ay + dy * t, az + dz * t)
        rad.push(line.radius[i - 1]! + (line.radius[i]! - line.radius[i - 1]!) * t)
      }
    }
    pts.push(line.points[3 * i]!, line.points[3 * i + 1]!, line.points[3 * i + 2]!)
    rad.push(line.radius[i]!)
  }
  return { points: Float32Array.from(pts), radius: Float32Array.from(rad) }
}

export interface PathStats {
  /** 米 / m */
  length: number
  /**
   * 位于硬组织（骨、牙、软骨）内的长度比例，不含管道
   * fraction of the length inside hard tissue (bone, tooth, cartilage), canals excluded
   */
  inBone: number
  /**
   * 位于该神经本应穿行的骨内的长度比例（见 NerveBuildOptions.canal）
   * fraction of the length inside bones the nerve is expected to traverse (see NerveBuildOptions.canal)
   */
  inCanal: number
  /**
   * 位于肌内且距任何表面超过 `deep` 的长度比例
   * fraction of the length inside muscle and more than `deep` from any surface
   */
  deepInMuscle: number
  /** 进入的骨：[名称, 骨内长度（米）] / bones entered: [name, length inside in m] */
  bones: [string, number][]
  muscles: [string, number][]
}

/**
 * 按长度统计一组中心线相对于现有实体的走行位置。沿每条分支每隔 `step` 检测一个点。
 * Where a set of centrelines runs relative to the existing solids, by length. Points are tested
 * every `step` along each branch.
 */
export function pathStats(branches: Polyline[], field: SurfaceField, canal: (boneName: string) => boolean = () => false, step = 0.001, deep = 0.003): PathStats {
  let length = 0
  let bone = 0
  let muscle = 0
  let inCanal = 0
  const bones = new Map<number, number>()
  const muscles = new Map<number, number>()
  const hard = field.parts.map((p) => HARD_TISSUES.includes(p.tissue))
  const soft = field.parts.map((p) => p.tissue === 'muscle')
  for (const b of branches) {
    const d = densify(b, step)
    const n = d.points.length / 3
    if (n < 2) continue
    let bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
      bbox[k] = Math.min(bbox[k]!, d.points[3 * i + k]!)
      bbox[k + 3] = Math.max(bbox[k + 3]!, d.points[3 * i + k]!)
    }
    const cand: number[] = []
    field.parts.forEach((p, i) => {
      if (!hard[i] && !soft[i]) return
      const pb = p.stats.bbox
      if (pb[0] > bbox[3]! || pb[3] < bbox[0]! || pb[1] > bbox[4]! || pb[4] < bbox[1]! || pb[2] > bbox[5]! || pb[5] < bbox[2]!) return
      cand.push(i)
    })
    for (let i = 0; i < n; i++) {
      const x = d.points[3 * i]!
      const y = d.points[3 * i + 1]!
      const z = d.points[3 * i + 2]!
      // 该采样点所代表的长度：相邻两段各取一半
      // length represented by this sample: half of each adjacent segment
      const seg = (j: number) => Math.hypot(d.points[3 * j]! - d.points[3 * j - 3]!, d.points[3 * j + 1]! - d.points[3 * j - 2]!, d.points[3 * j + 2]! - d.points[3 * j - 1]!)
      const w = (i > 0 ? seg(i) / 2 : 0) + (i < n - 1 ? seg(i + 1) / 2 : 0)
      length += w
      for (const c of cand) {
        const pb = field.parts[c]!.stats.bbox
        if (x < pb[0] || x > pb[3] || y < pb[1] || y > pb[4] || z < pb[2] || z > pb[5]) continue
        if (!field.tester(c).contains(x, y, z)) continue
        if (hard[c]) {
          if (canal(field.parts[c]!.name)) inCanal += w
          else {
            bone += w
            bones.set(c, (bones.get(c) ?? 0) + w)
          }
        } else if (field.surfaceIndex(c).distance(x, y, z, deep) >= deep) {
          muscle += w
          muscles.set(c, (muscles.get(c) ?? 0) + w)
        } else continue
        break
      }
    }
  }
  const top = (m: Map<number, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([i, v]) => [field.parts[i]!.name, v] as [string, number])
  return { length, inBone: length ? bone / length : 0, inCanal: length ? inCanal / length : 0, deepInMuscle: length ? muscle / length : 0, bones: top(bones), muscles: top(muscles) }
}

export interface NerveBuildOptions {
  /** 做形变和碰撞检测的点的间距 / spacing of the points that are warped and collision-checked */
  step: number
  /** 生成网格前折线简化的容差 / polyline simplification tolerance before meshing */
  tolerance: number
  maxSegment: number
  /**
   * 按分支最大半径确定管的边数：[半径小于（米）, 边数]，取第一个匹配项；否则用 `sides`
   * tube sides by the branch's largest radius: [radius below (m), sides], first match; `sides` otherwise
   */
  sidesByRadius: [number, number][]
  sides: number
  /** 清理：中心线上的点为离开骨最多可滑移多远 / clean-up: how far a centreline point may be slid to leave bone */
  maxPush: number
  /**
   * 清理：中心线上的点为离开肌腹最多可滑移多远（0 = 让神经留在肌内）
   * clean-up: how far a centreline point may be slid to leave a muscle belly (0 = leave nerves in muscle)
   */
  maxMusclePush: number
  /**
   * 距骨表面在此距离以内时关闭肌清理，到两倍距离处逐渐完全生效
   * muscle clean-up is switched off within this distance of a bone surface, fading in up to twice it
   */
  boneGuard: number
  /**
   * 该神经本就穿行的骨（管、孔）：绝不把神经从中推出
   * bones this nerve legitimately runs through (canals, foramina): never pushed out of these
   */
  canal?: (boneName: string) => boolean
}

export const NERVE_BUILD_DEFAULTS: NerveBuildOptions = {
  step: 0.0015,
  tolerance: 0.00025,
  maxSegment: 0.012,
  sidesByRadius: [[0.00045, 5], [0.001, 6]],
  sides: 8,
  maxPush: 0.01,
  maxMusclePush: 0.015,
  boneGuard: 0.008,
}

export interface WarpedNerve {
  /** 最终的中心线（经清理和简化之后） / final centrelines (after clean-up and simplification) */
  branches: Polyline[]
  mesh: Mesh | null
  before: PathStats
  after: PathStats
  /** 被任一清理步骤移动的中心线点数 / centreline points moved by either clean-up */
  pushed: number
  /** 其中从骨内滑出的点数 / of those, slid out of bone */
  pushedOutOfBone: number
  points: number
  meanPush: number
}

/**
 * 对一条神经的中心线做形变，把点滑出硬组织，简化，重建管状网格。
 * Warp the centrelines of one nerve, slide points out of hard tissue, simplify, rebuild tubes.
 */
export function warpNerve(branches: ZaBranch[], def: Deformation, field: SurfaceField, opts: NerveBuildOptions = NERVE_BUILD_DEFAULTS): WarpedNerve {
  return warpNerveLines(branches.filter((b) => b.points.length >= 2).map(toPolyline), def, field, opts)
}

/**
 * 同 `warpNerve`，用于已经是折线的中心线（例如从 nerves.json 读回的）。
 * As `warpNerve`, for centrelines that already are polylines (e.g. read back from nerves.json).
 */
export function warpNerveLines(lines: Polyline[], def: Deformation, field: SurfaceField, opts: NerveBuildOptions = NERVE_BUILD_DEFAULTS): WarpedNerve {
  const warped: Polyline[] = lines
    .filter((b) => b.points.length >= 6)
    .map((b) => {
      const d = densify(b, opts.step)
      return { points: def.apply(d.points), radius: d.radius }
    })
  const canal = opts.canal ?? (() => false)
  const before = pathStats(warped, field, canal)
  let pushed = 0
  let points = 0
  let pushSum = 0
  const slide = (lines: Polyline[], solid: (i: number) => boolean, maxPush: number, count: boolean): Polyline[] =>
    lines.map((b) => {
      const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
      for (let i = 0; i < b.points.length; i += 3) for (let k = 0; k < 3; k++) {
        bbox[k] = Math.min(bbox[k]!, b.points[i + k]!)
        bbox[k + 3] = Math.max(bbox[k + 3]!, b.points[i + k]!)
      }
      let maxR = 0
      for (const r of b.radius) if (r > maxR) maxR = r
      const res = pushOutOfSolids(b.points, bbox, field, solid, { clearance: Math.min(0.002, maxR) + 0.0003, maxPush, radius: 0.008, step: 0.0002 })
      if (count) {
        pushed += res.moved
        pushSum += res.meanPush * res.moved
      }
      return { points: res.positions, radius: b.radius }
    })
  for (const b of warped) points += b.points.length / 3
  let cleaned = warped
  const isBone = (i: number) => HARD_TISSUES.includes(field.parts[i]!.tissue) && !canal(field.parts[i]!.name)
  if (opts.maxMusclePush > 0 && before.deepInMuscle > 0) {
    // 先处理肌（两遍：离开一个肌腹可能落进相邻的肌腹），最后处理骨，
    // 使硬约束优先
    // muscle first (twice: leaving one belly can land in its neighbour), bone last so that the
    // hard constraint wins
    const isMuscle = (i: number) => field.parts[i]!.tissue === 'muscle'
    const slid = slide(slide(cleaned, isMuscle, opts.maxMusclePush, false), isMuscle, opts.maxMusclePush, false)
    // 在肌之下紧贴骨的神经（桡神经沟内的桡神经、肩胛骨上的肩胛上神经）位置本就正确：
    // 距骨表面 `boneGuard` 以内的点保持原位，保护作用在其后的 `boneGuard` 距离内逐渐消退，
    // 使线条保持平滑。
    // A nerve that hugs a bone under a muscle (radial nerve in the spiral groove, suprascapular
    // nerve on the scapula) is where it should be: points within `boneGuard` of a bone surface
    // keep their place, and the guard fades out over the next `boneGuard` so the line stays smooth.
    const hardParts: number[] = []
    field.parts.forEach((p, i) => {
      if (HARD_TISSUES.includes(p.tissue)) hardParts.push(i)
    })
    cleaned = cleaned.map((b, bi) => {
      const out = Float32Array.from(slid[bi]!.points)
      const n = b.points.length / 3
      const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
        bb[k] = Math.min(bb[k]!, b.points[3 * i + k]!)
        bb[k + 3] = Math.max(bb[k + 3]!, b.points[3 * i + k]!)
      }
      const g = opts.boneGuard
      const near = hardParts.filter((c) => {
        const pb = field.parts[c]!.stats.bbox
        return !(pb[0] > bb[3]! + 2 * g || pb[3] < bb[0]! - 2 * g || pb[1] > bb[4]! + 2 * g || pb[4] < bb[1]! - 2 * g || pb[2] > bb[5]! + 2 * g || pb[5] < bb[2]! - 2 * g)
      })
      for (let i = 0; i < n; i++) {
        const x = b.points[3 * i]!
        const y = b.points[3 * i + 1]!
        const z = b.points[3 * i + 2]!
        const moved = Math.hypot(out[3 * i]! - x, out[3 * i + 1]! - y, out[3 * i + 2]! - z)
        if (moved === 0) continue
        let d = Infinity
        for (const c of near) {
          const pb = field.parts[c]!.stats.bbox
          if (x < pb[0] - 2 * g || x > pb[3] + 2 * g || y < pb[1] - 2 * g || y > pb[4] + 2 * g || z < pb[2] - 2 * g || z > pb[5] + 2 * g) continue
          d = Math.min(d, field.surfaceIndex(c).distance(x, y, z, 2 * g))
        }
        // 保护范围内为 0，超过两倍保护距离为 1
        // 0 within the guard, 1 beyond twice the guard
        const w = d <= g ? 0 : d >= 2 * g ? 1 : (d - g) / g
        out[3 * i] = x + (out[3 * i]! - x) * w
        out[3 * i + 1] = y + (out[3 * i + 1]! - y) * w
        out[3 * i + 2] = z + (out[3 * i + 2]! - z) * w
        if (w > 0) {
          pushed++
          pushSum += moved * w
        }
      }
      return { points: out, radius: b.radius }
    })
  }
  const afterMuscle = pushed
  if (before.inBone > 0 || cleaned !== warped) cleaned = slide(cleaned, isBone, opts.maxPush, true)
  const pushedOutOfBone = pushed - afterMuscle
  const after = pushed ? pathStats(cleaned, field, canal) : before
  const final = cleaned.map((b) => simplifyPolyline(b, opts.tolerance, 0.15, opts.maxSegment))
  const tubes: Mesh[] = []
  for (const b of final) {
    let maxR = 0
    for (const r of b.radius) if (r > maxR) maxR = r
    const tube = buildTube(b, opts.sidesByRadius.find(([r]) => maxR < r)?.[1] ?? opts.sides)
    if (tube) tubes.push(tube)
  }
  return { branches: final, mesh: tubes.length ? mergeMeshes(tubes) : null, before, after, pushed, pushedOutOfBone, points, meanPush: pushed ? pushSum / pushed : 0 }
}

/** 一条神经的中心线总长度，米。 / Total centreline length of a nerve, m. */
export const nerveLength = (branches: Polyline[]): number => branches.reduce((s, b) => s + polylineLength(b.points), 0)

/**
 * 神经本就在其内部走行的骨（BodyParts3D 的骨网格把这些管和孔建成了实心，
 * 或者它们比配准误差还窄）。按名称匹配：[神经名称模式, 骨名称模式]。
 *
 * Bones a nerve legitimately runs inside (canals and foramina that the BodyParts3D bone meshes
 * model as solid or that are narrower than the registration error). Matched on names:
 * [nerve name pattern, bone name pattern].
 */
export const NERVE_CANALS: [RegExp, RegExp][] = [
  // 下颌管与颏孔；牙位于同一块骨内 / mandibular canal and mental foramen; teeth sit in the same bone
  [/inferior alveolar nerve|mental nerve|nerve to mylohyoid/i, /mandible|tooth/i],
  // 面神经管、内耳道、岩鼓裂 / facial canal, internal acoustic meatus, petrotympanic fissure
  [/facial nerve|chorda tympani|vestibulocochlear nerve/i, /temporal bone/i],
  // 颅底各孔与眶：脑神经及三叉神经的各分支
  // skull-base foramina and the orbit: cranial nerves and the divisions of the trigeminal nerve
  [/\((I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII)\)|trigeminal|ophthalmic nerve|maxillary nerve|mandibular nerve|lingual nerve|buccal nerve|meningeal branch/i, /sphenoid|temporal bone|occipital bone|ethmoid|maxilla|palatine|frontal bone|zygomatic/i],
  // 椎管、骶管与骶孔 / vertebral canal, sacral canal and the sacral foramina
  [/cauda equina|spinal ganglion|root of .*(spinal nerve|plexus)|root in cauda equina|\bS5 root\b|coccygeal nerve|sacral plexus|lumbosacral trunk/i, /sacrum|coccyx|vertebra/i],
]

export function canalFor(nerveName: string): (boneName: string) => boolean {
  const bones = NERVE_CANALS.filter(([n]) => n.test(nerveName)).map(([, b]) => b)
  return bones.length ? (bone) => bones.some((b) => b.test(bone)) : () => false
}

// ── 依据 FMA 确定树中位置 / Tree placement from FMA ───────────────────────────────────────────────────────────────────

export interface TreePath {
  /** 树中缺少时需要创建的概念，子概念在前：[id, 名称] / concepts to create when the tree lacks them, child first: [id, name] */
  path: [string, string][]
  /**
   * 路径最顶端条目（或部件本身）所挂靠的现有树概念；null = 未找到
   * existing tree concept the topmost path entry (or the part itself) hangs under; null = none found
   */
  anchor: string | null
  how: 'own concept' | 'FMA is-a chain' | 'by hand' | 'none'
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s)

/**
 * 一个 FMA 概念在可能并不包含它的树中的 IS-A 位置：沿 FMA 5.1.0 的 is-a 父类
 * （每一步取第一个父类）向上，直到遇到树中已有的概念，并返回途中经过的概念以便创建。
 * 当这条链始终没有与树相遇（或没有 FMA 数据）时，使用 `fallback` 指定的树概念。
 *
 * IS-A position of an FMA concept in a tree that may not know it: follow the FMA 5.1.0 is-a
 * parents (first parent at each step) until a concept the tree has, and return the concepts
 * passed on the way so they can be created. `fallback` names the tree concept to use when the
 * chain never meets the tree (or FMA data is unavailable).
 */
export function isaPathFromFma(
  fma: string,
  label: string,
  parents: (id: string) => string[] | undefined,
  labelOf: (id: string) => string | undefined,
  inTree: (id: string) => boolean,
  fallback: string | null,
): TreePath {
  if (inTree(fma)) return { path: [], anchor: fma, how: 'own concept' }
  const path: [string, string][] = [[fma, lowerFirst(label)]]
  const seen = new Set([fma])
  let cur = fma
  for (let depth = 0; depth < 40; depth++) {
    const p = parents(cur)?.[0]
    if (!p || seen.has(p)) break
    if (inTree(p)) return { path, anchor: p, how: 'FMA is-a chain' }
    seen.add(p)
    path.push([p, lowerFirst(labelOf(p) ?? p)])
    cur = p
  }
  // 没有交汇点：只保留概念本身，挂在 fallback 之下
  // no meeting point: keep only the concept itself under the fallback
  return { path: [path[0]!], anchor: fallback, how: fallback ? 'by hand' : 'none' }
}

/**
 * FMA 中没有对应类的结构所用的稳定概念 id。有意不采用 FMA id 的形式。
 * Stable concept id for a structure FMA has no class for. Not an FMA id on purpose.
 */
export function syntheticConceptId(name: string, side: 'L' | 'R' | 'M'): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `ZAC_${slug}${side === 'M' ? '' : `_${side}`}`
}

// ── 关节局部配准 / Local joint registration ──────────────────────────────────────────────────────────────────

export interface JointCacheEntry {
  index: PointIndex
  mapped: Float32Array
  /** 局部刚性拟合的旋转，行主序 / rotation of the local rigid fit, row-major */
  r: number[]
}

export interface JointFit {
  positions: Float32Array
  /**
   * 部件所挂靠的骨：锚点名称、我们的部件 id、在图谱中的最近距离（米）
   * bones the part was hung on: anchor name, our part ids, closest approach in the atlas (m)
   */
  bones: { name: string; side: string; bp3dIds: string[]; sourceGap: number }[]
}

/**
 * 跨骨部件（韧带、半月板）的配准：只依据它所连的骨，而不用全身的形变场。每个顶点保持它相对于
 * 所附着的每块骨上最近表面点的位置，每块骨先经各自的刚性拟合映射，再贴到我们的骨表面上，
 * 各骨给出的结果按远近（1/d²）加权混合。因此，在图谱中与骨相接的一端会落在我们的骨上；
 * 中间的跨越部分则跟随两端。
 * 在部件 `attachDistance` 范围内没有带锚点的骨时返回 null。
 *
 * Registration of a part that spans bones (a ligament, a meniscus) by its bones alone instead of
 * the body-wide field: every vertex keeps its position relative to the nearest surface point of
 * each bone it is attached to, each bone mapped by its own rigid fit and then onto our bone's
 * surface, and the bones' answers are blended by closeness (1/d²). An end that touches a bone in
 * the atlas therefore lands on our bone; the span in between follows both ends.
 * Returns null when no anchored bone lies within `attachDistance` of the part.
 */
export function localJointWarp(
  mesh: Mesh,
  frame: 'za' | 'o3d',
  side: 'L' | 'R' | 'M',
  pkg: ZaPackage,
  field: SurfaceField,
  cache: Map<string, JointCacheEntry>,
  attachDistance = 0.004,
  snapDistance = 0.006,
): JointFit | null {
  const indexOf = new Map(field.parts.map((p, i) => [p.id, i]))
  const v = mesh.positions
  const nv = v.length / 3
  let b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < v.length; i += 3) b = [Math.min(b[0]!, v[i]!), Math.min(b[1]!, v[i + 1]!), Math.min(b[2]!, v[i + 2]!), Math.max(b[3]!, v[i]!), Math.max(b[4]!, v[i + 1]!), Math.max(b[5]!, v[i + 2]!)]
  const I = new Int32Array(1)
  const D = new Float64Array(1)
  const candidates: { a: ZaAnchor; gap: number; entry: JointCacheEntry }[] = []
  for (const a of pkg.anchors) {
    if (a.frame !== frame || a.anchorClass !== 'bone') continue
    if (side !== 'M' && a.side !== 'M' && a.side !== side) continue
    if (!a.bp3dIds.every((id) => indexOf.has(id))) continue
    const ab = (a as unknown as { bbox: number[] }).bbox
    if (ab && (ab[0]! > b[3]! + attachDistance || ab[3]! < b[0]! - attachDistance || ab[1]! > b[4]! + attachDistance || ab[4]! < b[1]! - attachDistance || ab[2]! > b[5]! + attachDistance || ab[5]! < b[2]! - attachDistance)) continue
    // 图谱中该部件附近的骨表面，以及其中每个点在我们的骨上的位置。对重新雕刻过的骨，
    // 整骨刚性拟合在关节处有数毫米的偏差，所以在局部重做拟合：只用距部件 `LOCAL` 以内的
    // 骨表面，并以整骨拟合为初值。按骨和位置缓存。
    // The bone's surface in the atlas near this part, and where each of those points is on our
    // bone. Whole-bone rigid fits are off by several mm at the joint for re-sculpted bones, so
    // the fit is redone locally: only the bone surface within `LOCAL` of the part, starting from
    // the whole-bone fit. Cached per bone and place.
    const LOCAL = 0.04
    const key = `${a.id}|${Math.round(((b[0]! + b[3]!) / 2) * 50)}|${Math.round(((b[1]! + b[4]!) / 2) * 50)}|${Math.round(((b[2]! + b[5]!) / 2) * 50)}`
    let entry = cache.get(key)
    if (!entry) {
      const all = thinPoints(surfacePoints(pkg.mesh(a.files.mesh), 0.001), 0.0008)
      const near: number[] = []
      for (let i = 0; i < all.length; i += 3) {
        if (all[i]! < b[0]! - LOCAL || all[i]! > b[3]! + LOCAL || all[i + 1]! < b[1]! - LOCAL || all[i + 1]! > b[4]! + LOCAL || all[i + 2]! < b[2]! - LOCAL || all[i + 2]! > b[5]! + LOCAL) continue
        near.push(all[i]!, all[i + 1]!, all[i + 2]!)
      }
      const src = Float32Array.from(near)
      if (src.length < 90) continue
      const whole: Rigid = { r: (a.icp.R as number[][]).flat(), t: a.icp.t }
      const targets = a.bp3dIds.map((id) => field.surfaceIndex(indexOf.get(id)!))
      const target = targets.length === 1 ? targets[0]! : new PointIndex(Float32Array.from(targets.flatMap((t) => Array.from(t.points))), 0.003)
      const local = icp(thinPoints(src, 0.003), target, { maxIterations: 30, initial: whole }).transform
      const mapped = applyRigid(local, src)
      for (let i = 0; i < mapped.length; i += 3) {
        if (!target.nearest(mapped[i]!, mapped[i + 1]!, mapped[i + 2]!, 1, I, D, snapDistance)) continue
        const q = I[0]!
        mapped[i] = target.points[3 * q]!
        mapped[i + 1] = target.points[3 * q + 1]!
        mapped[i + 2] = target.points[3 * q + 2]!
      }
      cache.set(key, (entry = { index: new PointIndex(src, 0.004), mapped, r: local.r }))
    }
    let gap = Infinity
    for (let i = 0; i < v.length; i += 3) gap = Math.min(gap, entry.index.distance(v[i]!, v[i + 1]!, v[i + 2]!, attachDistance * 4))
    if (gap <= attachDistance) candidates.push({ a, gap, entry })
  }
  if (!candidates.length) return null
  candidates.sort((x, y) => x.gap - y.gap)
  const bones = candidates.slice(0, 3)
  const out = new Float32Array(v.length)
  for (let i = 0; i < nv; i++) {
    const x = v[3 * i]!
    const y = v[3 * i + 1]!
    const z = v[3 * i + 2]!
    let wSum = 0
    let ox = 0
    let oy = 0
    let oz = 0
    for (const bone of bones) {
      bone.entry.index.nearest(x, y, z, 1, I, D)
      const q = I[0]!
      const d = Math.sqrt(D[0]!)
      const w = 1 / (d + 0.001) ** 2
      const src = bone.entry.index.points
      const rr = bone.entry.r
      const r0 = [rr[0]!, rr[1]!, rr[2]!]
      const r1 = [rr[3]!, rr[4]!, rr[5]!]
      const r2 = [rr[6]!, rr[7]!, rr[8]!]
      const dx = x - src[3 * q]!
      const dy = y - src[3 * q + 1]!
      const dz = z - src[3 * q + 2]!
      ox += w * (bone.entry.mapped[3 * q]! + r0[0]! * dx + r0[1]! * dy + r0[2]! * dz)
      oy += w * (bone.entry.mapped[3 * q + 1]! + r1[0]! * dx + r1[1]! * dy + r1[2]! * dz)
      oz += w * (bone.entry.mapped[3 * q + 2]! + r2[0]! * dx + r2[1]! * dy + r2[2]! * dz)
      wSum += w
    }
    out[3 * i] = ox / wSum
    out[3 * i + 1] = oy / wSum
    out[3 * i + 2] = oz / wSum
  }
  return { positions: out, bones: bones.map((x) => ({ name: x.a.name, side: x.a.side, bp3dIds: x.a.bp3dIds, sourceGap: x.gap })) }
}
