// 内镜漫游的纯逻辑：没有顶点圈的网格的中心线、第一段的走向、相机的视线平滑和"上"方向、路线、地址参数；
// 后半部分用两副人体的真实数据核对各条路线。
// The pure logic of the fly-through: the centreline of a mesh without rings, the direction of the first
// segment, the camera's view smoothing and up, the routes and the URL parameter; the second half checks every
// route against the real data of both bodies.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { AnatomyGraph } from '../src/anatomy/graph.ts'
import type { AnatomyData } from '../src/anatomy/types.ts'
import {
  CANAL_ROUTE,
  FLY_CAMERA,
  applyFilling,
  buildCanalPath,
  findFlyStart,
  flyFrames,
  flyPose,
  flyRoutes,
  formatLumenParams,
  keepPlace,
  meshCentreline,
  parseLumenParams,
  pathPoint,
  ringStations,
  ringsOf,
  widenRings,
  type CanalPath,
  type FillingEntry,
  type PathSegmentInput,
  type V3,
} from '../src/lumen/core.ts'
import { realLumina, routesOf, useLumen, type LumenData, type LumenPathFile } from '../src/lumen/state.ts'
import { readGlbParts, type RawMesh } from '../tools/skinmaps/io.ts'

/** 沿一条中心线的管（每站一圈 sides 个顶点），顶点打乱成不成圈的次序 / A tube along a centreline (a ring of `sides` vertices per station), vertices scrambled out of ring order. */
function tubeAlong(centre: (k: number) => V3, stations: number, sides: number, r: number): { position: Float32Array; index: Uint32Array } {
  const pos: number[] = []
  const idx: number[] = []
  for (let k = 0; k < stations; k++) {
    const c = centre(k)
    const n = centre(Math.min(stations - 1, k + 1))
    const p = centre(Math.max(0, k - 1))
    const t = [n[0] - p[0], n[1] - p[1], n[2] - p[2]]
    const tl = Math.hypot(t[0]!, t[1]!, t[2]!)
    const tn = t.map((x) => x / tl)
    // 与切线垂直的两个方向（切线在 xy 平面里）/ two directions normal to the tangent (which lies in the xy plane)
    const u = [-tn[1]!, tn[0]!, 0]
    const w = [0, 0, 1]
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * Math.PI * 2
      pos.push(c[0] + r * (Math.cos(a) * u[0]! + Math.sin(a) * w[0]!), c[1] + r * (Math.cos(a) * u[1]! + Math.sin(a) * w[1]!), c[2] + r * (Math.cos(a) * u[2]! + Math.sin(a) * w[2]!))
    }
  }
  for (let k = 0; k + 1 < stations; k++) {
    for (let j = 0; j < sides; j++) {
      const a = k * sides + j, b = k * sides + ((j + 1) % sides), c = a + sides, d = b + sides
      idx.push(a, c, b, b, c, d)
    }
  }
  const n = pos.length / 3
  const to = Array.from({ length: n }, (_, i) => (i * 7 + 5) % n)
  const position = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) position[to[i]! * 3 + c] = pos[i * 3 + c]!
  return { position, index: Uint32Array.from(idx, (v) => to[v]!) }
}

const line = (from: V3, to: V3, n: number, r: number) => Array.from({ length: n }, (_, k) => ({ c: [0, 1, 2].map((a) => from[a]! + ((to[a]! - from[a]!) * k) / (n - 1)) as V3, r, rMin: r }))

/** 每毫米视线转过的最大角度和"上"方向变化的最大角度（度）/ Largest turn of the view and largest change of up per millimetre (degrees). */
function rates(path: CanalPath, reverse = false): { turn: number; roll: number } {
  const frames = flyFrames(path)
  let turn = 0, roll = 0
  let prev = flyPose(path, frames, 0, reverse)
  const deg = (a: V3, b: V3): number => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI
  for (let s = 0.001; s <= path.length; s += 0.001) {
    const p = flyPose(path, frames, s, reverse)
    turn = Math.max(turn, deg(p.dir, prev.dir))
    roll = Math.max(roll, deg(p.up, prev.up))
    prev = p
  }
  return { turn, roll }
}

