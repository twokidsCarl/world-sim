// 口腔和咽的腔：尽量以这副人体里真实的部件为界。lumenBuild.ts 调用；只读部件，不写任何东西。
//   · 固有口腔：舌背与腭（上颌骨、腭骨、腭帆的肌）之间、牙弓之内的空隙。中心线在中线上，取舌背最高处与腭最低处的中点。
//   · 咽：椎前平面（咽缝、咽缩肌、颈长肌、头长肌、颈椎）之前的空隙；侧壁是咽缩肌；前面是舌根、会厌、喉软骨，
//     那里没有东西的地方（通鼻腔、口腔、喉口）就没有界。
// 这里只给中心线和用来定界的部件；每条射线打到哪个真实的面、哪些方向什么也没打到（算构造），在 lumenBuild.ts 里算并报出面积。
// 这两副人体里没有“软腭”“硬腭”这样的部件：硬腭由上颌骨和腭骨代表，软腭只有它的几块肌。
//
// The cavities of mouth and pharynx, bounded as far as possible by real parts of this body. Called by
// lumenBuild.ts; parts are only read and nothing is written.
//   · oral cavity proper: the space between the dorsum of the tongue and the palate (maxillae, palatine
//     bones, muscles of the soft palate), inside the dental arches. The centreline is in the midline, at
//     the midpoint between the highest point of the dorsum and the lowest of the palate.
//   · pharynx: the space in front of the prevertebral plane (pharyngeal raphe, constrictors, longus colli
//     and capitis, cervical vertebrae); the lateral walls are the constrictors; in front lie the base of
//     the tongue, the epiglottis and the laryngeal cartilages, and where nothing lies there (the openings
//     to nose, mouth and larynx) there is no boundary.
// Only the centrelines and the bounding parts are given here; which real surface each ray meets and which
// directions meet nothing (construction) is worked out, with areas, in lumenBuild.ts.
// Neither body has a part called soft palate or hard palate: the hard palate is represented by the
// maxillae and palatine bones, the soft palate only by some of its muscles.

import type { Part } from '../../src/anatomy/types.ts'
import type { Mesh } from './geometry.ts'
import { rayNearest, type V3 } from './lumen.ts'

/** 定界部件的名称，按它们围住的是哪一面分组 / names of the bounding parts, grouped by the side they bound */
export const HEAD_BOUNDS: Record<string, RegExp> = {
  tongue: /^Tongue$/,
  tongueMuscles: /^(Left|Right) (genioglossus|hyoglossus)$/,
  hardPalate: /^(Left|Right) (maxilla|palatine bone)$/,
  softPalateMuscles: /^Uvular muscle$|^(Left|Right) (levator veli palatini|tensor veli palatini)$/,
  palatopharyngeus: /^(Left|Right) palatopharyngeus$/,
  tonsils: /^(Left|Right) palatine tonsil$/,
  mandible: /^Mandible$/,
  cheeks: /^(Left|Right) buccinator$/,
  lips: /^(Upper|Lower) lip$/,
  constrictors: /^(Left|Right) (superior|middle|inferior) pharyngeal constrictor$/,
  raphe: /^Pharyngeal raphe$/,
  prevertebralMuscles: /longus colli$|^(Left|Right) longus capitis$/,
  cervicalVertebrae: /^(Atlas|Axis)$|^(Third|Fourth|Fifth|Sixth|Seventh) cervical vertebra$/,
  hyoid: /^Hyoid bone$/,
  epiglottis: /^Epiglottis$/,
  laryngealCartilages: /^(Thyroid cartilage|Cricoid cartilage)$|^(Left|Right) arytenoid cartilage$/,
  laryngealMuscles: /^(Left|Right) (aryepiglotticus|oblique arytenoid|posterior crico-arytenoid)$|^Transverse arytenoid$/,
  trachea: /^Trachea$/,
}
const ORAL = ['tongue', 'hardPalate', 'softPalateMuscles', 'teeth', 'mandible', 'cheeks', 'lips']
const PHARYNX = ['constrictors', 'raphe', 'palatopharyngeus', 'prevertebralMuscles', 'cervicalVertebrae', 'tongue', 'tongueMuscles', 'softPalateMuscles', 'tonsils', 'hyoid', 'epiglottis', 'laryngealCartilages', 'laryngealMuscles']

export interface HeadGuides {
  oral: V3[]
  pharynx: V3[]
  oralBounds: { id: string; mesh: Mesh }[]
  pharynxBounds: { id: string; mesh: Mesh }[]
  /** 喉口：会厌上缘与杓状软骨顶之间的中点；气道从这里分出去（本任务不建气道的腔） / the laryngeal inlet: midway between the upper edge of the epiglottis and the tops of the arytenoid cartilages; the airway branches off here (no airway lumen is built in this task) */
  laryngealInlet: V3 | null
  /** 构造的腭帆：硬腭后缘到悬雍垂肌下端的一张扇形面（这副人体没有软腭部件） / the constructed velum: a fan from the posterior edge of the hard palate to the lower end of the uvular muscle (this body has no soft-palate part) */
  velum: Mesh | null
  report: Record<string, unknown>
}

