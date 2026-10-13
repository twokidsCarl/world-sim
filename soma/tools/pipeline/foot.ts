// 女性的足趾：趾骨是男性的骨，经形变场贴到她 CT 里“足趾”那一个成组标签上。她扫描时足趾在跖趾关节处背伸，
// 形变后的近节趾骨因此翘起 13–20°（男性站立时为 −6…−10°），整排足趾悬在地面以上 17–19 mm，骨本身还被场弯折。
// 这里把每一趾列的趾骨换成男性骨的相似变换（不弯不扭）：朝向取该列跖骨的朝向（即趾骨相对跖骨的角度与男性的足相同，
// 男性的足是站立位的真实扫描），大小取她该趾的大小，跖趾关节留在她的跖骨头上；再绕跖趾关节在矢状面内转到趾骨最低点落在地面上。
// 足部的软组织（肌、腱、血管、神经及其中心线、甲、皮肤）由一个以趾骨为锚点的位移场带过去。跖骨、跗骨和更近端的一切都不动。
// Her toes: the phalanges are male bones carried by the warp onto the single grouped "toes" label of
// her CT. Her toes were extended at the metatarsophalangeal joints in the scan, so the warped proximal
// phalanges point 13–20° upwards (−6…−10° in the standing male), the whole row of toes hangs 17–19 mm
// above the floor, and the bones themselves are bent by the field. Here the phalanges of each ray are
// replaced by a similarity transform of the male bones (no bending, no twist): oriented like that
// ray's metatarsal (so the angles of the phalanges to the metatarsal are those of the male foot, a real
// standing scan), sized like her toe, with the metatarsophalangeal joint kept on her metatarsal head;
// the ray is then turned in the sagittal plane about that joint until its lowest point rests on the
// floor. The soft tissue of the foot (muscles, tendons, vessels, nerves with their centrelines, nails,
// skin) is carried by a displacement field anchored on the phalanges. Metatarsals, tarsals and
// everything proximal stay where they are.

import type { Mesh } from './geometry.ts'
import { applyRigid, buildDeformation, fitSimilarity, PointIndex, thinPoints } from './register.ts'
import { axisParam } from './standard.ts'
import type { Polyline } from './tube.ts'

export interface FootPart {
  id: string
  name: string
  tissue: string
  male?: string
  mesh: Mesh
  centrelines?: Polyline[]
}

export const TOES = ['big', 'second', 'third', 'fourth', 'little'] as const
const METATARSAL = ['first', 'second', 'third', 'fourth', 'fifth'] as const
const SEGMENTS = ['Proximal', 'Middle', 'Distal'] as const

export interface ToeRow {
  side: 'Left' | 'Right'
  toe: string
  /** 近节趾骨长轴的仰角（度，趾尖朝上为正）/ elevation of the proximal phalanx's long axis (degrees, positive with the tip up) */
  proximalElevationDeg: { before: number; after: number }
  /** 趾骨最低点高出足骨最低点多少 / lowest point of the phalanges above the lowest point of the foot bones */
  aboveFloorMm: { before: number; after: number }
  /** 这只足的跗骨、跖骨、籽骨最低点的高度（毫米）/ height of the lowest point of this foot's tarsals, metatarsals and sesamoids (mm) */
  footFloorMm: number
  /** 相对男性骨的均匀缩放 / uniform scale against the male bones */
  scale: number
  /** 为落地而绕跖趾关节转的角度（度）/ the turn about the metatarsophalangeal joint that brings the toe to the floor (degrees) */
  groundTurnDeg: number
  /** 关节间隙（两骨表面最近距离）：跖趾关节，然后各趾间关节 / joint spaces (closest approach of the two bone surfaces): metatarsophalangeal, then interphalangeal */
  jointSpaceMm: { before: number[]; after: number[] }
  /** 形变后的趾骨偏离男性骨的相似变换的最大距离：骨被场弯折的程度 / largest deviation of the warped phalanges from a similarity transform of the male bones: how far the field had bent them */
  bentMm: number
}