describe('the centreline of a mesh without rings', () => {
  it('follows a bent tube from the end nearest the previous exit, with the right radius', () => {
    // 四分之一圆弧，半径 50 毫米，管半径 4 毫米 / a quarter arc of radius 50 mm, tube radius 4 mm
    const R = 0.05
    const arc = (k: number): V3 => [R * Math.cos((k / 40) * (Math.PI / 2)), R * Math.sin((k / 40) * (Math.PI / 2)), 0]
    const m = tubeAlong(arc, 41, 12, 0.004)
    const st = meshCentreline(m.position, m.index, { from: [0.06, -0.01, 0] })!
    expect(st.length).toBeGreaterThan(15)
    // 从 (R, 0) 一端开始，到 (0, R) 一端结束 / starts at the (R, 0) end and ends at the (0, R) end
    expect(st[0]!.c[0]).toBeGreaterThan(0.045)
    expect(st[st.length - 1]!.c[1]).toBeGreaterThan(0.045)
    // 中间各站在弧上（误差 1 毫米以内），半径约 4 毫米（层是斜切的，偏大不到两成）/ the stations in between lie on the arc (within 1 mm), radius about 4 mm (the layers are cut obliquely, so up to a fifth too large)
    for (const s of st.slice(3, -3)) {
      expect(Math.abs(Math.hypot(s.c[0], s.c[1]) - R)).toBeLessThan(0.001)
      expect(Math.abs(s.c[2])).toBeLessThan(0.001)
      expect(s.r).toBeGreaterThan(0.0035)
      expect(s.r).toBeLessThan(0.0048)
    }
    // 只给"下一段在哪"时从远离它的一端开始 / given only where the next segment is, it starts at the end away from it
    const back = meshCentreline(m.position, m.index, { to: [0.06, -0.01, 0] })!
    expect(back[0]!.c[1]).toBeGreaterThan(0.045)
    expect(meshCentreline(new Float32Array(6), new Uint32Array(0))).toBeNull()
  })

  it('joins such a mesh into the path at the previous segment’s exit', () => {
    const m = tubeAlong((k) => [0, -k * 0.002, 0], 31, 12, 0.004)
    const inputs: PathSegmentInput[] = [
      { id: 'tube', stations: line([0, 0.05, 0], [0, 0.002, 0], 10, 0.004) },
      { id: 'mesh', mesh: m },
    ]
    const path = buildCanalPath(inputs, 0.001)!
    expect(path.segments.map((s) => s.id)).toEqual(['tube', 'mesh'])
    // 第一层是起点顶点周围的一小块，质心偏在壁上，所以会有一个管半径左右的接缝 / the first layer is a patch around the start vertex whose centroid sits towards the wall, hence a join of about a tube radius
    expect(path.segments[1]!.bridged).toBeLessThan(0.006)
    // 网格一段从上往下走完 / the mesh segment is walked from top to bottom
    expect(pathPoint(path, path.length)[1]).toBeLessThan(-0.05)
    expect(path.length).toBeGreaterThan(0.048 + 0.05)
  })

  it('enters the first segment at the end away from the next one', () => {
    // 输尿管：顶点圈的次序从膀胱端开始；路线应从肾端开始 / a ureter whose ring order starts at the bladder end; the route must start at the kidney end
    const inputs: PathSegmentInput[] = [
      { id: 'ureter', stations: line([0.03, 0.82, 0.07], [0.06, 1.07, 0.07], 30, 0.0003) },
      { id: 'bladder', stations: line([0.027, 0.81, 0.08], [-0.027, 0.81, 0.08], 20, 0.0025) },
    ]
    const path = buildCanalPath(inputs, 0.001)!
    expect(pathPoint(path, 0)[1]).toBeCloseTo(1.07, 6)
    expect(path.segments[1]!.bridged).toBeLessThan(0.02)
  })
})