export async function headGuides(parts: Part[], meshOf: (id: string) => Promise<Mesh>, oesIn: V3): Promise<HeadGuides> {
  const found: Record<string, string[]> = {}
  for (const [k, rx] of Object.entries(HEAD_BOUNDS)) found[k] = parts.filter((p) => rx.test(p.name) && p.tissue !== 'skin').map((p) => p.id)
  found.teeth = parts.filter((p) => p.tissue === 'tooth').map((p) => p.id)
  const meshes = new Map<string, Mesh>()
  for (const ids of Object.values(found)) for (const id of ids) if (!meshes.has(id)) meshes.set(id, await meshOf(id))
  const verts = (keys: string[]): Float32Array[] => keys.flatMap((k) => found[k] ?? []).map((id) => meshes.get(id)!.positions)
  /** 一组部件里满足条件的顶点上某个坐标的最大或最小值 / the largest or smallest value of one coordinate over the vertices of some parts that pass a test */
  const extreme = (keys: string[], axis: number, sign: 1 | -1, test: (x: number, y: number, z: number) => boolean): number => {
    let best = -Infinity
    for (const p of verts(keys)) for (let i = 0; i < p.length; i += 3) if (test(p[i]!, p[i + 1]!, p[i + 2]!) && sign * p[i + axis]! > best) best = sign * p[i + axis]!
    return sign * best
  }
  const bbox = (keys: string[]): number[] => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (const p of verts(keys)) for (let i = 0; i < p.length; i += 3) for (let q = 0; q < 3; q++) (b[q] = Math.min(b[q]!, p[i + q]!)), (b[q + 3] = Math.max(b[q + 3]!, p[i + q]!))
    return b
  }
  const bl = bbox(['lips']), bt = bbox(['tongue'])
  const midX = Number.isFinite(bl[0]!) ? (bl[0]! + bl[3]!) / 2 : (bt[0]! + bt[3]!) / 2
  // 口裂：上下唇之间 / the oral fissure: between the lips
  const lipIds = found.lips ?? []
  let lipY = (bl[1]! + bl[4]!) / 2
  if (lipIds.length === 2) {
    const a = bbox(['lips']).slice()
    const up = meshes.get(parts.find((p) => /^Upper lip$/.test(p.name) && lipIds.includes(p.id))!.id)!.positions
    let lo = Infinity
    for (let i = 1; i < up.length; i += 3) lo = Math.min(lo, up[i]!)
    const low = meshes.get(parts.find((p) => /^Lower lip$/.test(p.name) && lipIds.includes(p.id))!.id)!.positions
    let hi = -Infinity
    for (let i = 1; i < low.length; i += 3) hi = Math.max(hi, low[i]!)
    lipY = (lo + hi) / 2
    void a
  }
  const lipPoint: V3 = [midX, lipY, bl[5]! - 0.004]
  // 固有口腔：从切牙后面到舌背后部，每 4 mm 一个点 / oral cavity proper: from behind the incisors to the back of the dorsum, a point every 4 mm
  /** 一条射线打到一组部件里最近的距离 / the nearest hit of a ray among some parts */
  const cast = (keys: string[], o: V3, d: V3): number => {
    let best = Infinity
    for (const k of keys) for (const id of found[k] ?? []) best = Math.min(best, rayNearest(meshes.get(id)!, o, d).distance)
    return best
  }
  const zIncisor = extreme(['teeth'], 2, -1, (x, _y, z) => Math.abs(x - midX) < 0.006 && z > bt[2]! + 0.02)
  const zFront = Number.isFinite(zIncisor) ? zIncisor - 0.001 : bt[5]! - 0.004
  const zBack = bt[2]! + 0.008
  const oral: V3[] = [lipPoint]
  const gapRows: { zMm: number; tongueTopMm: number | null; palateMm: number | null; gapMm: number | null }[] = []
  let bounded = 0
  const nz = Math.max(2, Math.round((zFront - zBack) / 0.004))
  let lastY = lipY
  for (let i = 0; i <= nz; i++) {
    const z = zFront + ((zBack - zFront) * i) / nz
    // 舌背：从上方沿中线向下的射线打到舌的地方；腭：从舌背向上的射线打到上颌骨、腭骨或腭帆肌的地方
    // dorsum: where a ray down the midline from above meets the tongue; palate: where a ray up from the dorsum meets maxilla, palatine bone or a muscle of the soft palate
    const dT = cast(['tongue'], [midX, bt[4]! + 0.03, z], [0, -1, 0])
    const yT = Number.isFinite(dT) ? bt[4]! + 0.03 - dT : NaN
    const dP = Number.isFinite(yT) ? cast(['hardPalate', 'softPalateMuscles'], [midX, yT + 0.0003, z], [0, 1, 0]) : NaN
    const yP = Number.isFinite(dP) && dP < 0.03 ? yT + 0.0003 + dP : NaN
    let y: number
    if (Number.isFinite(yT) && Number.isFinite(yP) && yP > yT) (y = (yT + yP) / 2), bounded++
    else if (Number.isFinite(yT)) y = yT + 0.002
    else y = lastY
    lastY = y
    oral.push([midX, y, z])
    const r1 = (v: number): number => Math.round(v * 1e4) / 10
    gapRows.push({ zMm: r1(z), tongueTopMm: Number.isFinite(yT) ? r1(yT) : null, palateMm: Number.isFinite(yP) ? r1(yP) : null, gapMm: Number.isFinite(yT) && Number.isFinite(yP) ? r1(yP - yT) : null })
  }
  // 咽：自上而下每 5 mm 一个点，前后壁之间的中点 / pharynx: a point every 5 mm from above down, midway between the posterior and anterior walls
  const back = oral[oral.length - 1]!
  const pharynx: V3[] = [back]
  const yTop = back[1] - 0.006, yBot = oesIn[1] + 0.01
  const ny = Math.max(2, Math.round((yTop - yBot) / 0.005))
  const wallRows: { yMm: number; posteriorMm: number | null; anteriorMm: number | null; anteriorPart: string | null; depthMm: number | null }[] = []
  let lastZ = back[2]
  for (let i = 0; i <= ny; i++) {
    const y = yTop + ((yBot - yTop) * i) / ny
    // 后壁、前壁：从上一个点的前后位置出发，沿中线向后、向前的射线 / posterior and anterior walls: rays backward and forward along the midline from the depth of the point above
    const o: V3 = [midX, y, lastZ]
    const dPost = cast(['raphe', 'constrictors', 'palatopharyngeus', 'prevertebralMuscles', 'cervicalVertebrae'], o, [0, 0, -1])
    const zPost = Number.isFinite(dPost) && dPost < 0.03 ? lastZ - dPost : NaN
    let zAnt = Infinity, antPart: string | null = null
    for (const k of ['tongue', 'tongueMuscles', 'epiglottis', 'hyoid', 'laryngealCartilages', 'laryngealMuscles', 'softPalateMuscles']) {
      // 从后壁前面 1.5 mm 处向前：喉口以下，咽在喉的后面，前壁是杓状软骨和杓横肌，不是喉腔前面的甲状软骨
      // forward from 1.5 mm in front of the posterior wall: below the laryngeal inlet the pharynx lies behind the larynx and its anterior wall is the arytenoids and the transverse arytenoid, not the thyroid cartilage in front of the laryngeal cavity
      const from = Number.isFinite(zPost) ? zPost + 0.0015 : lastZ
      const d = cast([k], [midX, y, from], [0, 0, 1])
      if (from + d < zAnt) (zAnt = from + d), (antPart = k)
    }
    let z: number
    if (Number.isFinite(zPost) && Number.isFinite(zAnt) && zAnt - zPost < 0.03) z = (zPost + zAnt) / 2
    else if (Number.isFinite(zPost)) z = zPost + 0.006
    else z = lastZ
    lastZ = z
    pharynx.push([midX, y, z])
    const r1 = (v: number): number => Math.round(v * 1e4) / 10
    wallRows.push({ yMm: r1(y), posteriorMm: Number.isFinite(zPost) ? r1(zPost) : null, anteriorMm: Number.isFinite(zAnt) ? r1(zAnt) : null, anteriorPart: Number.isFinite(zAnt) ? antPart : null, depthMm: Number.isFinite(zPost) && Number.isFinite(zAnt) ? r1(zAnt - zPost) : null })
  }
  pharynx.push(oesIn)
  // 喉口 / the laryngeal inlet
  let inlet: V3 | null = null
  {
    const ep = verts(['epiglottis'])[0]
    const ary = (found.laryngealCartilages ?? []).filter((id) => /arytenoid/i.test(parts.find((p) => p.id === id)!.name)).map((id) => meshes.get(id)!.positions)
    if (ep && ary.length) {
      let top: V3 = [0, -Infinity, 0]
      for (let i = 0; i < ep.length; i += 3) if (ep[i + 1]! > top[1]) top = [ep[i]!, ep[i + 1]!, ep[i + 2]!]
      const tops: V3[] = ary.map((p) => {
        let t: V3 = [0, -Infinity, 0]
        for (let i = 0; i < p.length; i += 3) if (p[i + 1]! > t[1]) t = [p[i]!, p[i + 1]!, p[i + 2]!]
        return t
      })
      const a: V3 = [0, 0, 0]
      for (const t of tops) for (let q = 0; q < 3; q++) a[q] = a[q]! + t[q]! / tops.length
      inlet = [(top[0] + a[0]) / 2, (top[1] + a[1]) / 2, (top[2] + a[2]) / 2]
    }
  }
  // 腭帆（构造）：腭骨水平板的后缘（中线两侧各 16 mm，每 4 mm 取最靠后的顶点）连到悬雍垂肌最低的顶点；
  // 两侧再各连到腭帆提肌最低的顶点（它进入软腭的地方）。厚度在体素那一步给（假设值）。
  // The velum (construction): the posterior edge of the horizontal plates of the palatine bones (16 mm
  // either side of the midline, the hindmost vertex every 4 mm) joined to the lowest vertex of the
  // uvular muscle; on either side also to the lowest vertex of the levator veli palatini (where it
  // enters the soft palate). Its thickness is given at the voxel step (an assumption).
  let velum: Mesh | null = null
  const velumReport: Record<string, unknown> = { built: false }
  {
    const pal = (found.hardPalate ?? []).filter((id) => /palatine/i.test(parts.find((p) => p.id === id)!.name)).map((id) => meshes.get(id)!.positions)
    const uv = (found.softPalateMuscles ?? []).filter((id) => /uvular/i.test(parts.find((p) => p.id === id)!.name)).map((id) => meshes.get(id)!.positions)
    const lev = (found.softPalateMuscles ?? []).filter((id) => /levator/i.test(parts.find((p) => p.id === id)!.name)).map((id) => meshes.get(id)!.positions)
    const lowest = (ps: Float32Array[]): V3 | null => {
      let t: V3 | null = null
      for (const p of ps) for (let i = 0; i < p.length; i += 3) if (!t || p[i + 1]! < t[1]) t = [p[i]!, p[i + 1]!, p[i + 2]!]
      return t
    }
    const palLow = lowest(pal), tip = lowest(uv)
    if (palLow && tip) {
      const edge: V3[] = []
      for (let b = -4; b < 4; b++) {
        let best: V3 | null = null
        for (const p of pal) for (let i = 0; i < p.length; i += 3) {
          const dx = p[i]! - midX
          if (dx < b * 0.004 || dx >= (b + 1) * 0.004 || p[i + 1]! > palLow[1] + 0.005) continue
          if (!best || p[i + 2]! < best[2]) best = [p[i]!, p[i + 1]!, p[i + 2]!]
        }
        if (best) edge.push(best)
      }
      const row: V3[] = [...edge]
      const levLow = lev.map((p) => lowest([p])).filter((q): q is V3 => !!q).sort((a, b) => a[0] - b[0])
      if (levLow.length === 2) (row.unshift(levLow[0]!), row.push(levLow[1]!))
      if (row.length >= 3) {
        const positions: number[] = [...tip]
        const indices: number[] = []
        row.forEach((q) => positions.push(...q))
        for (let i = 0; i + 1 < row.length; i++) indices.push(0, i + 1, i + 2)
        velum = { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
        const r1 = (v: number): number => Math.round(v * 1e4) / 10
        Object.assign(velumReport, { built: true, construction: true, hardPalateEdgePoints: edge.length, levatorPoints: levLow.length, uvulaTipMm: tip.map(r1), triangles: indices.length / 3, note: 'no soft-palate part exists in this body; the sheet is constructed and labelled so' })
      }
    }
  }
  const ids = (keys: string[]): { id: string; mesh: Mesh }[] => [...new Set(keys.flatMap((k) => found[k] ?? []))].map((id) => ({ id, mesh: meshes.get(id)! }))
  return {
    oral, pharynx, oralBounds: ids(ORAL), pharynxBounds: ids(PHARYNX), laryngealInlet: inlet, velum,
    report: {
      partsFound: Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.length > 6 ? `${v.length} parts` : v])),
      notFound: Object.entries(found).filter(([, v]) => !v.length).map(([k]) => k),
      absentFromBothBodiesByName: ['soft palate (only muscles: uvular, levator and tensor veli palatini, palatopharyngeus)', 'hard palate as a part of its own (maxillae and palatine bones stand for it)', 'mucosa of mouth and pharynx', 'palatoglossus', 'cheek mucosa'],
      midlineXMm: Math.round(midX * 1e4) / 10,
      velum: velumReport,
      oral: { centrelinePoints: oral.length, stationsWithTongueBelowAndPalateAbove: bounded, of: nz + 1, tongueToPalateAlongMidline: gapRows },
      pharynx: { centrelinePoints: pharynx.length, walls: wallRows },
    },
  }
}
