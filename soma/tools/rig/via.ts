// 膝周肌肉的经过点：由我们自己的骨网格放置（股骨髁后面、胫骨内侧髁、髌骨），写进 rig.json 的 MuscleLine.via。
// Via points of the muscles round the knee, placed from our own bone meshes (behind the femoral condyles, on the medial
// tibial condyle, on the patella) and written into MuscleLine.via of rig.json.
//
// 规则在 data/curated/rig/via.json（每条：肌肉名的正则、做法、参数）。三种做法 / Three kinds of rule:
//   condyle  股骨髁后面的缠绕点（带 wrap 条件，固定在股骨上）：在膝关节的极坐标里（以屈伸轴为心，0° = 正后方，正角向近侧），
//            每个给定角度取该肌肉所在的内外位置附近股骨面的最大半径，再加 clearanceMm。
//            Wrapping points behind the femoral condyles (with a wrap condition, fixed to the femur): in polar
//            coordinates about the knee's flexion axis (0° = straight back, positive angles proximal), at each given
//            angle the largest radius of the femur's surface near the muscle's mediolateral position, plus clearanceMm.
//   tibia    胫骨上的固定经过点（无条件，随胫骨）：同样的极坐标，半径取胫骨面加 clearanceMm；代表肌腱绕胫骨内侧髁转向前方（鹅足）
//            或贴着胫骨髁后面走到止点。
//            A fixed via point on the tibia (unconditional, moves with the tibia): the same polar coordinates, radius
//            from the tibia's surface plus clearanceMm; it stands for tendons turning forwards round the medial
//            tibial condyle (pes anserinus) or running along the back of the tibial condyle to the insertion.
//   patella  股四头肌经髌骨（原在 tools/activity/build.ts，搬到这里由两边共用）：起点 → 股骨上的经过点 → 髌骨上的点。
//            The quadriceps act through the patella (formerly in tools/activity/build.ts, moved here and shared):
//            origin → a via point on the femur → the point on the patella.
// 肌肉的内外位置取它的网格在该高度的平均（网格太少时取作用线），所以经过点不会把肌肉横向拉开。
// A muscle's mediolateral position is the mean of its mesh at that height (its line where the mesh is too sparse),
// so the via points do not pull the muscle sideways.
// 位置全部来自本模型的骨和肌肉网格；参照模型（OpenSim、MyoSim）只用来事后量力臂，不取它们的坐标。
// Every position comes from this model's bone and muscle meshes; the reference models (OpenSim, MyoSim) are only used
// afterwards to measure moment arms, and none of their coordinates are taken.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Joint, MuscleLine, MuscleVia, Rig } from '../../src/anatomy/types.ts'
import type { Body } from './io.ts'
import { type V3, add, axisAngle, dot, m3apply, norm, sub } from './math.ts'
import { projectOnPolyline } from './musclepath.ts'

export const VIA_FILE = join(import.meta.dirname, '..', '..', 'data', 'curated', 'rig', 'via.json')

export interface ViaRule {
  /** 去掉左右之后的小写名称的正则 / regex on the lower-case name without its side. */
  match: string
  kind: 'condyle' | 'tibia' | 'patella'
  /** condyle / tibia：极角（度）/ polar angles (degrees). */
  anglesDeg?: number[]
  clearanceMm?: number
}

export interface ViaFile {
  rules: ViaRule[]
  /**
   * 网格不随路径变形、照旧普通蒙皮的肌肉（经过点仍用于长度、力臂和活动）：去掉左右之后的小写名称的正则，可限于某几副身体
   * （bodies，缺省为全部），各附理由。
   * Muscles whose meshes do not follow the path and stay plainly skinned (their via points still give lengths, moment
   * arms and activity): regexes on the lower-case name without its side, optionally limited to some bodies (`bodies`,
   * all when absent), each with its reason.
   */
  meshPlain?: { match: string; bodies?: string[]; why?: { zh: string; en: string } }[]
  patella: { patellaJoint: string; femurJoint: string; kneeJoint: string; backDeg: number; arcDeg?: number[]; quadriceps: string }
}

/** 膝关节的局部坐标：med 向内侧、down 向远侧、post 向后（米）/ Local coordinates of the knee: med medial, down distal, post posterior (metres). */
export interface KneeFrame {
  C: V3
  axis: V3
  down: V3
  post: V3
  medSign: number
  femurJoint: string
  tibiaJoint: string
}

