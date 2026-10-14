// 入口：bun tools/look/calibration.ts — 写实外观的标定对照表：皮肤颜色、皮肤细节、毛发、眼。
// Entry point: bun tools/look/calibration.ts — calibration tables of the lifelike look: skin colour, skin detail, hair, eyes.
//
// 读已经生成的数据（不重新生成任何东西）：data/curated/look/skin-colour.json、public/anatomy/<body>/look/*、
// tools/look/micro.ts 的生成参数、public/anatomy/<body>/hair/hair.json 与 data/curated/hair/hair.json、扫描的眼球（nervous.glb）
// 和表情数据。写到 data/curated/calibration/skin-colour.json、skin-detail.json、look-hair.json、look-eyes.json，格式与
// tools/calibrate/ 的十张表相同。皮肤重新发布后重跑即可；结果是确定的。
// Reads data already built (nothing is regenerated): data/curated/look/skin-colour.json, public/anatomy/<body>/look/*, the
// generator settings of tools/look/micro.ts, public/anatomy/<body>/hair/hair.json and data/curated/hair/hair.json, the scanned
// eyeballs (nervous.glb) and the expression data. Writes data/curated/calibration/skin-colour.json, skin-detail.json,
// look-hair.json and look-eyes.json in the format of the ten tables of tools/calibrate/. Rerun it after the skins are
// re-issued; the result is deterministic.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AnatomyData } from '../../src/anatomy/types.ts'
import { applyLidDrop, lidGains, lidGazeChannels } from '../../src/face/driver.ts'
import type { FaceData, FaceOpenings } from '../../src/face/types.ts'
import { EYE, eyeShape, fitEye } from '../../src/look/eyesFit.ts'
import { lookupLut, toneMelanin } from '../../src/look/skinMaterial.ts'
import type { SkinColourData } from '../../src/look/types.ts'
import { displacePart, indexFace } from '../../src/pain/face.ts'
import type { Bilingual, Table } from '../calibrate/ours.ts'
import type { RefInfo } from '../calibrate/refs.ts'
import { readGlbParts } from '../skinmaps/io.ts'
import { buildMicro, TILE_MM } from './micro.ts'

const ROOT = join(import.meta.dirname, '..', '..')
export const OUT = join(ROOT, 'data', 'curated', 'calibration')
export const LOOK_TABLES = ['skin-colour', 'skin-detail', 'look-hair', 'look-eyes'] as const
const BODIES = ['male', 'female'] as const

const r1 = (x: number): number => Math.round(x * 10) / 10
const r2 = (x: number): number => Math.round(x * 100) / 100
const r3 = (x: number): number => Math.round(x * 1000) / 1000
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)
const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as T
const B = (zh: string, en: string): Bilingual => ({ zh, en })

type Verdict = 'within' | 'outside' | 'not comparable'
const judge = (diff: number, tolerance: number): Verdict => (Math.abs(diff) <= tolerance ? 'within' : 'outside')

function summarise<R extends { verdict: Verdict }>(rows: R[]): Record<string, number> {
  const c = (v: Verdict) => rows.filter((r) => r.verdict === v).length
  return { rows: rows.length, within: c('within'), outside: c('outside'), notComparable: c('not comparable') }
}

/** 文献在 Europe PMC 记录里的许可（2026-10-15 查）/ an article's licence in its Europe PMC record (checked 2026-10-15) */
const epmc = (licence: string, what: string): Pick<RefInfo, 'licence' | 'clause' | 'opened'> => ({
  licence,
  clause: `Licence field of the Europe PMC record ("${licence.toLowerCase()}"). ${what}`,
  opened: '2026-10-15',
})
const notChecked = (what: string, opened = '2026-10-15'): Pick<RefInfo, 'licence' | 'clause' | 'opened'> => ({
  licence: 'Not checked; no open licence is assumed',
  clause: `No licence grant is relied on. ${what}`,
  opened,
})

// ── 1. 皮肤颜色 / skin colour ──────────────────────────────────────────────────────────────────────
interface CuratedColour {
  calibration: { lutDE2000: { tolerance: number } }
  colorimetry: { rgbToXyz: number[][]; whiteXyz: number[] }
  subjects: { subject: number; cm: number; chd: number; lab: number[]; ita: number; spectralRms: number; dE2000: number; lutDE2000: number; repeatDE2000: number }[]
  regionFits: Record<string, Record<string, { melanin: number; blood: number; dE2000: number }>>
  regions: Record<string, { melanin?: number; blood?: number; fit?: { vermilion?: { dE2000: number } }; palmMelanin?: number }>
}

const ITA_GROUPS: [string, number, number][] = [['very light', 55, 90], ['light', 41, 55], ['intermediate', 28, 41], ['tan', 10, 28], ['brown', -30, 10], ['dark', -90, -30]]
const itaGroup = (ita: number): string => ITA_GROUPS.find(([, lo, hi]) => ita >= lo && ita < hi)?.[0] ?? 'out of range'