describe('the fly-through camera', () => {
  /** 直线、一个半径 1.5 毫米的掉头弯、再直线 / straight, an about-turn of radius 1.5 mm, straight again */
  function hairpin(): CanalPath {
    const r = 0.0015
    const pts: V3[] = []
    for (let k = 0; k <= 40; k++) pts.push([0, 0.06 - k * 0.0015, 0])
    for (let k = 1; k < 12; k++) {
      const a = Math.PI - (k / 12) * Math.PI
      pts.push([r + r * Math.cos(a), -r * Math.sin(a), 0])
    }
    for (let k = 0; k <= 40; k++) pts.push([2 * r, k * 0.0015, 0])
    return buildCanalPath([{ id: 'u', stations: pts.map((c) => ({ c, r: 0.003, rMin: 0.003 })) }], 0.0015)!
  }

  it('limits the turn at a doubling-back instead of whipping round within a millimetre', () => {
    const path = hairpin()
    const limit = (FLY_CAMERA.maxTurn * 180) / Math.PI
    const { turn, roll } = rates(path)
    expect(turn).toBeLessThan(limit + 0.5)
    expect(roll).toBeLessThan(limit + 1.5)
    // 不平滑时同一处每毫米转过五十多度 / without the smoothing the same place turns by over fifty degrees per millimetre
    const raw = flyFrames(path, { sigma: 0, maxTurn: 0, righting: 0 })
    let worst = 0
    for (let i = 1; i < path.seg.length; i++) {
      const c = raw.dir[i * 3]! * raw.dir[i * 3 - 3]! + raw.dir[i * 3 + 1]! * raw.dir[i * 3 - 2]! + raw.dir[i * 3 + 2]! * raw.dir[i * 3 - 1]!
      worst = Math.max(worst, (Math.acos(Math.min(1, c)) * 180) / Math.PI / 1.5)
    }
    expect(worst).toBeGreaterThan(30)
  })

  it('gives unit, perpendicular view and up vectors that depend only on the place, and reverses the view', () => {
    const path = hairpin()
    const frames = flyFrames(path)
    for (const s of [0, 0.01, 0.061, 0.0632, 0.09, path.length]) {
      const a = flyPose(path, frames, s)
      const b = flyPose(path, flyFrames(path), s)
      expect(a).toEqual(b)
      expect(Math.hypot(...a.dir)).toBeCloseTo(1, 6)
      expect(Math.hypot(...a.up)).toBeCloseTo(1, 6)
      expect(a.dir[0] * a.up[0] + a.dir[1] * a.up[1] + a.dir[2] * a.up[2]).toBeCloseTo(0, 6)
      const r = flyPose(path, frames, s, true)
      expect(r.dir.map((x) => -x)).toEqual(a.dir.map((x) => x + 0))
      expect(r.up).toEqual(a.up)
    }
  })

  it('keeps the body’s up in a horizontal tube and never loses it in a vertical one', () => {
    const flat = buildCanalPath([{ id: 'h', stations: line([0, 1, 0], [0.2, 1, 0], 50, 0.01) }], 0.0015)!
    const f = flyFrames(flat)
    const mid = flyPose(flat, f, 0.1)
    expect(mid.up[1]).toBeCloseTo(1, 5)
    const down = buildCanalPath([{ id: 'v', stations: line([0, 1.4, 0.1], [0, 1.1, 0.1], 50, 0.002) }], 0.0015)!
    const g = flyFrames(down)
    // 视线竖直向下时"上"取身体的前方 / looking straight down, up is the body's front
    expect(flyPose(down, g, 0.15).up[2]).toBeCloseTo(1, 5)
  })
})

