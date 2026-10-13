// 器官体积：我们的部件（由 GLB 网格算）vs 已发表的人群统计（CT / MRI / 超声），按性别。
// Organ volumes: our parts (computed from the GLB meshes) against published population statistics (CT / MRI / ultrasound), by sex.
//
// 参照数字是论文里的汇总统计，直接写在这里，每条带出处、许可、人群和它在原文中的位置。不需要下载。
// The reference numbers are summary statistics from papers, written here with source, licence, population and where in the
// paper they stand. No download is needed.

import type { BodyId, Part } from '../../src/anatomy/types.ts'
import type { RawMesh } from '../rig/io.ts'
import { BODIES, type Bilingual, type Ours, type Verdict, count, loadOurs, r1, r2, writeTable } from './ours.ts'
import type { RefInfo } from './refs.ts'

// ── 体积 / volume ────────────────────────────────────────────────────────────────────────────

/** 带符号体积（毫升）；与 tools/pipeline/meshRepair.ts 的 signedVolume 同式。 Signed volume in mL; the same formula as signedVolume in tools/pipeline/meshRepair.ts. */
export function meshVolumeMl(m: RawMesh): number {
  const p = m.positions, x = m.indices
  let v = 0
  for (let t = 0; t < x.length; t += 3) {
    const a = 3 * x[t]!, b = 3 * x[t + 1]!, c = 3 * x[t + 2]!
    v += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)
  }
  return (v / 6) * 1e6
}

/**
 * 若干网格的并集体积（毫升），体素化求得：沿 z 方向对每个 (x, y) 列求与三角形的交点，按奇偶填充；一个体素被任何一个网格
 * 占据就算一次。用来避免互相包含或重叠的部件（脑的各部、肝段）被重复计算。体素边长按包围盒自动取（0.5–2 mm）。
 * Volume of the union of several meshes in mL, by voxelisation: for every (x, y) column the crossings with triangles along z
 * are found and filled by parity; a voxel counts once however many meshes hold it. This keeps nested or overlapping parts
 * (parts of the brain, liver segments) from being counted twice. The voxel edge follows the bounding box (0.5–2 mm).
 */
export function unionVolumeMl(meshes: RawMesh[]): { ml: number; voxelMm: number } {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const m of meshes) for (let i = 0; i < m.positions.length; i++) {
    const k = i % 3, v = m.positions[i]!
    if (v < lo[k]!) lo[k] = v
    if (v > hi[k]!) hi[k] = v
  }
  const ext = [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!]
  const h = Math.min(0.002, Math.max(0.0005, Math.cbrt(ext[0]! * ext[1]! * ext[2]!) / 110))
  const nx = Math.ceil(ext[0]! / h) + 1, ny = Math.ceil(ext[1]! / h) + 1, nz = Math.ceil(ext[2]! / h) + 1
  const grid = new Uint8Array(nx * ny * nz)
  for (const m of meshes) {
    const cols = new Map<number, number[]>()
    const p = m.positions, x = m.indices
    for (let t = 0; t < x.length; t += 3) {
      const a = 3 * x[t]!, b = 3 * x[t + 1]!, c = 3 * x[t + 2]!
      const ax = (p[a]! - lo[0]!) / h, ay = (p[a + 1]! - lo[1]!) / h, az = (p[a + 2]! - lo[2]!) / h
      const bx = (p[b]! - lo[0]!) / h, by = (p[b + 1]! - lo[1]!) / h, bz = (p[b + 2]! - lo[2]!) / h
      const cx = (p[c]! - lo[0]!) / h, cy = (p[c + 1]! - lo[1]!) / h, cz = (p[c + 2]! - lo[2]!) / h
      const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
      if (Math.abs(det) < 1e-12) continue
      const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5)), i1 = Math.min(nx - 1, Math.floor(Math.max(ax, bx, cx) - 0.5))
      const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5)), j1 = Math.min(ny - 1, Math.floor(Math.max(ay, by, cy) - 0.5))
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        // 列中心 (i + 0.5, j + 0.5) 的重心坐标；用半开区间避免共享边被算两次
        // barycentric coordinates of the column centre (i + 0.5, j + 0.5); half-open tests keep a shared edge from counting twice
        const px = i + 0.5, py = j + 0.5
        const u = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / det, v = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / det
        if (u < 0 || v < 0 || u + v >= 1) continue
        const z = az + u * (bz - az) + v * (cz - az)
        const key = i * ny + j
        const list = cols.get(key)
        if (list) list.push(z)
        else cols.set(key, [z])
      }
    }
    for (const [key, zs] of cols) {
      if (zs.length < 2) continue
      zs.sort((p1, p2) => p1 - p2)
      for (let k = 0; k + 1 < zs.length; k += 2) {
        const k0 = Math.max(0, Math.ceil(zs[k]! - 0.5)), k1 = Math.min(nz - 1, Math.floor(zs[k + 1]! - 0.5))
        for (let q = k0; q <= k1; q++) grid[key * nz + q] = 1
      }
    }
  }
  let n = 0
  for (let i = 0; i < grid.length; i++) n += grid[i]!
  return { ml: n * h * h * h * 1e6, voxelMm: h * 1000 }
}

