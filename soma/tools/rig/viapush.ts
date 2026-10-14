// 有经过点的肌肉网格推出膝周骨：构建绑定时按膝屈伸角烘焙每个横截面的平移（MuscleLine.viaPush，见 src/anatomy/types.ts）。
// Pushing the meshes of the muscles with via points out of the knee bones: when the rig is built, the translation of
// every cross-section is baked over the knee flexion angle (MuscleLine.viaPush, see src/anatomy/types.ts).
//
// 做法 / Approach
//   · 网格先按横截面蒙皮（tools/rig/musclepath.ts），再做体积修正。每隔 PUSH_STEP_DEG 度屈膝（只动膝，其余关节为 0），
//     找出落进膝周骨（股骨、胫骨、髌骨、腓骨）里的顶点；静止时已经在骨里的顶点（附着处网格与骨相交）不算。
//     The mesh is first skinned by cross-section (tools/rig/musclepath.ts), then volume-corrected. Every PUSH_STEP_DEG
//     degrees of knee flexion (the knee alone, every other joint at 0) the vertices that have gone into a knee bone
//     (femur, tibia, patella, fibula) are found; vertices already inside a bone at rest (where the mesh meets the bone
//     at an attachment) do not count.
//   · 每个这样的顶点要移到最近的骨面外 PUSH_MARGIN；分给它两侧的样本。每个样本取这些位移的加权平均方向，长度取沿该方向的最大值
//     （整个横截面一起移出），样本之间再用 [1, 2, 1] / 4 平滑 PUSH_SMOOTH 次，免得相邻横截面错开。重复 PUSH_ITER 轮。
//     Each such vertex should move to PUSH_MARGIN outside the nearest bone surface; this is shared out to the samples
//     either side. Each sample takes the weighted mean direction of these displacements and, as its length, the largest
//     along that direction (the whole cross-section moves out together); the samples are then smoothed with [1, 2, 1] / 4
//     PUSH_SMOOTH times so that neighbouring cross-sections do not shear apart. PUSH_ITER rounds.
//   · 膝角不超过 SKIN_UNTIL_DEG 时，同样把比普通蒙皮更靠皮肤外的顶点推回（不比普通蒙皮更靠外，再加 SKIN_MARGIN）。更深的屈曲里
//     皮肤自己在腘窝折叠，最近的皮肤点不再可靠，这一步不做。皮肤不封闭，内外按最近点处的法线判断（tools/rig/solid.ts 的 Surface）。
//     Up to SKIN_UNTIL_DEG of knee flexion, vertices lying further outside the skin than under plain skinning are pushed
//     back likewise (to no further out than plain skinning, plus SKIN_MARGIN). In deeper flexion the skin itself folds in
//     the popliteal fossa and its nearest point is no longer reliable, so this step is not taken. The skin is not
//     closed, so the side is judged by the normal at the nearest point (Surface in tools/rig/solid.ts).
//   · 两端 VIA_END 之内推出量按 viaShare 渐减到 0（那里的网格也渐渐回到普通蒙皮，见 musclepath.ts）。
//     Within VIA_END of either end the push fades to 0 by viaShare (the mesh there passes back to plain skinning too,
//     see musclepath.ts).
//   · 结果转到股骨坐标里存表（米，四舍五入到 0.01 mm）；运行时按当前膝角在两行间插值、随股骨转动。第 0 行（伸直）为 0。
//     The result is stored in the femur's frame (metres, rounded to 0.01 mm); at run time it is interpolated between two
//     rows by the current knee angle and turned with the femur. Row 0 (straight) is zero.
//   · 只看膝屈伸：髋、踝、胫骨旋转和体型缩放不改变表；深蹲（髋、膝、踝同时屈）用的是同一膝角下的值。
//     Only knee flexion is considered: hip, ankle, tibial rotation and body-shape scales do not change the table; the
//     squat (hip, knee and ankle flexed together) uses the value for its knee angle.
// 这些常数是本项目的取值（用 tools/rig/via-check.ts 的门槛选出），不是测量值。
// These constants are this project's choices (picked against the gate of tools/rig/via-check.ts), not measurements.

import type { MuscleLine, MuscleViaPush, Rig } from '../../src/anatomy/types.ts'
import type { Body } from './io.ts'
import type { V3 } from './math.ts'
import { VIA_SAMPLES, hasViaPush, viaShare } from './musclepath.ts'
import { Poser, transformRigid, viaPrepFor, type Pose } from './pose.ts'
import { Solid, Surface, closedProblem } from './solid.ts'
import { type ViaFile, bare, readViaFile } from './via.ts'