describe('keeping the place when the path is rebuilt', () => {
  it('stays between the same two stations when a segment before it stretches (breathing)', () => {
    const a: PathSegmentInput[] = [
      { id: 'a', stations: line([0, 0, 0], [0.1, 0, 0], 21, 0.003) },
      { id: 'b', stations: line([0.1, 0, 0], [0.2, 0, 0], 21, 0.003) },
    ]
    // 第一段拉长一成，第二段整体平移 / the first segment stretched by a tenth, the second shifted as a whole
    const b: PathSegmentInput[] = [
      { id: 'a', stations: line([0, 0, 0], [0.11, 0, 0], 21, 0.003) },
      { id: 'b', stations: line([0.11, 0, 0], [0.21, 0, 0], 21, 0.003) },
    ]
    const pa = buildCanalPath(a, 0.001)!, pb = buildCanalPath(b, 0.001)!
    // 第二段里离起点 37 毫米处：仍在第二段的同一处 / 37 mm into the second segment: still at the same place in it
    expect(keepPlace(pa, pb, 0.137)).toBeCloseTo(0.147, 4)
    // 第一段里 50 毫米处（第 10 站）：拉长后在 55 毫米 / 50 mm into the first (station 10): at 55 mm once stretched
    expect(keepPlace(pa, pb, 0.05)).toBeCloseTo(0.055, 4)
    // 按总长换算会错开 / rescaling by the total length would be off
    expect(Math.abs((0.137 / pa.length) * pb.length - 0.147)).toBeGreaterThan(0.002)
    // 段对不上时按总长的比例 / segments that do not match: by the total length
    const pc = buildCanalPath([{ id: 'c', stations: line([0, 0, 0], [0.4, 0, 0], 41, 0.003) }], 0.001)!
    expect(keepPlace(pa, pc, 0.1)).toBeCloseTo(0.2, 4)
  })
})

describe('fly-through routes and their URL parameter', () => {
  const canal = ['LUMEN_oral_cavity', 'LUMEN_esophagus', 'WU_rectal_lumen']
  const female = new Set([...canal, 'LUMEN_urinary_bladder', 'LUMEN_ureter_L', 'WU_vaginal_lumen', 'WU_cervical_canal', 'WU_uterine_cavity', 'LUMEN_uterine_tube_L', 'LUMEN_uterine_tube_R'])

  it('offers the routes whose first lumen is present, without the missing lumina', () => {
    const routes = flyRoutes(canal, (id) => female.has(id))
    expect(routes.map((r) => r.key)).toEqual([CANAL_ROUTE, 'ureter_l', 'uterine_l', 'uterine_r'])
    expect(routes[1]!.parts).toEqual(['LUMEN_ureter_L', 'LUMEN_urinary_bladder'])
    expect(routes[2]!.parts).toEqual(['WU_vaginal_lumen', 'WU_cervical_canal', 'WU_uterine_cavity', 'LUMEN_uterine_tube_L'])
    // 尿道的腔到了就接在膀胱后面 / the urethral lumen joins after the bladder once it is there
    expect(flyRoutes(canal, (id) => female.has(id) || id === 'LUMEN_urethra')[1]!.parts).toEqual(['LUMEN_ureter_L', 'LUMEN_urinary_bladder', 'LUMEN_urethra'])
  })

  it('finds where a fly-through starts from a route key, a part id, a segment key or millimetres', () => {
    const routes = flyRoutes(canal, (id) => female.has(id))
    const keyOf = (id: string): string => id.replace(/^(LUMEN|WU)_/, '').replace(/_lumen$/, '').toLowerCase()
    expect(findFlyStart(routes, 'uterine_r', null, keyOf)).toMatchObject({ route: { key: 'uterine_r' }, part: null })
    expect(findFlyStart(routes, 'esophagus', null, keyOf)).toMatchObject({ route: { key: CANAL_ROUTE }, part: 'LUMEN_esophagus' })
    expect(findFlyStart(routes, 'oesophagus', null, keyOf)).toMatchObject({ part: 'LUMEN_esophagus' })
    // 两条路线共有的段：先找当前的路线 / a segment on two routes: the current route first
    expect(findFlyStart(routes, 'WU_cervical_canal', 'uterine_r', keyOf)).toMatchObject({ route: { key: 'uterine_r' } })
    expect(findFlyStart(routes, 'WU_cervical_canal', null, keyOf)).toMatchObject({ route: { key: 'uterine_l' } })
    expect(findFlyStart(routes, 120, 'ureter_l', keyOf)).toMatchObject({ route: { key: 'ureter_l' }, mm: 120 })
    expect(findFlyStart(routes, 120, null, keyOf)).toMatchObject({ route: { key: CANAL_ROUTE } })
    expect(findFlyStart(routes, 'nowhere', null, keyOf)).toBeNull()
  })

  it('reads and writes "route:millimetres" and keeps the canal’s plain forms', () => {
    const a = parseLumenParams('?fly=ureter_l:120')
    expect(a.warnings).toEqual([])
    expect(a.params.fly).toEqual({ at: 120, route: 'ureter_l' })
    expect(formatLumenParams(a.params).fly).toBe('ureter_l:120')
    expect(parseLumenParams('?fly=uterine_r').params.fly).toEqual({ at: 'uterine_r' })
    expect(formatLumenParams({ ...a.params, fly: { at: 420.4, route: CANAL_ROUTE } }).fly).toBe('420')
    expect(formatLumenParams({ ...a.params, fly: { at: 420.4 } }).fly).toBe('420')
    expect(parseLumenParams('?fly=ureter_l:').warnings.length).toBe(1)
  })
})