// ── 我们的器官由哪些部件组成 / which parts make up each organ ────────────────────────────────

type Pick = (o: Ours) => Part[]

function under(o: Ours, tree: 'isa' | 'partOf', conceptName: RegExp): Part[] {
  const cs = o.body.data.trees[tree]
  const kids = new Map<string, string[]>()
  for (const c of cs) if (c.parent) kids.set(c.parent, [...(kids.get(c.parent) ?? []), c.id])
  const byId = new Map(cs.map((c) => [c.id, c]))
  const all = (id: string, depth = 0): string[] => (depth > 40 ? [] : [...(byId.get(id)?.parts ?? []), ...(kids.get(id) ?? []).flatMap((k) => all(k, depth + 1))])
  const ids = new Set(cs.filter((c) => conceptName.test(c.name)).flatMap((c) => all(c.id)))
  return [...ids].map((id) => o.body.byId.get(id)!).filter(Boolean)
}
const named = (re: RegExp): Pick => (o) => o.body.data.parts.filter((p) => re.test(p.name))

export const ORGANS: { id: string; name: Bilingual; pick: Pick; what: Bilingual }[] = [
  { id: 'liver', name: { zh: '肝', en: 'liver' }, pick: (o) => under(o, 'partOf', /^liver$/i).filter((p) => p.tissue === 'organ'), what: { zh: '结构树里“肝”之下 tissue 为 organ 的部件（肝段），不含单独建模的肝内血管', en: 'parts with tissue "organ" under "liver" in the part-of tree (the segments), without the separately modelled intrahepatic vessels' } },
  { id: 'spleen', name: { zh: '脾', en: 'spleen' }, pick: named(/^Spleen$/), what: { zh: '部件 Spleen', en: 'the part Spleen' } },
  { id: 'kidney_L', name: { zh: '左肾', en: 'left kidney' }, pick: named(/^Left kidney$/), what: { zh: '部件 Left kidney', en: 'the part Left kidney' } },
  { id: 'kidney_R', name: { zh: '右肾', en: 'right kidney' }, pick: named(/^Right kidney$/), what: { zh: '部件 Right kidney', en: 'the part Right kidney' } },
  { id: 'pancreas', name: { zh: '胰', en: 'pancreas' }, pick: named(/^Pancreas$/), what: { zh: '部件 Pancreas', en: 'the part Pancreas' } },
  { id: 'heart', name: { zh: '心（四腔加心肌，不含心外膜脂肪和大血管）', en: 'heart (four chambers with myocardium, without epicardial fat and great vessels)' }, pick: (o) => under(o, 'partOf', /^heart$/i).filter((p) => p.tissue === 'heart' || p.tissue === 'space'), what: { zh: '结构树里“心”之下 tissue 为 heart 或 space 的部件：心室壁、心房壁、乳头肌和四个腔', en: 'parts with tissue "heart" or "space" under "heart" in the part-of tree: ventricular and atrial walls, papillary muscles and the four cavities' } },
  { id: 'lung_L', name: { zh: '左肺', en: 'left lung' }, pick: (o) => under(o, 'partOf', /^left lung$/i).filter((p) => p.tissue === 'organ'), what: { zh: '结构树里“左肺”之下 tissue 为 organ 的部件（肺叶）', en: 'parts with tissue "organ" under "left lung" in the part-of tree (the lobes)' } },
  { id: 'lung_R', name: { zh: '右肺', en: 'right lung' }, pick: (o) => under(o, 'partOf', /^right lung$/i).filter((p) => p.tissue === 'organ'), what: { zh: '结构树里“右肺”之下 tissue 为 organ 的部件（肺叶）', en: 'parts with tissue "organ" under "right lung" in the part-of tree (the lobes)' } },
  { id: 'lungs', name: { zh: '两肺', en: 'both lungs' }, pick: (o) => under(o, 'partOf', /^(left|right) lung$/i).filter((p) => p.tissue === 'organ'), what: { zh: '左右肺之和', en: 'left plus right' } },
  { id: 'bladder', name: { zh: '膀胱', en: 'urinary bladder' }, pick: named(/^Urinary bladder$/), what: { zh: '部件 Urinary bladder（壁加腔的外轮廓）', en: 'the part Urinary bladder (outer contour of wall plus lumen)' } },
  { id: 'uterus', name: { zh: '子宫', en: 'uterus' }, pick: named(/^Uterus$/), what: { zh: '部件 Uterus', en: 'the part Uterus' } },
  { id: 'ovary_L', name: { zh: '左卵巢', en: 'left ovary' }, pick: named(/^Left ovary$/), what: { zh: '部件 Left ovary', en: 'the part Left ovary' } },
  { id: 'ovary_R', name: { zh: '右卵巢', en: 'right ovary' }, pick: named(/^Right ovary$/), what: { zh: '部件 Right ovary', en: 'the part Right ovary' } },
  { id: 'testis_L', name: { zh: '左睾丸', en: 'left testis' }, pick: named(/^Left testis$/), what: { zh: '部件 Left testis', en: 'the part Left testis' } },
  { id: 'testis_R', name: { zh: '右睾丸', en: 'right testis' }, pick: named(/^Right testis$/), what: { zh: '部件 Right testis', en: 'the part Right testis' } },
  { id: 'brain', name: { zh: '脑（灰质加白质，不含脑室）', en: 'brain (grey plus white matter, without ventricles)' }, pick: (o) => o.body.data.parts.filter((p) => p.tissue === 'brain' && !/ventricle|aqueduct|central canal|choroid plexus|spinal cord/i.test(p.name)), what: { zh: 'tissue 为 brain 的全部部件，去掉脑室、导水管、中央管、脉络丛和脊髓；取并集体积', en: 'every part with tissue "brain" except ventricles, aqueduct, central canal, choroid plexus and spinal cord; union volume' } },
  { id: 'thyroid', name: { zh: '甲状腺', en: 'thyroid gland' }, pick: named(/^Thyroid gland$/), what: { zh: '部件 Thyroid gland', en: 'the part Thyroid gland' } },
]