function xyzToLab(xyz: number[], white: number[]): [number, number, number] {
  const f = (t: number): number => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29)
  const [fx, fy, fz] = [0, 1, 2].map((i) => f(xyz[i]! / white[i]!)) as [number, number, number]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export function skinColourTable(): Table<Record<string, unknown>> {
  const cur = readJson<CuratedColour>('data/curated/look/skin-colour.json')
  const meta = readJson<SkinColourData>('public/anatomy/male/look/skin-colour.json')
  const TOL = 3
  const rows: Record<string, unknown>[] = []
  for (const s of cur.subjects) {
    rows.push({
      item: `NIST subject ${s.subject}`,
      kind: `ITA° ${itaGroup(s.ita)}`,
      quantity: 'model vs measured colour (D65, 2°)',
      ita: s.ita,
      diff: s.dE2000,
      tolerance: TOL,
      unit: 'ΔE00',
      spectralRms400to700: s.spectralRms,
      lutDE2000: s.lutDE2000,
      repeatScanDE2000: s.repeatDE2000,
      source: 'nist-skin',
      verdict: judge(s.dE2000, TOL),
    })
  }
  const SITE: Record<string, Bilingual> = { forehead: B('额头', 'forehead'), cheek: B('颊部', 'cheek'), backOfHand: B('手背', 'back of hand') }
  for (const [group, sites] of Object.entries(cur.regionFits)) {
    for (const [site, v] of Object.entries(sites)) {
      rows.push({
        region: site,
        name: SITE[site] ?? B(site, site),
        kind: group,
        quantity: 'residual after inverting the published site-minus-inner-arm CIELAB difference',
        diff: v.dE2000,
        tolerance: TOL,
        unit: 'ΔE00',
        melaninMultiplier: v.melanin,
        bloodMultiplier: v.blood,
        source: 'xiao2017',
        verdict: judge(v.dE2000, TOL),
        note: site === 'backOfHand' ? undefined : B('黑色素倍数固定为 1（假设），只反推血量', 'melanin multiplier held at 1 (assumed); only blood is inverted'),
      })
    }
  }
  const verm = cur.regions.lips?.fit?.vermilion?.dE2000
  if (typeof verm === 'number') {
    rows.push({
      region: 'vermilion',
      name: B('唇红', 'vermilion'),
      quantity: 'residual after inverting the published vermilion-minus-cheek CIELAB difference',
      diff: verm,
      tolerance: TOL,
      unit: 'ΔE00',
      melaninMultiplier: cur.regions.lips?.melanin,
      bloodMultiplier: cur.regions.lips?.blood,
      source: 'vermilion2018',
      verdict: judge(verm, TOL),
      note: B('唇红有自己的等效表皮厚度（与血量一起反推）；黑色素取颊部的 0.7 是假设', "the vermilion has its own effective epidermis thickness (inverted with the blood); melanin at 0.7 of the cheek's is assumed"),
    })
  }
  // 手掌：表里的颜色（黑色素取手掌的固定值，血量 NIST 中位数 × 1.2）的 L* / palm: L* of the table's colour (melanin at the palm's fixed value, blood the NIST median × 1.2)
  const palmCm = cur.regions.palmsSoles?.palmMelanin
  if (typeof palmCm === 'number') {
    const lutBin = readFileSync(join(ROOT, 'public/anatomy/male/look', meta.lut.file))
    const lut = new Uint16Array(lutBin.buffer.slice(lutBin.byteOffset, lutBin.byteOffset + lutBin.byteLength))
    const rgb = lookupLut(lut, meta.lut.size, meta.lut.cmMax, meta.lut.chdMax, palmCm, meta.tone.bloodChd * (cur.regions.palmsSoles?.blood ?? 1)).map((v) => v + meta.surfaceReflection)
    const M = cur.colorimetry.rgbToXyz
    const L = xyzToLab(M.map((row) => row[0]! * rgb[0]! + row[1]! * rgb[1]! + row[2]! * rgb[2]!), cur.colorimetry.whiteXyz)[0]
    rows.push({
      region: 'palm',
      name: B('手掌', 'palm'),
      quantity: 'L* of the palm colour',
      ours: r1(L),
      ref: 60.8,
      diff: r1(L - 60.8),
      tolerance: 4.6,
      unit: 'L*',
      source: 'phan2022',
      verdict: judge(L - 60.8, 4.6),
      note: B('手掌的黑色素正是按这个 L* 定的，差主要来自查表的插值；容差取文献的 1 SD（4.6）', "the palm melanin was set from this very L*, so the difference is mostly the table's interpolation; the tolerance is the paper's 1 SD (4.6)"),
    })
  }
  return {
    schema: 1,
    id: 'skin-colour',
    title: B('写实皮肤的颜色：光谱模型 vs NIST 皮肤反射光谱和部位色度', "Lifelike skin colour: the spectral model vs NIST skin reflectance and regional colorimetry"),
    method: B(
      '前 100 行：两层皮肤光谱模型（tools/look/skin_colour.py）对 NIST 人体皮肤反射参考数据逐人拟合（每人只拟合黑色素和真皮血量），模型反射率与实测反射率换成 D65、CIE 1931 2° 下的 CIELAB 后的色差 ΔE00；同列给出 400–700 nm 的光谱 RMS、查表后的色差和同一人三次扫描之间的色差（测量本身的噪声）。其后几行：把文献里"该部位 − 参照部位"的 CIELAB 差加到 NIST 中位数的颜色上，用同一模型反推黑色素和血量倍数后剩下的色差；手掌一行是查找表给出的手掌颜色的 L*。数据来自 data/curated/look/skin-colour.json。',
      'The first 100 rows: the two-layer spectral skin model (tools/look/skin_colour.py) fitted to each subject of the NIST reference data set of human skin reflectance (only melanin and dermal blood per subject); the colour difference ΔE00 between model and measured reflectance as CIELAB under D65 and CIE 1931 2°. Alongside: the spectral RMS over 400–700 nm, the difference through the lookup table, and the difference between the subject\'s own three scans (the noise of the measurement). The rows after that: the published CIELAB difference "site − reference site" added to the colour of the NIST median and inverted with the same model into melanin and blood multipliers, and the colour difference left over; the palm row is L* of the palm colour from the lookup table. Data from data/curated/look/skin-colour.json.',
    ),
    tolerance: B('ΔE00 ≤ 3 记 within（约为同一人重复测量差的最大值，见 repeatScanDE2000）；手掌按文献的 1 SD（4.6 L*）。', 'ΔE00 ≤ 3 counts as within (about the largest difference between one subject\'s repeated scans, see repeatScanDE2000); the palm uses the paper\'s 1 SD (4.6 L*).'),
    references: [
      {
        id: 'nist-skin',
        name: 'NIST Reference Data Set of Human Skin Reflectance (Cooksey, Allen & Tsai 2017, J Res NIST 122:26, doi:10.6028/jres.122.026)',
        version: 'data file "1832_Data_JResNIST_skinrefl v3.txt" (sha256 ce9aac735d9d…); 100 subjects, inner right forearm, 8°/hemispherical reflectance factor, 250–2500 nm',
        url: 'https://doi.org/10.18434/M38597',
        licence: 'NIST data licence: works of NIST employees are not subject to copyright in the US; NIST must be acknowledged as the source',
        clause: 'www.nist.gov/open/license: "explicitly acknowledge the National Institute of Standards and Technology as the source of the data"; only numbers computed from the spectra are committed.',
        opened: '2026-10-14',
      },
      { id: 'xiao2017', name: 'Xiao K et al. 2017, Characterising the variations in ethnic skin colours: a new calibrated data base for human skin. Skin Res Technol 23(1):21–29', version: 'Table 2 (CIELAB means by site for Caucasian, Chinese, Kurdish and Thai groups; CM-2600d / SP62, d/8, D65/2°)', url: 'https://doi.org/10.1111/srt.12295', ...epmc('CC BY', 'Only the CIELAB means of Table 2 are used.') },
      { id: 'vermilion2018', name: 'Measurement and correlation analysis of vermilion and facial skin color. Chinese Journal of Tissue Engineering Research (WPRIM record wpr-698623)', version: 'abstract only: vermilion and cheek CIELAB means, 202 volunteers, CM-700d; authors and year not checked', url: 'https://pesquisa.bvsalud.org/gim/resource/ar/wpr-698623', ...notChecked('Only the CIELAB means quoted in the abstract are cited as facts; the full text was not opened.', '2026-10-14') },
      { id: 'phan2022', name: 'Phan T et al. 2022, Quantifying the confounding effect of pigmentation on measured skin tissue optical properties. J Biomed Opt 27(3):036002', version: 'PMC8942554; palm L* 60.8 ± 4.6 (n = 15, Fitzpatrick I–VI, CR-400)', url: 'https://doi.org/10.1117/1.JBO.27.3.036002', ...epmc('CC BY', 'Only the palm L* mean and SD are used.') },
    ],
    ourState: { all: { 'data/curated/look/skin-colour.json': sha(join(ROOT, 'data/curated/look/skin-colour.json')), 'skin-lut.bin': sha(join(ROOT, 'public/anatomy/male/look/skin-lut.bin')) } },
    notes: [
      B('NIST 只测了前臂内侧，100 人里没有 ITA° < −30 的；深肤色一端和身体其他部位都靠模型外推或文献的部位差。', 'NIST measured only the inner forearm, and none of its 100 subjects has ITA° < −30; the deep end and every other body site rely on extrapolation by the model or on published site differences.'),
      B('部位行的参照是不同仪器、不同人群的 CIELAB 均值，只用了部位之间的差；残差反映的是模型的血量变化给不出那么高的 a*，不是测量误差。', "The regional rows use CIELAB means from other instruments and populations, and only the differences between sites; the residual reflects that the model's blood changes cannot reach that much a*, not a measurement error."),
    ],
    summary: summarise(rows as { verdict: Verdict }[]),
    rows,
  }
}

