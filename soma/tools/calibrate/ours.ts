// 我们这一侧的量：读两副身体的当前数据，算肌肉长度—关节角曲线、关节中心、部件体积。
// Our side of every comparison: reads the current data of the two bodies and computes muscle length versus joint angle,
// joint centres and part volumes.
//
// 只读：不改 public/anatomy/ 下的任何文件，也不运行几何管线或骨架构建。
// Read-only: nothing under public/anatomy/ is changed, and neither the geometry pipeline nor the rig build is run.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { BodyId, Joint, MuscleLine, Part, Rig } from '../../src/anatomy/types.ts'
import { type Body, readBody } from '../rig/io.ts'
import { type V3, deg, dist, dot, norm, rad, sub } from '../rig/math.ts'
import { type Pose, Poser, armElevation, muscleLength } from '../rig/pose.ts'
import { PoseBuilder } from '../rig/postures.ts'
import { OUT, ROOT, type RefInfo } from './refs.ts'

export const BODIES: BodyId[] = ['male', 'female']

export interface Ours {
  id: BodyId
  body: Body
  rig: Rig
  bin: Uint8Array
  /** 部件英文名 → 部件（同名可以有几个）/ English part name → parts (a name may have several). */
  byName: Map<string, Part[]>
  joint: Map<string, Joint>
  lineOf: Map<string, MuscleLine>
  /** 所用数据的状态：各文件 sha256 的前 12 位 / the state of the data used: first 12 hex of each file's sha256. */
  state: Record<string, string>
}

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)

const cache = new Map<BodyId, Promise<Ours>>()

/**
 * 绑定从哪里读：环境变量 SOMA_RIG_DIR 指向一个目录时读 <目录>/<body>/rig.json 和 rig.bin（例如 tools/rig/run.ts --out
 * 构建到别处的绑定），其余数据仍取 public/anatomy/<body>/。
 * Where the rig is read from: with the environment variable SOMA_RIG_DIR naming a directory, <dir>/<body>/rig.json and
 * rig.bin are read (e.g. a rig built elsewhere with tools/rig/run.ts --out); everything else still comes from
 * public/anatomy/<body>/.
 */
export const rigDir = (id: BodyId): string => (process.env.SOMA_RIG_DIR ? join(process.env.SOMA_RIG_DIR, id) : join(ROOT, 'public', 'anatomy', id))

export function loadOurs(id: BodyId): Promise<Ours> {
  let p = cache.get(id)
  if (!p) {
    p = (async () => {
      const dir = join(ROOT, 'public', 'anatomy', id)
      const body = await readBody(dir)
      const rdir = rigDir(id)
      const rig = JSON.parse(readFileSync(join(rdir, 'rig.json'), 'utf8')) as Rig
      const bin = new Uint8Array(readFileSync(join(rdir, 'rig.bin')))
      const byName = new Map<string, Part[]>()
      for (const part of body.data.parts) byName.set(part.name, [...(byName.get(part.name) ?? []), part])
      const state: Record<string, string> = {}
      for (const f of ['anatomy.json', 'rig.json', 'rig.bin', 'face.json', 'face.bin', 'muscular.glb', 'skeletal.glb', 'integumentary.glb']) {
        const at = f.startsWith('rig.') ? join(rdir, f) : join(dir, f)
        if (existsSync(at)) state[f] = sha(at)
      }
      return { id, body, rig, bin, byName, joint: new Map(rig.joints.map((j) => [j.id, j])), lineOf: new Map(rig.muscles.map((m) => [m.part, m])), state }
    })()
    cache.set(id, p)
  }
  return p
}

export const center = (o: Ours, id: string): V3 => o.joint.get(id)!.center as V3

/** 某自由度的解剖学范围（度，0 = 解剖学零位）/ the anatomical range of a dof (degrees, 0 = anatomical zero). */
export function anatRange(o: Ours, joint: string, axis: number): [number, number] | null {
  const d = o.joint.get(joint)?.dofs.find((x) => x.axis === axis)
  return d ? [deg(d.min - (d.neutral ?? 0)), deg(d.max - (d.neutral ?? 0))] : null
}

export const LUMBAR = ['L5', 'L4', 'L3', 'L2', 'L1']

/** 把我们的一个“坐标”摆到给定的解剖学角度 / puts one of our "coordinates" at an anatomical angle. */
export type OurCoord =
  | { kind: 'dof'; joint: string; axis: number }
  /** 上臂相对躯干抬高（含肩带节律）：plane 0 = 外展，1 = 前屈 / arm elevation against the trunk (girdle rhythm included): plane 0 = abduction, 1 = flexion. */
  | { kind: 'elevation'; side: 'L' | 'R'; plane: 0 | 1 }
  /** 把总角度按范围分到五个腰椎关节上 / a total angle spread over the five lumbar joints by their ranges. */
  | { kind: 'lumbar'; axis: number }

export function coordRange(o: Ours, c: OurCoord): [number, number] | null {
  if (c.kind === 'dof') return anatRange(o, c.joint, c.axis)
  if (c.kind === 'elevation') return [10, 150]
  let lo = 0, hi = 0
  for (const j of LUMBAR) {
    const r = anatRange(o, j, c.axis)
    if (r) (lo += r[0]), (hi += r[1])
  }
  return [lo, hi]
}