/** 表的角度步长（度）/ Angle step of the table (degrees). */
export const PUSH_STEP_DEG = 5
/** 推到骨面外的余量（米），约为肌腱半径 / How far (m) beyond the bone surface a vertex is pushed, about a tendon's radius. */
export const PUSH_MARGIN = 0.004
/** 推回皮肤里面的余量（米）/ How far (m) inside the skin a vertex is pushed back. */
export const SKIN_MARGIN = 0.002
/** 皮肤约束只用到这个膝角（度）：更深时皮肤自己在腘窝折叠 / The skin constraint is used up to this knee angle (degrees): deeper, the skin itself folds in the popliteal fossa. */
export const SKIN_UNTIL_DEG = 90
export const PUSH_ITER = 4
export const PUSH_SMOOTH = 2
/** 膝周骨的名称 / Names of the bones of the knee region. */
export const KNEE_BONES = /^(left|right) (femur|tibia|patella|fibula)$/i

const r5 = (v: number): number => Math.round(v * 1e5) / 1e5 || 0

/** 一条作用线的表头（膝关节、股骨）；找不到关节时为 null / The head of a line's table (knee joint, femur); null when the joints are missing. */
function pushHead(rig: Rig, body: Body, line: MuscleLine, file: ViaFile): { joint: string; frame: string; rows: number } | null {
  const side = body.byId.get(line.part)?.side
  if (side !== 'L' && side !== 'R') return null
  const joint = file.patella.kneeJoint.replace('{S}', side), frame = file.patella.femurJoint.replace('{S}', side)
  const k = rig.joints.find((j) => j.id === joint)
  if (!k?.dofs[0] || !rig.joints.some((j) => j.id === frame)) return null
  const maxDeg = (k.dofs[0].max * 180) / Math.PI
  return { joint, frame, rows: Math.max(2, Math.ceil(maxDeg / PUSH_STEP_DEG - 1e-9) + 1) }
}

/**
 * 给有经过点的作用线加上全为 0 的 viaPush：网格从此按横截面蒙皮（体积标定也按这种网格量）。via.json 的 meshPlain 列出的肌肉不加，
 * 照旧普通蒙皮。
 * Give the lines with via points an all-zero viaPush: from here on their meshes are skinned by cross-section (and the
 * volume calibration measures that mesh). The muscles listed under meshPlain in via.json get none and stay plainly
 * skinned.
 */
export function withZeroPush(rig: Rig, body: Body, file: ViaFile = readViaFile()): MuscleLine[] {
  const plain = (file.meshPlain ?? []).filter((e) => !e.bodies || e.bodies.includes(body.data.body)).map((e) => new RegExp(e.match, 'i'))
  return rig.muscles.map((line) => {
    if (!line.via?.length) return line
    const name = bare(body.byId.get(line.part)?.name ?? '')
    if (plain.some((re) => re.test(name))) return line
    const h = pushHead(rig, body, line, file)
    if (!h) return line
    const push: MuscleViaPush = { joint: h.joint, dof: 0, frame: h.frame, stepDeg: PUSH_STEP_DEG, samples: VIA_SAMPLES, d: new Array<number>(h.rows * VIA_SAMPLES * 3).fill(0) }
    return { ...line, viaPush: push }
  })
}

export interface PushReportRow {
  part: string
  /** 表中最大的平移（毫米）和它所在的膝角（度）/ The largest translation in the table (mm) and the knee angle where it is (degrees). */
  maxMm: number
  atDeg: number
}

/** 膝周骨在某个姿势下的实体 / The knee bones as solids in a pose. */
function kneeBones(body: Body, poser: Poser): Solid[] {
  const out: Solid[] = []
  for (const part of body.data.parts) {
    const mesh = KNEE_BONES.test(part.name) ? body.meshes.get(part.id) : undefined
    if (!mesh) continue
    const problem = closedProblem(mesh.indices)
    if (problem) throw new Error(`viapush: the bone mesh of ${part.name} is not closed (${problem})`)
    const b = poser.rig.bindings.find((x) => x.part === part.id)
    const xf = b?.joint !== undefined ? poser.xfs[poser.jointIndex.get(b.joint) ?? -1] : undefined
    out.push(new Solid(Float64Array.from(xf ? transformRigid(mesh.positions, xf) : poser.part(part.id, mesh.positions, 'dqs', false)), mesh.indices))
  }
  return out
}

/**
 * 一条作用线在一个姿势下的推出量（世界坐标，VIA_SAMPLES × 3）。`out`：横截面蒙皮并做过体积修正的顶点；`skip`：静止时在骨里的顶点；
 * `share`：各样本推出量所占的份额（两端渐减到 0，见 musclepath.ts 的 viaShare），缺省为全 1。
 * The push of one line in one pose (world frame, VIA_SAMPLES × 3). `out`: the vertices skinned by cross-section and
 * volume-corrected; `skip`: the vertices inside a bone at rest; `share`: the share of the push at each sample (fading to
 * 0 at the ends, see viaShare in musclepath.ts), all 1 when absent.
 */