export interface ToeReport {
  rows: ToeRow[]
  partsCarried: number
  floorMm: number
}

/** 长轴的仰角（度）；轴取指向前方（+z）的方向 / elevation of the long axis (degrees); the axis is taken pointing forwards (+z) */
export function elevationDeg(positions: Float32Array): number {
  const a = axisParam(positions).axis
  const s = a[2] < 0 ? -1 : 1
  return (Math.asin(Math.max(-1, Math.min(1, s * a[1]))) * 180) / Math.PI
}

const minY = (p: Float32Array): number => {
  let y = Infinity
  for (let i = 1; i < p.length; i += 3) if (p[i]! < y) y = p[i]!
  return y
}

/** 两个网格顶点之间的最近距离（米）/ closest approach of two meshes' vertices (m) */
function gap(a: Float32Array, b: Float32Array): number {
  const ix = new PointIndex(b, 0.004)
  let d = Infinity
  for (let i = 0; i < a.length; i += 3) d = Math.min(d, ix.distance(a[i]!, a[i + 1]!, a[i + 2]!, 0.03))
  return d
}

const r1 = (v: number) => Math.round(v * 10) / 10

/**
 * 重新摆放两侧的趾骨并带上软组织；就地修改 `parts`。`maleMesh` 给出男性部件的网格。缺少所需骨的趾列不动。
 * Re-places the phalanges of both feet and carries the soft tissue; `parts` are changed in place.
 * `maleMesh` gives a male part's mesh. A ray lacking a bone it needs is left alone.
 */
