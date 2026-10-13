// 薄结构（筋膜、浅血管、皮神经、淋巴结等）露在皮肤外多少：按三角形面积采样，逐点判断内外，逐部件报告露出的面积。
//
// 为什么另写一个量法（原先的是 skinPackage.ts 的 notFittedAgainstSkin）：原先的量法内外判断并没有错，错在报的量——
//   · 报的是“露出的采样点占全部薄结构表面的比例”：一张从小腿包到足尖的筋膜只有趾蹼处的一小片在外，摊到整张上不到 1 %；
//   · 报的是“到最近皮肤的距离”：趾与趾之间、两腿之间的缝很窄，缝里的点离旁边的皮肤总是只有几毫米，尽管整片横在缝里、一眼可见；
//   · worst 按比例排序、只取前十，大部件排不进去。
// 所以这里报面积（cm²）、露出部分的包围盒和按身体区域的分布，按露出面积排序；距离只作参考。
// 内外的判断：沿三个坐标轴各作一次射线奇偶，取多数（一条射线擦过边或穿过非流形处时另两条纠正它）。
//
// How far thin structures (fasciae, superficial vessels, cutaneous nerves, lymph nodes …) lie outside the
// skin: sampled over triangle AREA, each sample tested for inside/outside, and reported per part as area.
//
// Why a second measure (the first is notFittedAgainstSkin in skinPackage.ts): its inside test was not
// wrong; what it reports hides the defect —
//   · it reports the share of samples outside over ALL thin-structure surface: a fascia wrapping the leg
//     down to the toe tips has only its small web-space pieces outside, well under 1 % of the sheet;
//   · it reports the distance to the nearest skin: in the narrow gaps between the toes and between the
//     thighs every point is within a few millimetres of the skin beside it, although the sheet lies
//     across the gap in plain sight;
//   · `worst` is ranked by share and cut at ten, so large parts never make the list.
// Here the figures are area (cm²), the bounding box of what is outside and its distribution over body
// regions, ranked by area outside; the distance is given for reference only.
// Inside/outside: ray parity along each of the three axes, majority vote (a ray grazing an edge or
// passing a non-manifold spot is outvoted by the other two).

import type { Mesh } from './geometry.ts'
import { InsideTester } from './register.ts'
import { SurfaceDistance } from './skinPackage.ts'

/** 三个方向的射线奇偶，取多数 / ray parity along three axes, majority vote */
export class RobustInside {
  private readonly t: [InsideTester, InsideTester, InsideTester]
  constructor(skin: Mesh, resolution = 256) {
    const p = skin.positions
    // InsideTester 沿 +Y 作射线；把坐标轮换一下就得到沿 +Z、+X 的 / InsideTester casts along +Y; rotating the coordinates gives +Z and +X
    const rot = (k: number): Mesh => {
      const q = new Float32Array(p.length)
      for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) q[i + c] = p[i + ((c + k) % 3)]!
      return { positions: q, indices: skin.indices }
    }
    this.t = [new InsideTester(skin, resolution), new InsideTester(rot(1), resolution), new InsideTester(rot(2), resolution)]
  }
  contains(x: number, y: number, z: number): boolean {
    const a = this.t[0].contains(x, y, z) ? 1 : 0
    const b = this.t[1].contains(y, z, x) ? 1 : 0
    const c = this.t[2].contains(z, x, y) ? 1 : 0
    return a + b + c >= 2
  }
  /** 三条射线是否一致（不一致的点数用来说明皮肤网格的毛病） / whether the three rays agree (the count of disagreements tells about faults of the skin mesh) */
  agrees(x: number, y: number, z: number): boolean {
    const a = this.t[0].contains(x, y, z)
    return a === this.t[1].contains(y, z, x) && a === this.t[2].contains(z, x, y)
  }
}

export interface ThinOutsideRow {
  id: string
  name: string
  tissue: string
  /** 部件的表面积，cm² / surface area of the part, cm² */
  areaCm2: number
  /** 在皮肤外的面积，cm²；其中离皮肤超过 1 mm 的 / area outside the skin, cm²; and of that, more than 1 mm from it */
  outsideCm2: number
  outsideOver1mmCm2: number
  /** 露出部分到最近皮肤的最大距离，mm（窄缝里总是很小，仅供参考） / largest distance of the outside part to the nearest skin, mm (always small in a narrow gap; for reference) */
  maxMm: number
  /** 露出部分的包围盒（米） / bounding box of the outside part (metres) */
  outsideBbox: [number, number, number, number, number, number]
  /** 按区域的露出面积，cm² / area outside by region, cm² */
  byRegion: Record<string, number>
}

export interface ThinOutside {
  spacingM: number
  parts: number
  samples: number
  /** 三条射线不一致的采样点数 / samples on which the three rays disagreed */
  raysDisagreed: number
  totalAreaCm2: number
  outsideCm2: number
  outsideOver1mmCm2: number
  byRegion: Record<string, number>
  /** 露出面积不少于 minRowCm2 的部件，按露出面积从大到小 / parts with at least minRowCm2 outside, largest first */
  rows: ThinOutsideRow[]
}

/** 确定的低差异序列（Halton 2、3），不用随机数，保证构建可重复 / a deterministic low-discrepancy sequence (Halton 2, 3): no random numbers, so builds repeat */
function halton(i: number, base: number): number {
  let f = 1
  let r = 0
  let n = i
  while (n > 0) {
    f /= base
    r += f * (n % base)
    n = Math.floor(n / base)
  }
  return r
}