export function pushOut(out: Float32Array, s: Float32Array, skip: Uint8Array, bones: Solid[], share?: Float64Array, skin?: { surface: Surface; allow: Float32Array }): Float64Array {
  const K = VIA_SAMPLES
  const D = new Float64Array(K * 3)
  const n = s.length
  for (let it = 0; it < PUSH_ITER; it++) {
    const dir = new Float64Array(K * 3)
    const lists: V3[][] = Array.from({ length: K }, () => [])
    for (let i = 0; i < n; i++) {
      if (skip[i]) continue
      const f = s[i]! * (K - 1), k = Math.min(K - 2, Math.floor(f)), a = f - k
      const x: V3 = [0, 1, 2].map((q) => out[i * 3 + q]! + D[k * 3 + q]! + (D[k * 3 + 3 + q]! - D[k * 3 + q]!) * a) as V3
      const want = (c: V3, margin: number): void => {
        const v: V3 = [c[0] - x[0], c[1] - x[1], c[2] - x[2]]
        const l = Math.hypot(v[0], v[1], v[2]) || 1e-9
        const vv: V3 = [v[0] * (1 + margin / l), v[1] * (1 + margin / l), v[2] * (1 + margin / l)]
        for (const [kk, w] of [[k, 1 - a], [k + 1, a]] as const) {
          if (!(w > 0)) continue
          lists[kk]!.push(vv)
          for (let q = 0; q < 3; q++) dir[kk * 3 + q] = dir[kk * 3 + q]! + w * vv[q]!
        }
      }
      for (const b of bones) if (b.contains(x[0], x[1], x[2])) want(b.closest(x), PUSH_MARGIN)
      // 比普通蒙皮更靠皮肤外 → 推回 / further outside the skin than under plain skinning → pushed back
      if (skin) {
        const out = skin.surface.signed(x[0], x[1], x[2]) - skin.allow[i]!
        if (out > 0) {
          const c = skin.surface.nearest(x[0], x[1], x[2])
          const l = Math.hypot(c[0] - x[0], c[1] - x[1], c[2] - x[2]) || 1e-9
          // 沿指向最近皮肤点的方向退回 out + 余量 / back along the direction of the nearest skin point by out + the margin
          want([x[0] + ((c[0] - x[0]) / l) * out, x[1] + ((c[1] - x[1]) / l) * out, x[2] + ((c[2] - x[2]) / l) * out], SKIN_MARGIN)
        }
      }
    }
    const dk = new Float64Array(K * 3)
    for (let k = 0; k < K; k++) {
      const l = Math.hypot(dir[k * 3]!, dir[k * 3 + 1]!, dir[k * 3 + 2]!)
      if (!(l > 0)) continue
      const u: V3 = [dir[k * 3]! / l, dir[k * 3 + 1]! / l, dir[k * 3 + 2]! / l]
      let m = 0
      for (const v of lists[k]!) m = Math.max(m, v[0] * u[0] + v[1] * u[1] + v[2] * u[2])
      for (let q = 0; q < 3; q++) dk[k * 3 + q] = u[q]! * m
    }
    for (let sm = 0; sm < PUSH_SMOOTH; sm++) {
      const c = Float64Array.from(dk)
      for (let k = 0; k < K; k++) for (let q = 0; q < 3; q++) dk[k * 3 + q] = (c[Math.max(0, k - 1) * 3 + q]! + 2 * c[k * 3 + q]! + c[Math.min(K - 1, k + 1) * 3 + q]!) / 4
    }
    for (let i = 0; i < K * 3; i++) D[i] = D[i]! + dk[i]! * (share ? share[Math.floor(i / 3)]! : 1)
  }
  return D
}

/**
 * 烘焙 viaPush 的表（rig.muscles 里已有全为 0 的 viaPush，见 withZeroPush）。返回新的作用线数组和每条的最大推出量。
 * Bake the viaPush tables (the lines in rig.muscles already carry an all-zero viaPush, see withZeroPush). Returns the
 * new array of lines and the largest push of each.
 */