export function settleToes(parts: FootPart[], maleMesh: (id: string) => Mesh | undefined): ToeReport {
  const byName = new Map<string, FootPart>()
  for (const p of parts) if (p.tissue === 'bone' && !byName.has(p.name)) byName.set(p.name, p)
  const footBone = /calcane|talus|cuboid|cuneiform|navicular|metatarsal|phalanx of (left|right) .*toe|sesamoid bone of (left|right) foot/i
  let floor = Infinity
  for (const p of parts) if (p.tissue === 'bone' && footBone.test(p.name)) floor = Math.min(floor, minY(p.mesh.positions))
  const rows: ToeRow[] = []
  const from: Float32Array[] = []
  const to: Float32Array[] = []
  const moved = new Map<string, Float32Array>()
  for (const side of ['Left', 'Right'] as const) {
    const s = side.toLowerCase()
    // 这只足自己的地面：它的跗骨、跖骨、籽骨的最低点（两足的最低点可以相差几毫米）
    // this foot's own floor: the lowest point of its tarsals, metatarsals and sesamoids (the two feet may differ by a few millimetres)
    let sideFloor = Infinity
    for (const p of parts) if (p.tissue === 'bone' && footBone.test(p.name) && !/phalanx/i.test(p.name) && new RegExp(`\\b${s}\\b`, 'i').test(p.name)) sideFloor = Math.min(sideFloor, minY(p.mesh.positions))
    TOES.forEach((toe, ti) => {
      const mt = byName.get(`${side} ${METATARSAL[ti]} metatarsal bone`)
      const mtMale = mt?.male ? maleMesh(mt.male) : undefined
      const bones = SEGMENTS.map((seg) => byName.get(`${seg} phalanx of ${s} ${toe} toe`)).filter((p): p is FootPart => !!p)
      const males = bones.map((b) => (b.male ? maleMesh(b.male) : undefined))
      if (!mt || !mtMale || !bones.length || mtMale.positions.length !== mt.mesh.positions.length) return
      if (males.some((m, i) => !m || m.positions.length !== bones[i]!.mesh.positions.length)) return
      const mm = males as Mesh[]
      const cat = (list: Float32Array[]) => {
        const out = new Float32Array(list.reduce((n, a) => n + a.length, 0))
        let o = 0
        for (const a of list) {
          out.set(a, o)
          o += a.length
        }
        return out
      }
      const maleAll = cat(mm.map((m) => m.positions))
      const herAll = cat(bones.map((b) => b.mesh.positions))
      // 跖骨的相似变换给出朝向和跖趾关节的位置；趾自身的相似变换给出大小
      // the metatarsal's similarity transform gives the orientation and where the joint is; the toe's own gives the size
      const T = fitSimilarity(mtMale.positions, mt.mesh.positions)
      const own = fitSimilarity(maleAll, herAll)
      const fitted = applyRigid(own, maleAll)
      let bent = 0
      for (let i = 0; i < fitted.length; i += 3) bent = Math.max(bent, Math.hypot(fitted[i]! - herAll[i]!, fitted[i + 1]! - herAll[i + 1]!, fitted[i + 2]! - herAll[i + 2]!))
      const R = T.r.map((v) => v / T.scale)
      // 男性的跖趾关节点：近节趾骨上最靠近跖骨的那 15 % 顶点的质心 / the male joint point: centroid of the 15 % of the proximal phalanx's vertices nearest the metatarsal
      const pm = mm[0]!.positions
      const cm = axisParam(mtMale.positions).c
      const dist = Array.from({ length: pm.length / 3 }, (_, i) => Math.hypot(pm[3 * i]! - cm[0], pm[3 * i + 1]! - cm[1], pm[3 * i + 2]! - cm[2]))
      const cut = [...dist].sort((a, b) => a - b)[Math.floor(dist.length * 0.15)]!
      const J = [0, 0, 0]
      let nj = 0
      dist.forEach((d, i) => {
        if (d > cut) return
        for (let k = 0; k < 3; k++) J[k] = J[k]! + pm[3 * i + k]!
        nj++
      })
      for (let k = 0; k < 3; k++) J[k] = J[k]! / nj
      const Jh = applyRigid(T, Float32Array.from(J))
      const place = (src: Float32Array, turn: number): Float32Array => {
        const out = new Float32Array(src.length)
        const c = Math.cos(turn)
        const sn = Math.sin(turn)
        for (let i = 0; i < src.length; i += 3) {
          const d = [src[i]! - J[0]!, src[i + 1]! - J[1]!, src[i + 2]! - J[2]!]
          const x = own.scale * (R[0]! * d[0]! + R[1]! * d[1]! + R[2]! * d[2]!)
          const y = own.scale * (R[3]! * d[0]! + R[4]! * d[1]! + R[5]! * d[2]!)
          const z = own.scale * (R[6]! * d[0]! + R[7]! * d[1]! + R[8]! * d[2]!)
          // 绕过关节的左右轴转 `turn`：正值使趾尖下降 / a turn about the left-right axis through the joint: positive lowers the tip
          out[i] = Jh[0]! + x
          out[i + 1] = Jh[1]! + y * c - z * sn
          out[i + 2] = Jh[2]! + y * sn + z * c
        }
        return out
      }
      // 落地：趾列最低点在足骨最低点之上 0.5 mm（不改变足的最低点）；在 ±30° 内找离 0 最近的解
      // to the floor: the ray's lowest point 0.5 mm above the lowest point of the foot bones (which therefore stays); the solution nearest 0 within ±30°
      const g = (t: number) => minY(place(maleAll, t)) - (sideFloor + 0.0005)
      let turn = 0
      const lim = Math.PI / 6
      const dir = g(0) > 0 ? 1 : -1
      let lo = 0
      let hi = 0
      for (let k = 1; k <= 30; k++) {
        hi = (dir * k * lim) / 30
        if (g(hi) * g(0) <= 0) break
        lo = hi
      }
      if (g(hi) * g(0) <= 0) {
        for (let it = 0; it < 40; it++) {
          const mid = (lo + hi) / 2
          if (g(mid) * g(lo) <= 0) hi = mid
          else lo = mid
        }
        turn = g(lo) >= 0 ? lo : hi
      } else turn = hi
      const before = { elev: elevationDeg(bones[0]!.mesh.positions), low: minY(herAll) - sideFloor, gaps: [gap(bones[0]!.mesh.positions, mt.mesh.positions), ...bones.slice(1).map((b, i) => gap(b.mesh.positions, bones[i]!.mesh.positions))] }
      const placed = mm.map((m) => place(m.positions, turn))
      bones.forEach((b, i) => {
        from.push(b.mesh.positions)
        to.push(placed[i]!)
        moved.set(b.id, placed[i]!)
      })
      rows.push({
        side, toe, footFloorMm: r1(sideFloor * 1000), scale: Math.round(own.scale * 1000) / 1000, groundTurnDeg: r1((turn * 180) / Math.PI), bentMm: r1(bent * 1000),
        proximalElevationDeg: { before: r1(before.elev), after: r1(elevationDeg(placed[0]!)) },
        aboveFloorMm: { before: r1(before.low * 1000), after: r1((minY(cat(placed)) - sideFloor) * 1000) },
        jointSpaceMm: { before: before.gaps.map((v) => Math.round(v * 100000) / 100), after: [gap(placed[0]!, mt.mesh.positions), ...placed.slice(1).map((p, i) => gap(p, placed[i]!))].map((v) => Math.round(v * 100000) / 100) },
      })
    })
  }
  if (!moved.size) return { rows, partsCarried: 0, floorMm: r1(floor * 1000) }
  // 软组织：以趾骨（旧 → 新）和不动的跖骨、跗骨为锚点的位移场；只作用在旧趾骨 20 mm 以内，到 45 mm 处减为零
  // soft tissue: a field anchored on the phalanges (old → new) and on the metatarsals and tarsals, which stay; it acts within 20 mm of the old phalanges and fades to zero at 45 mm
  const all = (list: Float32Array[]) => {
    const out = new Float32Array(list.reduce((n, a) => n + a.length, 0))
    let o = 0
    for (const a of list) {
      out.set(a, o)
      o += a.length
    }
    return out
  }
  const oldToes = thinPoints(all(from), 0.002)
  const fixed: Float32Array[] = []
  for (const p of parts) if (p.tissue === 'bone' && footBone.test(p.name) && !moved.has(p.id)) fixed.push(thinPoints(p.mesh.positions, 0.004))
  const field = buildDeformation(all([...from, ...fixed]), all([...to, ...fixed]), { minSigma: 0.006, k: 24 })
  const near = new PointIndex(oldToes, 0.01)
  const carry = (pts: Float32Array): { out: Float32Array; n: number } => {
    const out = Float32Array.from(pts)
    let n = 0
    for (let i = 0; i < pts.length; i += 3) {
      const d = near.distance(pts[i]!, pts[i + 1]!, pts[i + 2]!, 0.045)
      if (d >= 0.045) continue
      const w = d <= 0.02 ? 1 : 1 - (d - 0.02) / 0.025
      const u = field.displacementAt(pts[i]!, pts[i + 1]!, pts[i + 2]!)
      const ww = w * w * (3 - 2 * w)
      out[i] = pts[i]! + ww * u[0]
      out[i + 1] = pts[i + 1]! + ww * u[1]
      out[i + 2] = pts[i + 2]! + ww * u[2]
      n++
    }
    return { out, n }
  }
  let carried = 0
  for (const p of parts) {
    const exact = moved.get(p.id)
    if (exact) {
      p.mesh = { positions: exact, indices: p.mesh.indices }
      continue
    }
    if (p.tissue === 'bone') continue
    const c = carry(p.mesh.positions)
    if (!c.n) continue
    p.mesh = { positions: c.out, indices: p.mesh.indices }
    if (p.centrelines) p.centrelines = p.centrelines.map((l) => ({ points: carry(l.points).out, radius: l.radius }))
    carried++
  }
  return { rows, partsCarried: carried, floorMm: r1(floor * 1000) }
}