export function kneeFrame(rig: Rig, side: 'L' | 'R', file: ViaFile): KneeFrame | null {
  const k = rig.joints.find((j) => j.id === file.patella.kneeJoint.replace('{S}', side)) as (Joint & { tail?: V3 }) | undefined
  if (!k || !k.tail || !k.dofs[0] || k.parent === null) return null
  const C = k.center as V3
  const axis = norm(k.axes[k.dofs[0].axis] as V3)
  let down = norm(sub(k.tail, C))
  down = norm(sub(down, [axis[0] * dot(down, axis), axis[1] * dot(down, axis), axis[2] * dot(down, axis)]))
  // 后方 = −Z 去掉另两个方向的分量 / posterior = −Z with the other two directions removed
  let post: V3 = [0, 0, -1]
  for (const v of [axis, down]) post = sub(post, [v[0] * dot(post, v), v[1] * dot(post, v), v[2] * dot(post, v)])
  post = norm(post)
  // 内侧 = 朝向正中面（x = 0）/ medial = towards the midsagittal plane (x = 0)
  const medSign = Math.sign(axis[0] * -Math.sign(C[0])) || 1
  return { C, axis, down, post, medSign, femurJoint: k.parent, tibiaJoint: k.id }
}

export const toKnee = (f: KneeFrame, p: V3): { med: number; down: number; post: number } => {
  const d = sub(p, f.C)
  return { med: dot(d, f.axis) * f.medSign, down: dot(d, f.down), post: dot(d, f.post) }
}
export const fromKnee = (f: KneeFrame, med: number, down: number, post: number): V3 => [
  f.C[0] + f.axis[0] * med * f.medSign + f.down[0] * down + f.post[0] * post,
  f.C[1] + f.axis[1] * med * f.medSign + f.down[1] * down + f.post[1] * post,
  f.C[2] + f.axis[2] * med * f.medSign + f.down[2] * down + f.post[2] * post,
]
/** 极角（度）：0 = 正后方，正值向近侧 / polar angle (degrees): 0 = straight back, positive proximal. */
const polar = (q: { down: number; post: number }): number => (Math.atan2(-q.down, q.post) * 180) / Math.PI

/** 骨面在某个内外位置、某个极角处的半径（米）；那里没有骨时为 null / The bone surface's radius at a mediolateral position and polar angle (m); null where there is no bone. */
export function surfaceRadius(pts: { med: number; down: number; post: number }[], med: number, angleDeg: number): number | null {
  for (const band of [0.01, 0.02, 0.04]) {
    let best = -1
    for (const q of pts) {
      if (Math.abs(q.med - med) > band || Math.abs(q.down) > 0.1) continue
      let d = polar(q) - angleDeg
      d = ((d + 540) % 360) - 180
      if (Math.abs(d) > 10) continue
      best = Math.max(best, Math.hypot(q.post, q.down))
    }
    if (best > 0) return best
  }
  return null
}

export const bare = (name: string): string => name.toLowerCase().replace(/\b(left|right)\s+/g, '').replace(/\s+/g, ' ').trim()
const r5 = (v: number): number => Math.round(v * 1e5) / 1e5
const r5v = (p: V3): V3 => [r5(p[0]), r5(p[1]), r5(p[2])]

export interface ViaReportRow {
  part: string
  name: string
  side: 'L' | 'R'
  kind: ViaRule['kind']
  /** 每个点：极角、半径（毫米）、内外位置（毫米）、关节 / per point: polar angle, radius (mm), mediolateral position (mm), joint. */
  points: { angleDeg: number | null; radiusMm: number | null; medMm: number; joint: string; wrap: boolean }[]
  /** 网格推出骨面的最大平移（毫米）和它所在的膝角（度），见 tools/rig/viapush.ts / The largest translation pushing the mesh out of the bones (mm) and the knee angle where it is (degrees), see tools/rig/viapush.ts. */
  pushMaxMm?: number
  pushAtDeg?: number
}

/** 读取规则文件 / Read the rule file. */
export const readViaFile = (path: string = VIA_FILE): ViaFile => JSON.parse(readFileSync(path, 'utf8')) as ViaFile

/**
 * 给 rig.muscles 中匹配规则的作用线加上经过点（返回新数组，不改原对象），并返回每条的放置记录。
 * Add via points to the lines of rig.muscles that match a rule (returns a new array, leaving the originals alone) and a
 * record of every placement.
 */