describe('the fly-through controls', () => {
  it('starts again from the near end when "play" is pressed at the far end', () => {
    const L = useLumen
    L.setState({ fly: { playing: false, speed: 1, reverse: false }, flyS: 3.5, flyTotal: 3.5, seek: { nonce: 0, s: 0 } })
    L.getState().setFly({ playing: true })
    expect(L.getState().fly!.playing).toBe(true)
    expect(L.getState().flyS).toBe(0)
    expect(L.getState().seek).toEqual({ nonce: 1, s: 0 })
    // 反向时起点那一头是"尽头" / in reverse the start is the far end
    L.setState({ fly: { playing: false, speed: 1, reverse: true }, flyS: 0 })
    L.getState().setFly({ playing: true })
    expect(L.getState().flyS).toBe(3.5)
    // 中途按播放不跳 / "play" midway does not jump
    L.setState({ fly: { playing: false, speed: 1, reverse: false }, flyS: 1.2 })
    L.getState().setFly({ playing: true })
    expect(L.getState().flyS).toBe(1.2)
    L.getState().stopFly()
    expect(L.getState().flyRoute).toBeNull()
  })

  it('keeps the route of a fly-through started at millimetres and takes a given route', () => {
    const L = useLumen
    L.setState({ fly: null, flyRoute: 'ureter_l', data: null, status: 'idle' })
    L.getState().startFly(120)
    expect(L.getState().flyRoute).toBe('ureter_l')
    L.getState().startFly('uterine_r', 'uterine_r')
    expect(L.getState().flyRoute).toBe('uterine_r')
    L.getState().startFly('esophagus')
    expect(L.getState().flyRoute).toBeNull()
    L.getState().stopFly()
  })
})

// ------------------------------------------------------------ 真实数据 / the real data

const ROOT = join(import.meta.dirname, '../public/anatomy')