/**
 * @param skin    闭合的皮肤 / the closed skin
 * @param parts   要量的薄结构 / the thin structures to measure
 * @param region  把一个点归到身体区域的函数（可选） / maps a point to a body region (optional)
 * @param spacing 采样间距：每个三角形至少一个点，面积大的约每 spacing² 一个 / sample spacing: at least one sample per triangle, about one per spacing² on large ones
 */
export function thinStructuresOutsideSkin(skin: Mesh, parts: { id: string; name: string; tissue: string; mesh: Mesh }[], region?: (x: number, y: number, z: number) => string, spacing = 0.002, minRowCm2 = 0.5): ThinOutside {
  const inside = new RobustInside(skin)
  const surface = new SurfaceDistance(skin)
  const r2 = (v: number) => Math.round(v * 100) / 100
  const out: ThinOutside = { spacingM: spacing, parts: parts.length, samples: 0, raysDisagreed: 0, totalAreaCm2: 0, outsideCm2: 0, outsideOver1mmCm2: 0, byRegion: {}, rows: [] }
  const total: Record<string, number> = {}
  let sumArea = 0, sumOut = 0, sumOut1 = 0
  for (const part of parts) {
    const p = part.mesh.positions
    const I = part.mesh.indices
    let area = 0, outArea = 0, out1 = 0, far = 0
    const bb: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    const reg: Record<string, number> = {}
    let seq = 1
    for (let t = 0; t < I.length; t += 3) {
      const a = 3 * I[t]!, b = 3 * I[t + 1]!, c = 3 * I[t + 2]!
      const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!
      const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!
      const A = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
      if (!(A > 0)) continue
      area += A
      const n = Math.max(1, Math.ceil(A / (spacing * spacing)))
      const w = A / n
      for (let k = 0; k < n; k++) {
        let s = halton(seq, 2), q = halton(seq, 3)
        seq++
        if (s + q > 1) {
          s = 1 - s
          q = 1 - q
        }
        const x = p[a]! + s * ux + q * vx, y = p[a + 1]! + s * uy + q * vy, z = p[a + 2]! + s * uz + q * vz
        out.samples++
        if (!inside.agrees(x, y, z)) out.raysDisagreed++
        if (inside.contains(x, y, z)) continue
        outArea += w
        const d = surface.distance(x, y, z, 0.1)
        if (d > 0.001) out1 += w
        if (d > far) far = d
        if (x < bb[0]) bb[0] = x
        if (y < bb[1]) bb[1] = y
        if (z < bb[2]) bb[2] = z
        if (x > bb[3]) bb[3] = x
        if (y > bb[4]) bb[4] = y
        if (z > bb[5]) bb[5] = z
        if (region) {
          const g = region(x, y, z)
          reg[g] = (reg[g] ?? 0) + w
        }
      }
    }
    sumArea += area
    sumOut += outArea
    sumOut1 += out1
    for (const [g, v] of Object.entries(reg)) total[g] = (total[g] ?? 0) + v
    if (outArea * 1e4 >= minRowCm2) out.rows.push({ id: part.id, name: part.name, tissue: part.tissue, areaCm2: r2(area * 1e4), outsideCm2: r2(outArea * 1e4), outsideOver1mmCm2: r2(out1 * 1e4), maxMm: Math.round(far * 1e4) / 10, outsideBbox: bb.map((v) => Math.round(v * 1000) / 1000) as ThinOutsideRow['outsideBbox'], byRegion: Object.fromEntries(Object.entries(reg).sort((x, y) => y[1] - x[1]).map(([g, v]) => [g, r2(v * 1e4)])) })
  }
  out.rows.sort((x, y) => y.outsideCm2 - x.outsideCm2 || (x.id < y.id ? -1 : 1))
  out.totalAreaCm2 = r2(sumArea * 1e4)
  out.outsideCm2 = r2(sumOut * 1e4)
  out.outsideOver1mmCm2 = r2(sumOut1 * 1e4)
  out.byRegion = Object.fromEntries(Object.entries(total).sort((x, y) => y[1] - x[1]).map(([g, v]) => [g, r2(v * 1e4)]))
  return out
}

/**
 * 报告用的身体区域：前足（最低 7 cm、最靠前 9 cm）、大腿根（中线两侧 9 cm、髋骨最低点上下 12 cm）、头（最高 25 cm）、其余。
 * 只是为了说清楚露出的面积在哪里，不是解剖分区。
 * Body regions for the report: forefoot (lowest 7 cm, most anterior 9 cm), thigh root (within 9 cm of the
 * midline and 12 cm of the lowest point of the hip bones), head (top 25 cm), other. They only say where
 * the area outside lies; they are not anatomical regions.
 * @param skinBbox 皮肤的包围盒 / bounding box of the skin
 * @param hipLowY  髋骨最低点的高度 / height of the lowest point of the hip bones
 */
export function thinOutsideRegion(skinBbox: readonly number[], hipLowY: number): (x: number, y: number, z: number) => string {
  return (x, y, z) => (y < skinBbox[1]! + 0.07 && z > skinBbox[5]! - 0.09 ? 'forefoot' : Math.abs(x) < 0.09 && Math.abs(y - hipLowY) < 0.12 ? 'thighRoot' : y > skinBbox[4]! - 0.25 ? 'head' : 'other')
}