// ── 2. 皮肤细节 / skin detail ──────────────────────────────────────────────────────────────────────
export function skinDetailTable(): Table<Record<string, unknown>> {
  const cur = readJson<{ model: { fixed: { epidermisThicknessMm: { value: number } } }; regions: Record<string, { roughness?: number; epidermisMm?: number }> }>('data/curated/look/skin-colour.json')
  const micro = buildMicro()
  const fp = micro.facePores
  const density = fp.count / fp.tileCm2
  const meanArea = fp.areasMm2.reduce((a, b) => a + b, 0) / fp.areasMm2.length
  const rows: Record<string, unknown>[] = []
  // 范围用中点和半宽表示：|差| ≤ 半宽 即落在范围内 / a range as its midpoint and half-width: |diff| ≤ half-width means inside the range
  const band = (lo: number, hi: number) => ({ refLow: lo, refHigh: hi, mid: r3((lo + hi) / 2), half: r3((hi - lo) / 2) })
  const d = band(10, 80)
  rows.push({ item: 'facial pore density', quantity: 'pores per cm² in the micro-relief tile', ours: r1(density), ref: d.mid, refLow: d.refLow, refHigh: d.refHigh, diff: r1(density - d.mid), tolerance: d.half, unit: '/cm²', source: 'flament2015', verdict: judge(density - d.mid, d.half), note: B('参照是 2,585 名女性颊部的范围（中点 ± 半宽）', 'the reference is the range over the cheeks of 2,585 women (midpoint ± half-width)') })
  const a = band(0.03, 0.22)
  rows.push({ item: 'facial pore mean area', quantity: 'mean area of the tile\'s facial pores', ours: r3(meanArea), ref: a.mid, refLow: a.refLow, refHigh: a.refHigh, diff: r3(meanArea - a.mid), tolerance: a.half, unit: 'mm²', source: 'flament2015', verdict: judge(meanArea - a.mid, a.half) })
  rows.push({ item: 'body fine-pore density', quantity: 'follicular openings per cm² in the tile', ours: 120, unit: '/cm²', verdict: 'not comparable', note: B('假设，没有找到测量值', 'assumed; no measurement found') })
  rows.push({ item: 'ridge period', quantity: 'period of the epidermal ridges (palms, soles, finger pads)', ours: 0.45, unit: 'mm', verdict: 'not comparable', note: B('假设（成人嵴宽的量级）；没有核对过的出处', 'assumed (the order of adult ridge breadth); no checked source') })
  const epi = cur.model.fixed.epidermisThicknessMm.value * 1000
  rows.push({ item: 'epidermis thickness (skin model)', quantity: 'melanin-bearing epidermis of the colour model', ours: r1(epi), ref: 56.6, diff: r1(epi - 56.6), tolerance: 11.5, unit: 'µm', source: 'sandby2003', verdict: judge(epi - 56.6, 11.5), note: B('前臂背侧的活表皮（不含角质层）56.6 ± 11.5 µm；容差 1 SD', 'viable epidermis of the dorsal forearm (stratum corneum excluded) 56.6 ± 11.5 µm; tolerance 1 SD') })
  const lip = cur.regions.lips?.epidermisMm
  if (typeof lip === 'number') rows.push({ item: 'vermilion effective epidermis', quantity: 'inverted from the vermilion colour', ours: r1(lip * 1000), unit: 'µm', verdict: 'not comparable', note: B('由颜色反推的等效值，不是组织学厚度；没有可比的测量', 'an effective value inverted from colour, not a histological thickness; no comparable measurement') })
  // 粗糙度：主瓣 GGX α = (r·1.4·0.75)²，r 是部位贴图里的值 / roughness: main-lobe GGX α = (r·1.4·0.75)², r the region map's value
  const alpha = (r: number): number => (r * 1.4 * 0.75) ** 2
  const ROUGH: [string, Bilingual, number, boolean][] = [
    ['forehead', B('额头', 'forehead'), cur.regions.forehead?.roughness ?? 0.45, true],
    ['cheek', B('颊部', 'cheek'), cur.regions.cheek?.roughness ?? 0.45, true],
    ['nose', B('鼻', 'nose'), cur.regions.nose?.roughness ?? 0.42, true],
    ['lips', B('唇红', 'vermilion'), cur.regions.lips?.roughness ?? 0.35, true],
    ['body', B('身体（缺省）', 'body (default)'), 0.5, false],
    ['palmsSoles', B('手掌、足底', 'palms and soles'), cur.regions.palmsSoles?.roughness ?? 0.6, false],
  ]
  const w = band(0.18, 0.34)
  for (const [region, name, r, face] of ROUGH) {
    const al = alpha(r)
    rows.push(face
      ? { region, name, quantity: 'main specular lobe, GGX α (85 % of the specular)', ours: r3(al), ref: w.mid, refLow: w.refLow, refHigh: w.refHigh, diff: r3(al - w.mid), tolerance: w.half, unit: 'α', source: 'weyrich2006', verdict: judge(al - w.mid, w.half), note: B('参照是图 15 里各面部区域 Beckmann m 平均值所在的范围（从坐标轴读出，取 α ≈ m）；第二瓣 α 约为主瓣的 3 倍，占 15 %', 'the reference is the range of the per-region means of the Beckmann m in Fig. 15 (read from its axis; α ≈ m taken); the second lobe has about 3× the α and 15 % of the weight') }
      : { region, name, quantity: 'main specular lobe, GGX α', ours: r3(al), unit: 'α', verdict: 'not comparable', note: B('Weyrich 等只测了面部；身体的值是假设', 'Weyrich et al. measured faces only; the body value is assumed') })
    if (region === 'lips') (rows[rows.length - 1] as Record<string, unknown>).note = B('唇红比文献的面部范围更光（假设的 0.35）；Weyrich 等指出唇红区的参数变化很大，但图里没有给出唇的范围', "the vermilion is glossier than the published facial range (the assumed 0.35); Weyrich et al. note that lip parameters vary widely, but the figure gives no range for the lips")
  }
  return {
    schema: 1,
    id: 'skin-detail',
    title: B('写实皮肤的细节：毛孔、表皮厚度、粗糙度 vs 文献', 'Lifelike skin detail: pores, epidermis thickness, roughness vs the literature'),
    method: B(
      '毛孔的密度和面积由生成微细起伏贴图的程序（tools/look/micro.ts，种子固定）直接给出：一块代表 1 cm² 的皮肤。表皮厚度是颜色模型用的值（data/curated/look/skin-colour.json）。粗糙度：部位贴图里的值乘全局倍数 1.4、主瓣再乘 0.75，three 的 GGX α = r²；文献给的是 Torrance–Sparrow 模型的 Beckmann m，这里按 α ≈ m 比较。',
      "Pore density and area come straight from the program that generates the micro-relief tile (tools/look/micro.ts, fixed seed): one tile stands for 1 cm² of skin. The epidermis thickness is the colour model's value (data/curated/look/skin-colour.json). Roughness: the region map's value times the global factor 1.4, and the main lobe times 0.75 again; three's GGX α = r². The literature gives the Beckmann m of a Torrance–Sparrow model, compared here as α ≈ m.",
    ),
    tolerance: B('文献给的是范围时，落在范围内记 within；给的是均值和标准差时，差在 1 SD 内记 within。没有可比测量的项记 not comparable。', 'Where the literature gives a range, inside it counts as within; where it gives a mean and SD, a difference within 1 SD counts as within. Items without a comparable measurement are not comparable.'),
    references: [
      { id: 'flament2015', name: 'Flament F et al. 2015, Facial skin pores: a multiethnic study. Clin Cosmet Investig Dermatol 8:85–93', version: 'PMC4337418; cheeks of 2,585 women, Dermascore, detection threshold 250 µm: density about 10–80 /cm², mean area 0.03–0.22 mm²', url: 'https://doi.org/10.2147/CCID.S74401', ...epmc('CC BY-NC', 'Only the ranges of density and mean area are cited as numbers.') },
      { id: 'sandby2003', name: 'Sandby-Møller J, Poulsen T, Wulf HC 2003, Epidermal thickness at different body sites: relationship to age, gender, pigmentation, blood content, skin type and smoking habits. Acta Derm Venereol 83:410–413', version: 'abstract: viable epidermis of the dorsal forearm 56.6 (11.5) µm, stratum corneum 18.3 (4.9) µm, 71 volunteers', url: 'https://doi.org/10.1080/00015550310015419', ...notChecked('Two numbers of the abstract are cited as facts; the full text was not opened.') },
      { id: 'weyrich2006', name: 'Weyrich T et al. 2006, Analysis of human faces using a measurement-based skin reflectance model. ACM Trans Graph 25(3):1013–1024', version: "authors' copy (cseweb.ucsd.edu/~henrik/papers/skin-analysis/); Fig. 15: Torrance–Sparrow parameters per face region, 149 subjects", url: 'https://cseweb.ucsd.edu/~henrik/papers/skin-analysis/', licence: '© ACM; no open licence', clause: 'No licence grant; only the range of the roughness axis in Fig. 15 is read and cited as a fact.', opened: '2026-10-15' },
    ],
    ourState: { all: { 'tools/look/micro.ts': sha(join(ROOT, 'tools/look/micro.ts')), 'data/curated/look/skin-colour.json': sha(join(ROOT, 'data/curated/look/skin-colour.json')) } },
    notes: [
      B(`毛孔按 ${TILE_MM} mm 见方的一块统计；同一块贴图在面部和身体上平铺，所以整张脸的毛孔数随面积成比例。`, `Pores are counted on one ${TILE_MM} mm square tile; the same tile is repeated over the face and body, so the number of pores on a whole face scales with its area.`),
    ],
    summary: summarise(rows as { verdict: Verdict }[]),
    rows,
  }
}