for (const body of ['male', 'female']) {
  const DIR = join(ROOT, body)
  const HAS = existsSync(join(DIR, 'lumen-filling.json')) && existsSync(join(DIR, 'lumen-path.json'))
  describe.skipIf(!HAS)(`the ${body} body: every fly-through route as the viewer builds it`, () => {
    let data: AnatomyData
    let sidecar: LumenPathFile
    let entries: FillingEntry[] = []
    let bin = new Float32Array(0)
    const meshes = new Map<string, RawMesh>()

    beforeAll(async () => {
      data = JSON.parse(readFileSync(join(DIR, 'anatomy.json'), 'utf8')) as AnatomyData
      sidecar = JSON.parse(readFileSync(join(DIR, 'lumen-path.json'), 'utf8')) as LumenPathFile
      entries = (JSON.parse(readFileSync(join(DIR, 'lumen-filling.json'), 'utf8')) as { parts: FillingEntry[] }).parts
      const raw = readFileSync(join(DIR, 'lumen-filling.bin'))
      bin = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
      const ids = new Set(data.parts.filter((p) => p.tissue === 'space').map((p) => p.id))
      for (const sys of new Set(data.parts.filter((p) => ids.has(p.id)).map((p) => p.system))) for (const [id, m] of await readGlbParts(join(DIR, `${sys}.glb`), ids)) meshes.set(id, m)
    })

    /** 和查看器一样：充盈到至少 0.5、撑开到 3 毫米；没有顶点圈的用网格 / As the viewer: filled to at least 0.5 and widened to 3 mm; meshes without rings as meshes. */
    function inputsFor(parts: readonly string[]): PathSegmentInput[] {
      return parts.map((id) => {
        const m = meshes.get(id)!
        const guide = sidecar.guides[id]
        if (guide) return { id, guide: guide.map((p) => [p[0] / 1000, p[1] / 1000, p[2] / 1000] as V3) }
        const position = Float32Array.from(m.positions)
        const e = entries.find((x) => x.part === id)
        const r = ringsOf(m.indices, position.length / 3)
        if (e && e.vertices * 3 === position.length) {
          applyFilling(m.positions, bin.subarray(e.offset / 4, e.offset / 4 + e.vertices * 3), Math.max(e.rest, 0.5), e.rest, position)
          if (r) widenRings(position, r.rings, 0.003)
        }
        if (!r) return { id, mesh: { position, index: m.indices } }
        return { id, stations: ringStations(r.rings, position), poleStart: r.poleStart !== null, poleEnd: r.poleEnd !== null }
      })
    }

    it('builds every route with every segment on it, and turns the view at most the set rate', () => {
      // 路线和查看器里一样由 routesOf 定 / the routes come from routesOf, as in the viewer
      const graph = new AnatomyGraph(data)
      const map = new Map(entries.map((e) => [e.part, e]))
      const routes = routesOf(graph, { entries: map, real: realLumina(graph, map, sidecar), path: sidecar } as unknown as LumenData)
      if (body === 'female') expect(routes.find((r) => r.key === 'uterine_l')!.parts).toContain('WU_uterine_cavity')
      expect(routes[0]!.key).toBe(CANAL_ROUTE)
      expect(routes.length).toBeGreaterThan(2)
      for (const route of routes) {
        const path = buildCanalPath(inputsFor(route.parts))!
        expect(path.segments.map((s) => s.id), route.key).toEqual(route.parts)
        // 段间直线连过去的都不到 60 毫米 / every straight join is under 60 mm
        for (const s of path.segments) expect(s.bridged, `${route.key} ${s.id}`).toBeLessThan(0.06)
        const { turn, roll } = rates(path)
        expect(turn, route.key).toBeLessThan((FLY_CAMERA.maxTurn * 180) / Math.PI + 0.5)
        expect(roll, route.key).toBeLessThan((FLY_CAMERA.maxTurn * 180) / Math.PI + 1.5)
      }
    })

    it.skipIf(body !== 'female')('puts her own rectal lumen on the canal with a centreline near the report’s length', () => {
      const path = buildCanalPath(inputsFor(sidecar.canal))!
      const rectum = path.segments.find((s) => s.id === 'WU_rectal_lumen')!
      const mm = (rectum.end - rectum.start - rectum.bridged) * 1000
      // 报告里管线自己的中心线是 150.5 毫米 / the pipeline's own centreline in the report is 150.5 mm
      expect(mm).toBeGreaterThan(130)
      expect(mm).toBeLessThan(190)
      expect(rectum.bridged).toBeLessThan(0.005)
      // 原来这里从降结肠直线连到肛管，跨 119 毫米 / it used to go straight from the descending colon to the anal canal, 119 mm across
      const anal = path.segments.find((s) => s.id === 'LUMEN_anal_canal')!
      expect(anal.bridged).toBeLessThan(0.005)
    })

    it.skipIf(body !== 'male')('flies each ureter from the kidney down into the bladder', () => {
      const routes = flyRoutes(sidecar.canal, (id) => meshes.has(id) && entries.some((e) => e.part === id))
      for (const key of ['ureter_l', 'ureter_r']) {
        const path = buildCanalPath(inputsFor(routes.find((r) => r.key === key)!.parts))!
        expect(pathPoint(path, 0)[1], key).toBeGreaterThan(1.0)
        expect(pathPoint(path, path.length)[1], key).toBeLessThan(0.83)
      }
    })
  })
}