// ── 参照 / references ────────────────────────────────────────────────────────────────────────

const OPENED = '2026-10-13'
const src = (id: string, name: string, url: string, licence: string, clause: string, version: string): RefInfo => ({ id, name, version, url, licence, clause, opened: OPENED })

export const ORGAN_SOURCES: Record<string, RefInfo> = {
  kikuchi: src('kikuchi2026', 'Kikuchi et al. 2026, Jpn J Radiol, doi:10.1007/s11604-026-02028-z: organ volume distributions from abdominal CT in Japan (J-MID), TotalSegmentator v2.10.0 --fast', 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC13623781/fullTextXML', 'CC BY 4.0', 'Licence link in the article XML: creativecommons.org/licenses/by/4.0. Only percentiles from Tables 3 and 4 are used.', 'PMC13623781; 26,456 men (median age 71, height 1.67 m) and 23,308 women (median age 67, height 1.55 m), 20–89 y, routine clinical non-contrast CT, not healthy volunteers'),
  liu: src('liu2021', 'Liu et al. 2021, eLife 10:e65554: organ traits from abdominal MRI in UK Biobank', 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC8205492/fullTextXML', 'CC BY 4.0', 'Licence link in the article XML: creativecommons.org/licenses/by/4.0. Only means and SDs from Table 2 are used.', 'PMC8205492; about 38,900 participants, mean age 63.7 y, Dixon MRI in 17 s expiration breath-holds; values printed in litres to two digits'),
  bakker: src('bakker2025', 'Bakker et al. 2025, Eur Radiol: reference formulas for chest CT-derived lobar volumes in the lung-healthy general population (ImaLife / Lifelines)', 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC12021944/fullTextXML', 'CC BY 4.0', 'Licence link in the article XML: creativecommons.org/licenses/by/4.0. Only means and SDs of the cohort table are used.', 'PMC12021944; 3,183 men (61 y, 1.82 m) and 4,123 women (60 y, 1.68 m), low-dose chest CT at full inspiration'),
  sosnowski: src('sosnowski2025', 'Sosnowski et al. 2025, Diagnostics (Basel): fat-free total heart volume from non-contrast cardiac CT', 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC12192549/fullTextXML', 'CC BY 4.0', 'Licence link in the article XML: creativecommons.org/licenses/by/4.0. Only the mean and SD of the normal-BMI, low-risk subgroup are used.', 'PMC12192549; patients referred for calcium scoring (63 ± 11 y); subgroup with normal BMI and low risk: 285 women, 68 men; mid-diastolic sum of both atria and both ventricles with their walls'),
  ritchie: src('ritchie2018', 'Ritchie et al. 2018, Cereb Cortex 28:2959–2975: sex differences in the adult human brain, UK Biobank', 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=6041980', 'CC BY 4.0', 'Licence link in the article XML: creativecommons.org/licenses/by/4.0. Only means and SDs of total brain volume are used.', 'PMC6041980; 2,750 women and 2,466 men, 44–77 y, T1 MRI; total brain volume = grey + white matter'),
  lin: src('lin2023', 'Lin et al. 2023, Biol Trace Elem Res: reference intervals of adult thyroid volume in iodine-sufficient areas of China', 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC10620313/fullTextXML', 'CC BY 4.0', 'Licence link in the article XML: creativecommons.org/licenses/by/4.0. Only the median and the 2.5–97.5 % interval by sex are used.', 'PMC10620313; 36,197 reference adults (median age 37), ultrasound'),
  lotti: src('lotti2022', 'Lotti et al. 2022, Andrology: European Academy of Andrology ultrasound study on healthy, fertile men', 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC9828651/fullTextXML', 'CC BY-NC-ND 4.0', 'Licence link in the article XML: creativecommons.org/licenses/by-nc-nd/4.0. Only the mean, SD and reference range of testicular volume are quoted as facts; nothing of the article is reproduced.', 'PMC9828651; 248 healthy fertile men, multicentre Europe, ultrasound with the ellipsoid formula'),
  jabbar: src('jabbar2026', 'Jabbar et al. 2026, Front Med (Lausanne): sonographic normative range of uterine and ovarian dimensions among Indian women of reproductive age', 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC13422480/fullTextXML', 'CC BY 4.0', 'Licence link in the article XML: creativecommons.org/licenses/by/4.0. Only means and SDs are used.', 'PMC13422480; clinically and biochemically normal women aged 29.97 ± 6.44 y, transabdominal ultrasound n = 1,232'),
}

interface OrganRef {
  organ: string
  sex: BodyId
  source: keyof typeof ORGAN_SOURCES
  /** 中心值及其种类 / central value and its kind. */
  central: number
  centralKind: 'mean' | 'median'
  low: number
  high: number
  /** 容差带是怎么来的 / how the band was formed. */
  band: 'mean ± 2 SD' | 'p10–p90' | '2.5–97.5 % reference interval' | 'published reference range'
  /** 原文里的那一行或那一句 / the row or sentence in the paper. */
  quote: string
  content: Bilingual
}

const pct = (organ: string, sex: BodyId, p: [number, number, number, number, number], row: string): OrganRef => ({ organ, sex, source: 'kikuchi', central: p[2], centralKind: 'median', low: p[0], high: p[4], band: 'p10–p90', quote: `${row} (mL; p10 p25 p50 p75 p90): ${p.join(' ')}`, content: { zh: '分割掩膜的体积；原文没有说明肾窦和门部血管是否在内', en: 'volume of the segmentation mask; the paper does not say whether the renal sinus and hilar vessels are inside' } })
const msd = (organ: string, sex: BodyId, source: keyof typeof ORGAN_SOURCES, mean: number, sd: number, quote: string, content: Bilingual): OrganRef => ({ organ, sex, source, central: mean, centralKind: 'mean', low: Math.max(0, r1(mean - 2 * sd)), high: r1(mean + 2 * sd), band: 'mean ± 2 SD', quote, content })

const MRI: Bilingual = { zh: 'MRI 分割体积，原文以升为单位、两位有效数字', en: 'MRI segmentation volume, printed in litres to two digits' }
const INSP: Bilingual = { zh: '深吸气末 CT 的肺掩膜：气体、肺实质和肺内血管', en: 'lung mask on CT at full inspiration: air, parenchyma and intrapulmonary vessels' }
const EXP: Bilingual = { zh: '呼气末屏气 MRI 的两肺体积', en: 'both lungs on MRI in an expiration breath-hold' }
const HEART: Bilingual = { zh: '舒张中期两心房、两心室连同室壁的体积之和，不含心外膜脂肪', en: 'mid-diastolic sum of both atria and both ventricles with their walls, without epicardial fat' }
const US: Bilingual = { zh: '超声椭球公式的整器官体积', en: 'whole-organ volume by the ultrasound ellipsoid formula' }

export const ORGAN_REFS: OrganRef[] = [
  pct('liver', 'male', [893.3, 1024.4, 1194.7, 1411.4, 1667.2], 'Table 3, Liver (n = 26,456)'), pct('liver', 'female', [776.1, 886.0, 1024.0, 1203.9, 1439.9], 'Table 4, Liver (n = 23,308)'),
  msd('liver', 'male', 'liu', 1490, 300, 'Table 2: Liver | 1.38 (0.3) | 1.28 (0.25) | 1.49 (0.3) (L; combined | female | male)', MRI), msd('liver', 'female', 'liu', 1280, 250, 'Table 2: Liver | 1.38 (0.3) | 1.28 (0.25) | 1.49 (0.3) (L; combined | female | male)', MRI),
  pct('spleen', 'male', [58.6, 83.6, 118.7, 168.0, 234.8], 'Table 3, Spleen (n = 26,276)'), pct('spleen', 'female', [48.7, 67.8, 95.4, 134.3, 187.4], 'Table 4, Spleen (n = 23,202)'),
  msd('spleen', 'male', 'liu', 200, 78, 'Table 2: Spleen | 0.17 (0.072) | 0.14 (0.054) | 0.2 (0.078)', MRI), msd('spleen', 'female', 'liu', 140, 54, 'Table 2: Spleen | 0.17 (0.072) | 0.14 (0.054) | 0.2 (0.078)', MRI),
  pct('kidney_R', 'male', [89.7, 111.3, 134.1, 159.5, 188.1], 'Table 3, Kidney right (n = 25,963)'), pct('kidney_L', 'male', [89.7, 114.6, 139.0, 165.1, 193.0], 'Table 3, Kidney left (n = 25,889)'),
  pct('kidney_R', 'female', [75.0, 91.5, 109.1, 129.0, 151.8], 'Table 4, Kidney right'), pct('kidney_L', 'female', [76.5, 96.1, 115.1, 135.6, 158.5], 'Table 4, Kidney left'),
  pct('pancreas', 'male', [35.9, 49.2, 63.7, 78.6, 92.4], 'Table 3, Pancreas (n = 26,432)'), pct('pancreas', 'female', [28.2, 40.0, 52.3, 64.5, 75.8], 'Table 4, Pancreas (n = 23,266)'),
  msd('heart', 'male', 'sosnowski', 506.9, 89.5, 'BMI class 0, risk 0, M, N = 68: THV 506.9 ± 89.5 mL', HEART), msd('heart', 'female', 'sosnowski', 405.3, 73.0, 'BMI class 0, risk 0, F, N = 285: THV 405.3 ± 73.0 mL', HEART),
  msd('lungs', 'male', 'bakker', 6120, 1200, 'TLV (L) | 6.12 ± 1.20 | 4.71 ± 0.79 (men | women)', INSP), msd('lungs', 'female', 'bakker', 4710, 790, 'TLV (L) | 6.12 ± 1.20 | 4.71 ± 0.79 (men | women)', INSP),
  msd('lungs', 'male', 'liu', 3030, 750, 'Table 2: Lungs | 2.67 (0.73) | 2.32 (0.53) | 3.03 (0.75) (L; combined | female | male)', EXP), msd('lungs', 'female', 'liu', 2320, 530, 'Table 2: Lungs | 2.67 (0.73) | 2.32 (0.53) | 3.03 (0.75) (L; combined | female | male)', EXP),
  msd('brain', 'male', 'ritchie', 1233.58, 98.31, 'Total brain volume | 1115.76 (89.68) | 1233.58 (98.31) (cm³; female | male, M (SD))', { zh: 'T1 MRI 的灰质加白质体积，不含脑脊液', en: 'grey plus white matter on T1 MRI, without CSF' }), msd('brain', 'female', 'ritchie', 1115.76, 89.68, 'Total brain volume | 1115.76 (89.68) | 1233.58 (98.31) (cm³; female | male, M (SD))', { zh: 'T1 MRI 的灰质加白质体积，不含脑脊液', en: 'grey plus white matter on T1 MRI, without CSF' }),
  { organ: 'thyroid', sex: 'male', source: 'lin', central: 8.97, centralKind: 'median', low: 3.92, high: 19.06, band: '2.5–97.5 % reference interval', quote: 'Male: 2.5th 3.92, 50th 8.97, 97.5th 19.06 mL', content: US },
  { organ: 'thyroid', sex: 'female', source: 'lin', central: 7.38, centralKind: 'median', low: 3.1, high: 16.17, band: '2.5–97.5 % reference interval', quote: 'Female: 2.5th 3.10, 50th 7.38, 97.5th 16.17 mL', content: US },
  { organ: 'testis_R', sex: 'male', source: 'lotti', central: 17.9, centralKind: 'mean', low: 12.0, high: 25.7, band: 'published reference range', quote: 'Testicular volume (mL), ellipsoid formula: Right 17.9 ± 4.4, reference range 12.0–25.7', content: US },
  { organ: 'testis_L', sex: 'male', source: 'lotti', central: 16.5, centralKind: 'mean', low: 11.0, high: 24.1, band: 'published reference range', quote: 'Testicular volume (mL), ellipsoid formula: Left 16.5 ± 4.1, reference range 11.0–24.1', content: US },
  msd('uterus', 'female', 'jabbar', 61.61, 37.24, 'Table 4 (transabdominal, N = 1232): Uterine volume 61.61 ± 37.24, median 55.58, IQR 39.04–74.86', { zh: '超声椭球公式，含内膜和宫腔；育龄期', en: 'ultrasound ellipsoid, endometrium and cavity included; reproductive age' }),
  msd('ovary_R', 'female', 'jabbar', 7.26, 3.29, 'Ovarian volumes were 7.06 ± 3.44 cc (left) and 7.26 ± 3.29 cc (right) using transabdominal scans', { zh: '超声椭球公式，含卵泡；育龄期', en: 'ultrasound ellipsoid, follicles included; reproductive age' }),
  msd('ovary_L', 'female', 'jabbar', 7.06, 3.44, 'Ovarian volumes were 7.06 ± 3.44 cc (left) and 7.26 ± 3.29 cc (right) using transabdominal scans', { zh: '超声椭球公式，含卵泡；育龄期', en: 'ultrasound ellipsoid, follicles included; reproductive age' }),
]

export interface OrganRow {
  body: BodyId
  organ: string
  name: Bilingual
  parts: string[]
  /** 部件的来历（provenance / source 的并集）/ where the parts come from (union of provenance / source). */
  provenance: string
  ourWhat: Bilingual
  /** 并集体积（毫升）及体素边长；sumMl 是各部件带符号体积之和 / union volume in mL with its voxel edge; sumMl is the sum of the parts' signed volumes. */
  oursMl: number
  voxelMm: number
  sumMl: number
  source: string
  refCentralMl: number | null
  refKind: string
  refLowMl: number | null
  refHighMl: number | null
  band: string
  refContent: Bilingual
  quote: string
  diffMl: number | null
  /** 我们 / 参照中心值 / ours over the reference central value. */
  ratio: number | null
  verdict: Verdict
  note?: Bilingual
}

export const NO_REFERENCE: Record<string, Bilingual> = {
  bladder: { zh: '膀胱没有固定的解剖体积：公开来源只有功能性的容量（排尿量、最大排尿量、残余尿），取决于充盈状态。只报告我们的值。', en: 'The bladder has no fixed anatomical volume: open sources give functional volumes only (voided volume, maximum voided volume, residual), which depend on filling. Our value is reported without a verdict.' },
  lung_L: { zh: '打开的来源按肺叶给出均值和标准差，没有按整侧肺给出标准差；左右肺之和见 lungs 行。', en: 'The opened source gives mean and SD per lobe, not per whole lung; the two lungs together are in the "lungs" row.' },
  lung_R: { zh: '同上。', en: 'As above.' },
}

export async function organRows(): Promise<OrganRow[]> {
  const rows: OrganRow[] = []
  for (const id of BODIES) {
    const o = await loadOurs(id)
    for (const organ of ORGANS) {
      const parts = organ.pick(o).filter((p) => o.body.meshes.has(p.id))
      if (!parts.length) continue
      const meshes = parts.map((p) => o.body.meshes.get(p.id)!)
      const u = unionVolumeMl(meshes)
      const sum = meshes.reduce((s, m) => s + Math.abs(meshVolumeMl(m)), 0)
      const base = { body: id, organ: organ.id, name: organ.name, parts: parts.map((p) => p.id), provenance: [...new Set(parts.map((p) => `${p.provenance}${p.source ? ` (${p.source})` : ''}`))].join('; '), ourWhat: organ.what, oursMl: r1(u.ml), voxelMm: r2(u.voxelMm), sumMl: r1(sum) }
      const refs = ORGAN_REFS.filter((r) => r.organ === organ.id && r.sex === id)
      if (!refs.length) {
        rows.push({ ...base, source: '', refCentralMl: null, refKind: '', refLowMl: null, refHighMl: null, band: '', refContent: { zh: '', en: '' }, quote: '', diffMl: null, ratio: null, verdict: 'not comparable', note: NO_REFERENCE[organ.id] ?? { zh: '没有找到公开来源的参照值。', en: 'No reference value was found in an open source.' } })
        continue
      }
      for (const r of refs) rows.push({ ...base, source: ORGAN_SOURCES[r.source]!.id, refCentralMl: r.central, refKind: r.centralKind, refLowMl: r.low, refHighMl: r.high, band: r.band, refContent: r.content, quote: r.quote, diffMl: r1(u.ml - r.central), ratio: r2(u.ml / r.central), verdict: u.ml >= r.low && u.ml <= r.high ? 'within' : 'outside' })
    }
  }
  return rows
}

export async function runOrgans(log: (m: string) => void): Promise<void> {
  const rows = await organRows()
  const ours = await Promise.all(BODIES.map(loadOurs))
  writeTable<OrganRow>({
    schema: 1, id: 'organ-volumes', title: { zh: '器官体积：我们的部件 vs 已发表的人群统计', en: 'Organ volumes: our parts vs published population statistics' },
    method: {
      zh: '我们的体积由 GLB 网格算：把组成该器官的部件体素化（边长 0.5–2 mm）取并集，避免嵌套或重叠的部件重复计数；sumMl 是各部件带符号体积之和，两者相差大说明部件互相重叠。每个器官由哪些部件组成见 ourWhat。参照是各论文表里的汇总统计（均值和标准差，或百分位数），按性别。',
      en: 'Our volume is computed from the GLB meshes: the parts that make up the organ are voxelised (edge 0.5–2 mm) and their union is taken, so that nested or overlapping parts are not counted twice; sumMl is the sum of the parts\' signed volumes, and a large gap between the two means that parts overlap. Which parts make up each organ is in ourWhat. The references are summary statistics from tables of papers (mean and SD, or percentiles), by sex.',
    },
    tolerance: {
      zh: '落在参照的区间内记 within。区间取该来源能给出的：均值 ± 2 SD、p10–p90（比 ±2 SD 窄）、2.5–97.5% 参考区间或原文的参考范围；每行的 band 写明是哪一种。',
      en: 'Inside the reference band counts as within. The band is whatever the source provides: mean ± 2 SD, p10–p90 (narrower than ± 2 SD), a 2.5–97.5 % reference interval or the paper\'s reference range; `band` says which on every row.',
    },
    references: Object.values(ORGAN_SOURCES), ourState: Object.fromEntries(ours.map((o) => [o.id, o.state])),
    notes: [
      { zh: '偏离能说明什么、不能说明什么。男性是一位被扫描的男性（BodyParts3D；肺叶来自 3.0 版并经过配准变形）：一个器官落在区间外，可能是他本人如此、可能是分割的边界与参照不同（例如是否含血管、腔、脂肪）、也可能是我们的管线改变了它；单凭这张表分不出来。女性是拼合体：腹部器官来自 Visible Human 女性供体（59 岁、肥胖）并按身高缩放过，心、肺、脑、肝、甲状腺是男性结构配准变形来的，子宫和卵巢来自另一位女性的标本并放大过；所以她的偏离首先反映的是“缩放和配准”，不是某个人的解剖。', en: 'What a deviation can and cannot mean. The male is one scanned man (BodyParts3D; the lung lobes come from release 3.0 and were warped into place): an organ outside the band may be how he is, may reflect a segmentation boundary unlike the reference\'s (vessels, lumen or fat included or not), or may be something our pipeline changed; this table alone cannot tell which. The female is a composite: abdominal organs from the Visible Human Female donor (59 years old, obese) rescaled for stature, heart, lungs, brain, liver and thyroid warped from the male, uterus and ovaries from another woman\'s specimen and enlarged; her deviations therefore reflect scaling and registration first, not one person\'s anatomy.' },
      { zh: '参照人群与我们的身体不匹配：日本 CT 队列年长（中位 67–71 岁）且身材小（男 1.67 m、女 1.55 m），是临床常规检查而非健康志愿者；UK Biobank 的肝、脾明显大于日本队列（体型、年龄、成像方式都不同）。肺：参照有深吸气 CT 和呼气末 MRI 两种状态，我们的肺所处的充气状态没有记录。心：参照是转诊做钙化积分的患者中 BMI 正常、低风险的亚组。子宫和卵巢的参照是育龄期；我们女性的骨架来自 59 岁的供体，但盆腔器官来自另一位女性（年龄未在本项目的说明里给出）。', en: 'The reference populations do not match our bodies: the Japanese CT cohort is old (median 67–71 years) and small (men 1.67 m, women 1.55 m) and consists of routine clinical scans, not healthy volunteers; UK Biobank livers and spleens are clearly larger than the Japanese ones (build, age and modality all differ). Lungs: the references cover two states, inspiratory CT and end-expiratory MRI, and the inflation state of our lungs is not recorded. Heart: the reference is the normal-BMI, low-risk subgroup of patients referred for calcium scoring. Uterus and ovaries: the references are for reproductive age; our female\'s skeleton comes from a 59-year-old donor but her pelvic organs from another woman (whose age this project\'s notes do not give).' },
      { zh: '参照数字由一个检索子代理打开原文取得；本表用到的每个数字之后又由本工具的作者在原文 XML 里逐一核对过（2026-10-13）。', en: 'The reference numbers were obtained by a research sub-agent that opened the papers; every number used in this table was then checked again in the article XML by the author of this tool (2026-10-13).' },
    ],
    summary: { rows: rows.length, within: count(rows, (r) => r.verdict === 'within'), outside: count(rows, (r) => r.verdict === 'outside'), notComparable: count(rows, (r) => r.verdict === 'not comparable') },
    rows,
  })
  log(`organ-volumes: ${rows.length} rows`)
}