// ── 3. 毛发 / hair ─────────────────────────────────────────────────────────────────────────────────
interface HairStats { [k: string]: number }
interface BodyHair { pieces: { id: string; stats?: HairStats }[] }
interface CuratedHair { values: Record<string, { value?: number; sd?: number; range?: number[]; status?: string; source?: string; [k: string]: unknown }> }

export function hairTable(): Table<Record<string, unknown>> {
  const cur = readJson<CuratedHair>('data/curated/hair/hair.json')
  const v = cur.values
  const rows: Record<string, unknown>[] = []
  const ourState: Record<string, Record<string, string>> = {}
  const inRange = (x: number, lo: number, hi: number) => ({ ref: r3((lo + hi) / 2), refLow: lo, refHigh: hi, diff: r1(x - (lo + hi) / 2), tolerance: r3((hi - lo) / 2), verdict: judge(x - (lo + hi) / 2, (hi - lo) / 2) })
  for (const body of BODIES) {
    const file = join(ROOT, 'public/anatomy', body, 'hair/hair.json')
    if (!existsSync(file)) continue
    ourState[body] = { 'hair/hair.json': sha(file) }
    const h = JSON.parse(readFileSync(file, 'utf8')) as BodyHair
    const st = (id: string): HairStats | undefined => h.pieces.find((p) => p.id === id)?.stats
    const scalp = st('short') ?? st('long')
    if (scalp) {
      const sd = v.scalpDensity!
      rows.push({ body, item: 'scalp hair density', ours: scalp.densityPerCm2, ref: sd.value, diff: r1(scalp.densityPerCm2! - sd.value!), tolerance: sd.sd, unit: '/cm²', source: 'leerunyakul2020', verdict: judge(scalp.densityPerCm2! - sd.value!, sd.sd!), note: B('白种人汇总均值 ± 1 SD（综述，转引）', 'Caucasian pooled mean ± 1 SD (review, secondary)') })
      const tot = v.totalScalpHairs!.range!
      rows.push({ body, item: 'total scalp hairs', ours: scalp.follicles, ...inRange(scalp.follicles!, tot[0]!, tot[1]!), unit: 'hairs', source: 'flindt2006' })
      const others = (scalp.density_vertex! + scalp.density_occipital! + scalp.density_frontal!) / 3
      const ratio = scalp.density_temporal! / others
      rows.push({ body, item: 'temporal / other scalp density', ours: r2(ratio), ref: v.temporalDensityRatio!.value, diff: r2(ratio - v.temporalDensityRatio!.value!), tolerance: 0.1, unit: 'ratio', source: 'thai2020', verdict: judge(ratio - v.temporalDensityRatio!.value!, 0.1), note: B('参照是泰国成人的颞顶区 / 其余区；容差 0.1 是本表所定', 'the reference is temporoparietal / elsewhere in Thai adults; the 0.1 tolerance is set by this table') })
    }
    const lashes = st('lashes')
    if (lashes) {
      const up = v.lashCountUpper!.range!, lo = v.lashCountLower!.range!, ul = v.lashLengthUpper!.range!, ll = v.lashLengthLower!.range!
      rows.push({ body, item: 'upper lashes per lid', ours: lashes.upperPerLid, ...inRange(lashes.upperPerLid!, up[0]!, up[1]!), unit: 'lashes', source: 'statpearls-eyelash' })
      rows.push({ body, item: 'lower lashes per lid', ours: lashes.lowerPerLid, ...inRange(lashes.lowerPerLid!, lo[0]!, lo[1]!), unit: 'lashes', source: 'statpearls-eyelash' })
      rows.push({ body, item: 'upper lash length (median)', ours: r1(lashes.upperLengthMm!), ...inRange(lashes.upperLengthMm!, ul[0]!, ul[1]!), unit: 'mm', source: 'wikipedia-eyelash' })
      rows.push({ body, item: 'lower lash length (median)', ours: r1(lashes.lowerLengthMm!), ...inRange(lashes.lowerLengthMm!, ll[0]!, ll[1]!), unit: 'mm', source: 'wikipedia-eyelash' })
    }
    const brows = st('brows')
    if (brows) {
      rows.push({ body, item: 'eyebrow hairs per side', ours: brows.perSide, unit: 'hairs', verdict: 'not comparable', note: B('参照 200–400（250）只有无出处的科普数字，记为假设', 'the 200–400 (250) reference is only an unsourced popular figure, recorded as an assumption') })
      rows.push({ body, item: 'eyebrow hair length (median)', ours: r1(brows.lengthMmP50!), unit: 'mm', verdict: 'not comparable', note: B('参照 5–11 mm 是假设', 'the 5–11 mm reference is an assumption') })
    }
    const beard = st('beard')
    if (beard) {
      const bd = v.beardDensity as unknown as Record<string, number>
      for (const [region, ours, ref, cited] of [['chin', beard.density_chin, bd.chin, true], ['moustache', beard.density_moustache, bd.moustacheLateral, true], ['cheek', beard.density_cheek, bd.cheek, true], ['neck', beard.density_neck, bd.neck, false]] as [string, number, number, boolean][]) {
        rows.push(cited
          ? { body, region: `beard, ${region}`, ours, ref, ratio: r2(ours / ref), toleranceFactor: 1.25, unit: '/cm²', source: 'dua2021', verdict: Math.abs(Math.log(ours / ref)) <= Math.log(1.25) ? 'within' : 'outside', note: region === 'moustache' ? B('参照取上唇外侧 87（中央 155）；文献是毛囊单位密度，胡须多为单根单位', 'reference: the lateral upper lip, 87 (central 155); the source gives follicular-unit densities, and beard units are mostly single hairs') : B('文献是毛囊单位密度，胡须多为单根单位；容差 ×/÷ 1.25 是本表所定', 'the source gives follicular-unit densities, and beard units are mostly single hairs; the ×/÷ 1.25 tolerance is set by this table') }
          : { body, region: `beard, ${region}`, ours, unit: '/cm²', verdict: 'not comparable', note: B('颈部没有报告值，30 是假设', 'no neck value was reported; 30 is assumed') })
      }
    }
    for (const id of ['pubic', 'axilla'] as const) {
      const s = st(id)
      if (s) rows.push({ body, item: id === 'pubic' ? 'pubic hair density' : 'axillary hair density', ours: s.densityPerCm2, unit: '/cm²', verdict: 'not comparable', note: B('没有找到测量值，目标密度是假设', 'no measurement found; the target density is assumed') })
    }
  }
  return {
    schema: 1,
    id: 'look-hair',
    title: B('写实的毛发：生成结果 vs 文献的数量和尺寸', 'Lifelike hair: what the generator built vs published counts and sizes'),
    method: B('生成结果取自每个人体的 public/anatomy/<body>/hair/hair.json（tools/hair/build.ts 在生成时数出的根数、密度、长度分位数）；参照取自 data/curated/hair/hair.json 列出的文献（那里标明了 cited / secondary / assumed）。本表只读，不重新生成毛发。', "What was built comes from each body's public/anatomy/<body>/hair/hair.json (counts, densities and length percentiles tallied by tools/hair/build.ts while generating); the references are the literature listed in data/curated/hair/hair.json (where every value is marked cited / secondary / assumed). This table only reads; it regenerates no hair."),
    tolerance: B('文献给范围时落在范围内记 within；给均值和标准差时差在 1 SD 内；胡须密度按比值 ×/÷ 1.25。参照本身是假设的项记 not comparable。', 'Inside the range where the literature gives one; within 1 SD where it gives mean and SD; beard densities by a ratio within ×/÷ 1.25. Items whose reference is itself an assumption are not comparable.'),
    references: [
      { id: 'leerunyakul2020', name: 'Leerunyakul K, Suchonwanit P 2020, Asian Hair: A Review of Structures, Properties, and Distinctive Disorders. Clin Cosmet Investig Dermatol 13:309–318', version: 'PMC7187942; Table 1 (pooled densities; review, values quoted from other studies)', url: 'https://doi.org/10.2147/CCID.S247390', ...epmc('CC BY-NC', 'Only the pooled density mean and SD are cited.') },
      { id: 'flindt2006', name: 'Flindt R 2006, Amazing Numbers in Biology, Springer, p. 212, via BioNumbers 101509', version: 'BioNumbers entry 101509: 90,000–150,000 scalp hairs', url: 'https://bionumbers.hms.harvard.edu/bionumber.aspx?id=101509', ...notChecked('Only the range is cited as a fact.') },
      { id: 'thai2020', name: 'Evaluation of Hair Density and Hair Diameter in the Adult Thai Population Using Quantitative Trichoscopic Analysis. BioMed Res Int 2020', version: 'PMC7035527; temporoparietal versus other scalp regions (value seen as a quoted snippet)', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7035527', ...epmc('CC BY', 'Only the ratio of regional densities is cited.') },
      { id: 'statpearls-eyelash', name: 'Patel BC, Lopez MJ, Joos ZP. Anatomy, Head and Neck: Eyelash. StatPearls (NBK537278)', version: 'quoted through Wikipedia "Eyelash": 90–160 upper, 75–80 lower lashes', url: 'https://www.ncbi.nlm.nih.gov/books/NBK537278/', ...notChecked('Only the two count ranges are cited as facts.') },
      { id: 'wikipedia-eyelash', name: 'Wikipedia, "Eyelash"', version: 'accessed 2026-10; lash lengths 7–8 mm upper, 5–6 mm lower (citing Thibaut et al. 2009, Na et al. 2006)', url: 'https://en.wikipedia.org/wiki/Eyelash', licence: 'CC BY-SA 4.0 (Wikipedia text)', clause: 'Wikipedia text is published under CC BY-SA 4.0; only two length ranges are cited as facts.', opened: '2026-10-15' },
      { id: 'dua2021', name: 'Dua K, Verma V, Dua A 2021, Beard and Moustache Reconstruction. Indian J Plast Surg 54(4):483–488', version: 'PMC8719972; follicular-unit densities by beard region (authors\' observation)', url: 'https://doi.org/10.1055/s-0041-1739248', ...epmc('CC BY-NC-ND', 'Only the regional densities are quoted as facts.') },
    ],
    ourState,
    notes: [B('生成器按目标密度撒毛囊；表里的密度是生成后在皮肤面积上数出来的，与目标的差来自边界、梯度和随机性。', "The generator scatters follicles at a target density; the densities here are counted over the skin area after generation, and differences from the target come from borders, gradients and randomness.")],
    summary: summarise(rows as { verdict: Verdict }[]),
    rows,
  }
}

// ── 4. 眼 / eyes ───────────────────────────────────────────────────────────────────────────────────
async function scannedEyes(body: string) {
  const dir = join(ROOT, 'public/anatomy', body)
  const data = JSON.parse(readFileSync(join(dir, 'anatomy.json'), 'utf8')) as AnatomyData
  const pick = (side: string, re: RegExp) => data.parts.find((p) => p.side === side && re.test(p.name))
  const wanted = (['L', 'R'] as const).map((side) => ({ side, sclera: pick(side, /^(left|right) sclera$/i)!, cornea: pick(side, /^(left|right) cornea$/i)! }))
  const meshes = await readGlbParts(join(dir, 'nervous.glb'), new Set(wanted.flatMap((w) => [w.sclera.id, w.cornea.id])))
  return wanted.map((w) => ({ ...w, scleraMesh: meshes.get(w.sclera.id)!, corneaMesh: meshes.get(w.cornea.id)! }))
}

export async function eyesTable(): Promise<Table<Record<string, unknown>>> {
  const rows: Record<string, unknown>[] = []
  const ourState: Record<string, Record<string, string>> = {}
  const MM = 1000
  for (const body of BODIES) {
    const dir = join(ROOT, 'public/anatomy', body)
    ourState[body] = Object.fromEntries(['anatomy.json', 'nervous.glb', 'integumentary.glb', 'face.json', 'face.bin', 'face/openings.json'].map((f) => [f, sha(join(dir, f))]))
    const data = JSON.parse(readFileSync(join(dir, 'face.json'), 'utf8')) as FaceData
    const face = indexFace(data, new Uint8Array(readFileSync(join(dir, 'face.bin'))))
    const o = JSON.parse(readFileSync(join(dir, 'face/openings.json'), 'utf8')) as FaceOpenings
    const skin = (await readGlbParts(join(dir, 'integumentary.glb'), new Set([o.skin]))).get(o.skin)!
    for (const e of await scannedEyes(body)) {
      const fit = fitEye(e.side, e.scleraMesh.positions, e.corneaMesh.positions)
      const scan = fit.scanRadius * MM
      rows.push({ body, side: e.side, item: 'scanned eyeball radius (sphere fit to the sclera)', ours: r2(scan), ref: 12.1, refLow: 10.5, refHigh: 13.5, diff: r2(scan - 12.1), tolerance: 1.4, unit: 'mm', source: 'bekerman2014', verdict: judge(scan - 12.1, 1.4), note: B('参照：横径平均 24.2 mm、范围约 21–27 mm 的一半；容差到范围边上', 'reference: half the transverse diameter, mean 24.2 mm and range about 21–27 mm; the tolerance reaches the range edges') })
      rows.push({ body, side: e.side, item: 'constructed eye radius', ours: r2(fit.radius * MM), ref: 12.1, diff: r2(fit.radius * MM - 12.1), tolerance: 1, unit: 'mm', source: 'bekerman2014', verdict: judge(fit.radius * MM - 12.1, 1), note: B('构造的眼用拟合半径，限在平均值 ±1 mm 内（构造约束）', 'the constructed eye uses the fitted radius, held within ±1 mm of the mean (a construction constraint)') })
      const gains = lidGains(face, o.skin, o.margins, skin.positions, [{ side: e.side, x: fit.centre[0] }])
      const fissure = (pitch: number): number => {
        const ch = lidGazeChannels(data, [{ side: e.side, pitch, pupilDistance: eyeShape(fit.radius).pupilDistance }], gains)
        const out = new Float32Array(skin.positions.length)
        displacePart(face, o.skin, skin.positions, ch, out)
        applyLidDrop(face, o.skin, ch, out)
        const near = (list: number[]) => list.reduce((b, v) => (Math.abs(out[v * 3]! - fit.centre[0]) < Math.abs(out[b * 3]! - fit.centre[0]) ? v : b), list[0]!)
        return out[near(o.margins[`upperLid${e.side}`]!) * 3 + 1]! - out[near(o.margins[`lowerLid${e.side}`]!) * 3 + 1]!
      }
      const f0 = fissure(0)
      for (const [pitch, ref, tol] of [[-20, 8.7 / 10.8, 0.06], [-30, 7.8 / 10.8, 0.06], [20, (3.13 + 8.5) / (4.1 + 6.6), 0.06]] as [number, number, number][]) {
        const ratio = fissure(pitch) / f0
        rows.push({ body, side: e.side, item: `palpebral fissure at ${pitch > 0 ? '+' : ''}${pitch}° gaze / at 0°`, ours: r3(ratio), ref: r3(ref), diff: r3(ratio - ref), tolerance: tol, unit: 'ratio', source: 'mastropietro2009', verdict: judge(ratio - ref, tol), note: pitch > 0 ? B('参照由文中 MRD1、MRD2 的均值相加得到', 'reference: the sum of the MRD1 and MRD2 means given in the text') : B('参照：睑裂 10.8 mm → −20° 时 8.7 mm、−30° 时 7.8 mm（文中均值）；容差 0.06 是本表所定', 'reference: fissure 10.8 mm → 8.7 mm at −20° and 7.8 mm at −30° (means in the text); the 0.06 tolerance is set by this table') })
      }
    }
  }
  rows.push({ item: 'anterior corneal radius', ours: EYE.corneaRadius * MM, ref: 7.8, diff: 0, tolerance: 0.1, unit: 'mm', source: 'legrand', verdict: 'within', note: B('构造值直接取自理论眼，按定义相等', 'the constructed value is taken from the theoretical eye, equal by definition') })
  rows.push({ item: 'corneal diameter (white to white)', ours: r2(EYE.limbusRadius * 2 * MM), ref: 11.71, diff: r2(EYE.limbusRadius * 2 * MM - 11.71), tolerance: 0.42, unit: 'mm', source: 'rufer2005', verdict: judge(EYE.limbusRadius * 2 * MM - 11.71, 0.42), note: B('构造值取自文献均值；容差 1 SD', 'the constructed value is the published mean; tolerance 1 SD') })
  return {
    schema: 1,
    id: 'look-eyes',
    title: B('写实的眼：拟合与构造的尺寸、睑裂随注视 vs 文献', 'Lifelike eyes: fitted and constructed sizes, and the fissure with gaze, vs the literature'),
    method: B('与加载时相同的计算（src/look/eyesFit.ts）：对每个人体扫描的巩膜做球面拟合；睑裂在注视 0°、±20°、−30° 时的高度用表情数据和睑随注视的通道（src/face/driver.ts）在发布的皮肤上算出，取最靠近瞳孔竖线的上下睑缘顶点之差，再与 0° 时相比。', 'The same computation as at load time (src/look/eyesFit.ts): a sphere fitted to each body\'s scanned sclera; the fissure height at 0°, ±20° and −30° gaze computed on the shipped skin with the expression data and the lid-follows-gaze channels (src/face/driver.ts), as the difference of the upper and lower lid-margin vertices nearest the pupil\'s vertical line, divided by the value at 0°.'),
    tolerance: B('见每行：眼球半径到文献范围的边上、构造半径 ±1 mm、睑裂比值 ±0.06、角膜尺寸 1 SD。', 'Per row: the eyeball radius up to the edges of the published range, the constructed radius ±1 mm, fissure ratios ±0.06, corneal sizes 1 SD.'),
    references: [
      { id: 'bekerman2014', name: 'Bekerman I, Gottlieb P, Vaiman M 2014, Variations in eyeball diameters of the healthy adults. J Ophthalmol 2014:503645', version: 'PMC4238270; CT of 250 adults: transverse diameter mean 24.2 mm, range about 21–27 mm', url: 'https://doi.org/10.1155/2014/503645', ...epmc('CC BY', 'Only the mean and range of the transverse diameter are used.') },
      { id: 'mastropietro2009', name: 'Mastropietro DA, Alves MR, Velasco e Cruz AA 2009, Upper and lower eyelid position in different degrees of downgaze and upgaze. Arq Bras Oftalmol 72(6):771–775', version: '10 normal subjects, −30° to +30°; means given in the text', url: 'https://doi.org/10.1590/S0004-27492009000600006', ...notChecked('Only the means given in the text are cited as facts.') },
      { id: 'legrand', name: "Le Grand's full theoretical eye, as given in Atchison DA, Smith G, Optics of the Human Eye (2000)", version: 'anterior corneal radius 7.8 mm', url: 'https://doi.org/10.1016/B978-0-7506-3775-6.X5001-9', ...notChecked('A textbook value cited as a fact.') },
      { id: 'rufer2005', name: 'Rüfer F, Schröder A, Erb C 2005, White-to-white corneal diameter: normal values in healthy humans obtained with the Orbscan II topography system. Cornea 24(3):259–261', version: '11.71 ± 0.42 mm', url: 'https://doi.org/10.1097/01.ico.0000148312.01805.53', ...notChecked('Only the mean and SD are cited as facts.') },
    ],
    ourState,
    notes: [B('这只眼是为显示构造的（来源"构造物"）；角膜尺寸等几行按定义与文献相等，列出来只是为了说明来源。', 'This eye is built for display (provenance "construction"); the corneal rows equal the literature by definition and are listed only to show where the values come from.')],
    summary: summarise(rows as { verdict: Verdict }[]),
    rows,
  }
}

export async function buildLookTables(): Promise<Table<Record<string, unknown>>[]> {
  return [skinColourTable(), skinDetailTable(), hairTable(), await eyesTable()]
}

/** 写成与 tools/calibrate/ 相同的格式 / written in the same format as tools/calibrate/ */
export const serialise = (t: Table<Record<string, unknown>>): string => JSON.stringify(t, null, 1) + '\n'

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  for (const t of await buildLookTables()) {
    writeFileSync(join(OUT, `${t.id}.json`), serialise(t))
    console.log(`${t.id}: ${JSON.stringify(t.summary)}`)
  }
}

if (import.meta.main) await main()