export function bakeViaPush(rig: Rig, bin: Uint8Array, body: Body): { muscles: MuscleLine[]; report: PushReportRow[] } {
  const K = VIA_SAMPLES
  const bindingOf = new Map(rig.bindings.map((b) => [b.part, b]))
  const jointIndex = new Map(rig.joints.map((j, i) => [j.id, i]))
  const jobs = rig.muscles.flatMap((line, li) => {
    const mesh = body.meshes.get(line.part)
    const prep = mesh && hasViaPush(line) ? viaPrepFor(line, mesh.positions, bin, bindingOf.get(line.part), jointIndex) : null
    const O = line.origin.point, I = line.insertion.point
    const length = Math.hypot(I[0] - O[0], I[1] - O[1], I[2] - O[2])
    const share = Float64Array.from({ length: K }, (_, k) => viaShare(k / (K - 1), length))
    return mesh && prep && line.viaPush ? [{ li, line, mesh, prep, share, push: line.viaPush, table: new Array<number>(line.viaPush.d.length).fill(0) }] : []
  })
  if (!jobs.length) return { muscles: rig.muscles, report: [] }
  // 静止时在骨里的顶点不推 / vertices inside a bone at rest are not pushed
  const restBones = kneeBones(body, new Poser(rig, bin, {}))
  const skip = jobs.map((j) => {
    const p = j.mesh.positions, f = new Uint8Array(p.length / 3)
    for (let i = 0; i < f.length; i++) f[i] = restBones.some((b) => b.contains(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!)) ? 1 : 0
    return f
  })
  const rows = Math.max(...jobs.map((j) => j.push.d.length / (K * 3)))
  // 皮肤（三角形最多的皮肤部件）和普通蒙皮的对照 / the skin (the skin part with most triangles) and the plain-skinning reference
  const skinPart = body.data.parts.filter((p) => p.tissue === 'skin' && body.meshes.has(p.id)).sort((a, b) => b.triangles - a.triangles)[0]
  const plainRig: Rig = { ...rig, muscles: rig.muscles.map((m) => { const { viaPush: _p, ...r } = m; return r }) }
  const knees = [...new Set(jobs.map((j) => j.push.joint))]
  for (let r = 1; r < rows; r++) {
    const theta = (r * PUSH_STEP_DEG * Math.PI) / 180
    const pose: Pose = Object.fromEntries(knees.map((k) => [k, [theta]]))
    const poser = new Poser(rig, bin, pose)
    const plain = new Poser(plainRig, bin, pose)
    const bones = kneeBones(body, poser)
    const surface = skinPart ? new Surface([{ positions: plain.part(skinPart.id, body.meshes.get(skinPart.id)!.positions, 'dqs', false), indices: body.meshes.get(skinPart.id)!.indices }]) : null
    jobs.forEach((j, n) => {
      if ((r + 1) * K * 3 > j.table.length) return
      const out = poser.part(j.line.part, j.mesh.positions, 'dqs', { mode: 'tapered' })
      let skin: { surface: Surface; allow: Float32Array } | undefined
      if (surface && r * PUSH_STEP_DEG <= SKIN_UNTIL_DEG) {
        const po = plain.part(j.line.part, j.mesh.positions, 'dqs', { mode: 'tapered' })
        // 允许的皮肤外距离：普通蒙皮下该顶点在皮肤外多远（在里面为 0）/ the allowed distance outside the skin: how far outside it the vertex lies under plain skinning (0 when inside)
        const allow = new Float32Array(po.length / 3)
        for (let i = 0; i < allow.length; i++) allow[i] = Math.max(0, surface.signed(po[i * 3]!, po[i * 3 + 1]!, po[i * 3 + 2]!))
        skin = { surface, allow }
      }
      const D = pushOut(out, j.prep.s, skip[n]!, bones, j.share, skin)
      // 转到股骨坐标：Rᵀ·D / into the femur's frame: Rᵀ·D
      const R = poser.rigid[poser.jointIndex.get(j.push.frame)!]!.r
      for (let k = 0; k < K; k++) {
        const x = D[k * 3]!, y = D[k * 3 + 1]!, z = D[k * 3 + 2]!
        const o = (r * K + k) * 3
        j.table[o] = r5(R[0] * x + R[3] * y + R[6] * z)
        j.table[o + 1] = r5(R[1] * x + R[4] * y + R[7] * z)
        j.table[o + 2] = r5(R[2] * x + R[5] * y + R[8] * z)
      }
    })
  }
  const muscles = rig.muscles.slice()
  const report: PushReportRow[] = []
  for (const j of jobs) {
    muscles[j.li] = { ...j.line, viaPush: { ...j.push, d: j.table } }
    let maxMm = 0, atDeg = 0
    for (let o = 0; o < j.table.length; o += 3) {
      const m = Math.hypot(j.table[o]!, j.table[o + 1]!, j.table[o + 2]!) * 1000
      if (m > maxMm) (maxMm = m), (atDeg = Math.floor(o / (K * 3)) * PUSH_STEP_DEG)
    }
    report.push({ part: j.line.part, maxMm: Math.round(maxMm * 10) / 10, atDeg })
  }
  return { muscles, report }
}