export function coordPose(o: Ours, c: OurCoord, degrees: number): Pose {
  if (c.kind === 'elevation') return armElevation(o.rig.joints, c.side, rad(degrees), c.plane)
  const pb = new PoseBuilder(o.rig.joints)
  if (c.kind === 'dof') pb.anat(c.joint, c.axis, degrees)
  else pb.spread(LUMBAR, c.axis, degrees)
  return pb.pose
}

export const coordLabel = (c: OurCoord): string => (c.kind === 'dof' ? `${c.joint}.${c.axis}` : c.kind === 'elevation' ? `armElevation(${c.side}, ${c.plane === 0 ? 'abduction' : 'flexion'})` : `lumbar spread ${LUMBAR.join('+')} axis ${c.axis}`)

const SLICES = 14

/**
 * 肌肉在一串姿势下的长度（毫米）。mesh：变形后网格的中心线（按静止时沿主方向分 14 段取质心，与 tools/rig/validate.ts 同法），
 * 所有肌肉都有；line：作用线（起点到止点的直线），只有带作用线的肌肉才有。同名的几个部件取平均。
 * Length of a muscle over a series of poses, in mm. `mesh`: centreline of the deformed mesh (centroids of 14 slices along the
 * rest direction, as in tools/rig/validate.ts), available for every muscle; `line`: the line of action (straight, origin to
 * insertion), only where the rig has one. Several parts of one name are averaged.
 */
export function muscleCurve(o: Ours, parts: Part[], poses: Pose[]): { mesh: number[]; line: number[] | null } {
  const mesh = poses.map(() => 0)
  let line: number[] | null = poses.map(() => 0)
  const posers = poses.map((p) => new Poser(o.rig, o.bin, p))
  for (const part of parts) {
    const m = o.body.meshes.get(part.id)!
    const ln = o.lineOf.get(part.id)
    if (!ln) line = null
    let base: V3, dir: V3, span: number
    if (ln) {
      base = ln.origin.point as V3
      const d = sub(ln.insertion.point as V3, base)
      span = Math.hypot(d[0], d[1], d[2])
      dir = norm(d)
    } else {
      const bb = part.bbox
      const ext = [bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]]
      const k = ext.indexOf(Math.max(...ext))
      dir = [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0]
      base = [bb[0], bb[1], bb[2]]
      span = ext[k]!
    }
    const n = m.positions.length / 3
    const bin = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      const t = dot(sub([m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!], base), dir) / span
      bin[i] = Math.min(SLICES - 1, Math.max(0, Math.floor(t * SLICES)))
    }
    posers.forEach((poser, k) => {
      const ml = ln ? muscleLength(ln, poser.xfs, poser.jointIndex) : null
      if (ml && line) line[k] = line[k]! + (1000 * ml.length) / parts.length
      const pos = poser.part(part.id, m.positions, 'dqs', false)
      const c = new Float64Array(SLICES * 3), cnt = new Int32Array(SLICES)
      for (let i = 0; i < n; i++) {
        const b = bin[i]!
        c[b * 3] = c[b * 3]! + pos[i * 3]!
        c[b * 3 + 1] = c[b * 3 + 1]! + pos[i * 3 + 1]!
        c[b * 3 + 2] = c[b * 3 + 2]! + pos[i * 3 + 2]!
        cnt[b] = cnt[b]! + 1
      }
      let L = 0, prev: V3 | null = ml ? ml.origin : null
      for (let b = 0; b < SLICES; b++) {
        if (!cnt[b]) continue
        const p: V3 = [c[b * 3]! / cnt[b]!, c[b * 3 + 1]! / cnt[b]!, c[b * 3 + 2]! / cnt[b]!]
        if (prev) L += dist(prev, p)
        prev = p
      }
      if (ml && prev) L += dist(prev, ml.insertion)
      mesh[k] = mesh[k]! + (1000 * L) / parts.length
    })
  }
  return { mesh, line }
}

// ── 表的公共格式 / the common table format ───────────────────────────────────────────────────

export interface Bilingual {
  zh: string
  en: string
}

export type Verdict = 'within' | 'outside' | 'not comparable'

export interface Table<Row> {
  schema: 1
  id: string
  title: Bilingual
  /** 比的是什么量、怎么算的、容差怎么定的 / what is compared, how it is computed and how the tolerance was set. */
  method: Bilingual
  tolerance: Bilingual
  references: RefInfo[]
  /** 我们这一侧所用数据的状态（文件哈希）/ the state of our data that was used (file hashes). */
  ourState: Record<string, Record<string, string>>
  notes: Bilingual[]
  summary: Record<string, number | string>
  rows: Row[]
}

export const r1 = (x: number): number => Math.round(x * 10) / 10
export const r2 = (x: number): number => Math.round(x * 100) / 100
export const r3 = (x: number): number => Math.round(x * 1000) / 1000

export function writeTable<Row>(t: Table<Row>): void {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, `${t.id}.json`), JSON.stringify(t, null, 1) + '\n')
}

export const count = <T>(rows: T[], f: (r: T) => boolean): number => rows.reduce((s, r) => s + (f(r) ? 1 : 0), 0)