export function placeVias(rig: Rig, body: Body, file: ViaFile = readViaFile()): { muscles: MuscleLine[]; report: ViaReportRow[] } {
  const report: ViaReportRow[] = []
  const frames: Partial<Record<'L' | 'R', KneeFrame>> = {}
  const bones: Partial<Record<'L' | 'R', { femur: ReturnType<typeof toKnee>[]; tibia: ReturnType<typeof toKnee>[] }>> = {}
  for (const side of ['L', 'R'] as const) {
    const f = kneeFrame(rig, side, file)
    if (!f) continue
    frames[side] = f
    const pts = (re: RegExp): ReturnType<typeof toKnee>[] => {
      const out: ReturnType<typeof toKnee>[] = []
      for (const p of body.data.parts) {
        if (p.tissue !== 'bone' || !re.test(p.name)) continue
        const m = body.meshes.get(p.id)
        if (!m) continue
        for (let i = 0; i < m.positions.length; i += 3) out.push(toKnee(f, [m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!]))
      }
      return out
    }
    const s = side === 'L' ? 'left' : 'right'
    bones[side] = { femur: pts(new RegExp(`^${s} femur$`, 'i')), tibia: pts(new RegExp(`^${s} tibia$`, 'i')) }
  }
  const quadRe = new RegExp(file.patella.quadriceps, 'i')
  // 每侧髌骨上的点：该侧股肌止点的平均 / the patella point per side: the mean of that side's vasti insertions
  const patellaPoint: Partial<Record<'L' | 'R', V3>> = {}
  for (const side of ['L', 'R'] as const) {
    const pj = file.patella.patellaJoint.replace('{S}', side)
    const pts = rig.muscles.filter((m) => m.insertion.joint === pj && quadRe.test(body.byId.get(m.part)?.name ?? '')).map((m) => m.insertion.point as V3)
    if (pts.length) patellaPoint[side] = [pts.reduce((t, p) => t + p[0], 0) / pts.length, pts.reduce((t, p) => t + p[1], 0) / pts.length, pts.reduce((t, p) => t + p[2], 0) / pts.length]
  }
  const muscles = rig.muscles.map((line) => {
    const part = body.byId.get(line.part)
    const side = part?.side === 'L' || part?.side === 'R' ? part.side : null
    if (!part || !side) return line
    const name = bare(part.name)
    const rules = file.rules.filter((r) => new RegExp(r.match, 'i').test(name))
    if (!rules.length) return line
    const f = frames[side], b = bones[side]
    // 每条规则一组点，组内保持规则给出的顺序（从近侧到远侧）/ one group of points per rule, kept in the rule's order (proximal to distal)
    const groups: { via: MuscleVia[]; points: ViaReportRow['points'] }[] = []
    let via: MuscleVia[] = []
    const row: ViaReportRow = { part: line.part, name: part.name, side, kind: rules[0]!.kind, points: [] }
    const mesh = body.meshes.get(line.part)
    // 肌肉在某个高度（down）处的内外位置 / the muscle's mediolateral position at a height (down)
    const medAt = (down: number): number => {
      if (!f) return 0
      let s = 0, n = 0
      if (mesh) {
        for (let i = 0; i < mesh.positions.length; i += 3) {
          const q = toKnee(f, [mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!])
          if (Math.abs(q.down - down) < 0.01) (s += q.med), n++
        }
      }
      if (n >= 3) return s / n
      const o = toKnee(f, line.origin.point as V3), e = toKnee(f, line.insertion.point as V3)
      const t = Math.abs(e.down - o.down) > 1e-6 ? Math.min(1, Math.max(0, (down - o.down) / (e.down - o.down))) : 0
      return o.med + (e.med - o.med) * t
    }
    for (const rule of rules) {
      if (via.length) groups.push({ via, points: row.points })
      via = []
      row.points = []
      if (rule.kind === 'patella') {
        const pj = rig.joints.find((j) => j.id === file.patella.patellaJoint.replace('{S}', side))
        const fj = file.patella.femurJoint.replace('{S}', side)
        const P: V3 | undefined = line.insertion.joint === pj?.id ? (line.insertion.point as V3) : patellaPoint[side]
        if (!pj || !P || !pj.dofs[0] || !rig.joints.some((j) => j.id === fj)) continue
        // 经过点：髌骨点绕髌骨轴往近侧（与屈膝时髌骨的运动方向相反）转 backDeg 度，固定在股骨上
        // via point: the patella point turned backDeg degrees proximally (against the patella's motion in knee flexion) about the patellar axis, fixed to the femur
        const axis = pj.axes[pj.dofs[0].axis] as V3
        const sign = (pj.dofs[0].driver?.ratio ?? 1) >= 0 ? -1 : 1
        const turn = (deg: number): V3 => add(pj.center as V3, m3apply(axisAngle(axis, (deg * Math.PI) / 180), sub(P, pj.center as V3)))
        const T = turn(sign * file.patella.backDeg)
        const radius = Math.round(Math.hypot(...sub(P, pj.center as V3)) * 1e4) / 10
        via.push({ point: r5v(T), joint: fj })
        row.points.push({ angleDeg: -file.patella.backDeg, radiusMm: radius, medMm: f ? Math.round(toKnee(f, T).med * 1e4) / 10 : 0, joint: fj, wrap: false })
        // 沿髌骨轨道（向屈膝时髌骨前进的方向）的缠绕点，固定在股骨上：深屈时肌腱贴着股骨滑车走弧线，不走弦
        // wrapping points along the patellar track (the way the patella moves in knee flexion), fixed to the femur: in deep flexion the tendon follows the arc over the femoral trochlea instead of its chord
        for (const deg of file.patella.arcDeg ?? []) {
          const W = turn(-sign * deg)
          via.push({ point: r5v(W), joint: fj, wrap: { centre: r5v(pj.center as V3), axis: r5v(norm(axis)) } })
          row.points.push({ angleDeg: deg, radiusMm: radius, medMm: f ? Math.round(toKnee(f, W).med * 1e4) / 10 : 0, joint: fj, wrap: true })
        }
        // 止点不在髌骨上（股直肌止于胫骨）时，髌骨上的点也是经过点 / when the insertion is not on the patella (rectus femoris inserts on the tibia), the patella point is a via point too
        if (line.insertion.joint !== pj.id) {
          via.push({ point: r5v(P), joint: pj.id })
          row.points.push({ angleDeg: null, radiusMm: null, medMm: f ? Math.round(toKnee(f, P).med * 1e4) / 10 : 0, joint: pj.id, wrap: false })
        }
        continue
      }
      if (!f || !b) continue
      const onTibia = rule.kind === 'tibia'
      const surface = onTibia ? b.tibia : b.femur
      for (const ang of rule.anglesDeg ?? []) {
        // 先用骨面在近似高度处的半径定高度，再在该高度取肌肉的内外位置 / the height comes from the surface radius near that angle, then the muscle's mediolateral position at that height
        const approxR = surfaceRadius(surface, medAt(0), ang) ?? 0.025
        const level = -approxR * Math.sin((ang * Math.PI) / 180)
        const med = medAt(level)
        // 骨面半径在肌肉的内外位置（超出骨的范围时取骨的边缘）/ the surface radius at the muscle's mediolateral position (the bone's edge when it lies beyond the bone)
        const meds = surface.filter((q) => Math.abs(q.down) < 0.1).map((q) => q.med)
        const medIn = Math.min(Math.max(...meds) - 0.003, Math.max(Math.min(...meds) + 0.003, med))
        const R = surfaceRadius(surface, medIn, ang)
        if (R === null) continue
        const r = R + (rule.clearanceMm ?? 0) / 1000
        const a = (ang * Math.PI) / 180
        const p = fromKnee(f, med, -r * Math.sin(a), r * Math.cos(a))
        via.push(onTibia ? { point: r5v(p), joint: f.tibiaJoint } : { point: r5v(p), joint: f.femurJoint, wrap: { centre: r5v(f.C), axis: r5v(f.axis) } })
        row.points.push({ angleDeg: ang, radiusMm: Math.round(r * 1e4) / 10, medMm: Math.round(med * 1e4) / 10, joint: onTibia ? f.tibiaJoint : f.femurJoint, wrap: !onTibia })
      }
    }
    if (via.length) groups.push({ via, points: row.points })
    if (!groups.length) return line
    // 各组按第一个点在静止作用线上的投影排序：从起点到止点 / groups sorted by the projection of their first point on the rest line: origin to insertion
    const straight: V3[] = [line.origin.point as V3, line.insertion.point as V3]
    groups.sort((x, y) => projectOnPolyline(straight, x.via[0]!.point as V3) - projectOnPolyline(straight, y.via[0]!.point as V3))
    row.points = groups.flatMap((g) => g.points)
    report.push(row)
    return { ...line, via: groups.flatMap((g) => g.via) }
  })
  return { muscles, report }
}
