// 女性小骨盆：以 Wu 等（2015）的真实女性盆底为骨架。
// 盆底肌、括约肌、会阴、尿道、阴道、肛门直肠以及子宫和附件来自同一位年轻女性（另一个体，CVH5），
// 彼此自洽；本文件给出这些结构的目录（名称、概念、分类、如何分左右），把锚点包里的网格修成封闭
// 流形并分侧，另有把其余结构（她扫描得到的膀胱、形变来的肠管和输尿管）接到这副骨架上的局部光滑场，
// 以及对成品几何做的数值检查。
// The female lesser pelvis, built round the real female pelvic floor of Wu et al. 2015.
// Pelvic floor muscles, sphincters, perineum, urethra, vagina, anorectum, uterus and adnexa come from
// one young woman (another individual, CVH5) and agree with each other; this file holds the catalogue
// of these structures (name, concept, class, how they are split into left and right), repairs the
// anchor package's meshes into closed manifolds and splits them, provides the smooth local fields that
// join everything else (her scanned bladder, the warped bowel and ureters) to this backbone, and the
// numeric checks run on the finished geometry.

import type { SourceInfo, SystemId, TissueId } from '../../src/anatomy/types.ts'
import { measure, type Mesh } from './geometry.ts'
import { HARD_TISSUES } from './import3.ts'
import { components, cutByPlane, repairClosed, signedVolume, topology } from './meshRepair.ts'
import { applyRigid, buildDeformation, icp, InsideTester, PointIndex, surfacePoints, thinPoints, type Rigid } from './register.ts'
import { axisParam } from './standard.ts'

export type Vec3 = [number, number, number]

export const SOURCE_WU: SourceInfo = {
  name: 'Wu et al. 2015 pelvic floor',
  url: 'https://doi.org/10.1371/journal.pone.0140736',
  license: 'CC BY 4.0',
  attribution:
    'Wu Y, Dabhoiwala NF, Hagoort J, Shan J-L, Tan L-W, Fang B-J, Zhang S-X, Lamers WH (2015) 3D Topography of the Young Adult Anal Sphincter Complex Reconstructed from Undeformed Serial Anatomical Sections. PLoS ONE 10(8): e0132226, doi:10.1371/journal.pone.0132226; 3D-PDF from the correction, doi:10.1371/journal.pone.0140736; CC BY 4.0. A young adult woman of the Chinese Visible Human series (CVH5), surfaces reconstructed and smoothed by the authors; scaled 1.096 and fitted to this pelvis, meshes repaired and split into left and right by this project.',
}

/** 如何分左右 / how a structure is split into left and right */
type Split = 'whole' | 'components' | 'plane'

export interface WuSpec {
  /** 锚点包条目 id（去掉 `WU_` 前缀） / anchor item id without the `WU_` prefix */
  item: string
  /** 不分侧的英文名；分侧的部件名由 `sided` 给出（`{s}` = left/right） / unsided English name; sided part names come from `sided` (`{s}` = left/right) */
  name: string
  sided?: string
  /** 概念：FMA id（确有同名类或同义词时），否则为合成的 `WUC_…` / concept: an FMA id where the exact class or a synonym exists, else a synthetic `WUC_…` */
  concept: string
  /** 分侧的 FMA 类 [左, 右]；没有时用 `<concept>_L` / `<concept>_R` / sided FMA classes [left, right]; `<concept>_L` / `<concept>_R` when absent */
  sidedConcept?: [string, string]
  /** 合成概念在 is-a 树里的父类（FMA id） / is-a parent (an FMA id) of a synthetic concept */
  isaParent?: string
  system: SystemId
  tissue: TissueId
  split: Split
  /** part-of 分组 / part-of group */
  group: 'pelvicDiaphragm' | 'analPerineum' | 'urogenitalPerineum' | 'urethra' | 'rectum' | 'genital'
  /** 沿用其身份（概念、树中位置）的男性部件 [左或中, 右]，以及被它取代的其余男性部件 / male parts whose identity (concept, tree position) it takes [left or midline, right], and further male parts it replaces */
  male?: [string, string?]
  replaces?: string[]
  /** 对来源名称所作的改动或映射的依据 / what was changed against the source's label, or the basis of the mapping */
  note?: string
}

// FMA 映射只用 fma_names.tsv 中确有的同名类或同义词；“耻骨内脏肌”的内、外层和“耻骨直肠肌”的深、浅部
// 在 FMA 中没有对应的类，用合成概念挂在 pubovisceralis / puborectalis 之下。
// FMA mappings use only exact classes or synonyms found in fma_names.tsv; the inner and external layer of
// the "pubovisceral muscle" and the deep and superficial part of the "puborectal muscle" have no FMA
// class and get synthetic concepts under pubovisceralis / puborectalis.
export const WU_SPECS: WuSpec[] = [
  { item: 'coccygeal_muscle', name: 'Coccygeus', sided: '{S} coccygeus', concept: 'FMA19088', sidedConcept: ['FMA46444', 'FMA46443'], system: 'muscular', tissue: 'muscle', split: 'components', group: 'pelvicDiaphragm', male: ['FJ1449M', 'FJ2547'] },
  { item: 'pubovisceral_muscle_inner_layer', name: 'Inner layer of pubovisceral muscle', sided: 'Inner layer of {s} pubovisceral muscle', concept: 'WUC_pubovisceral_muscle_inner_layer', isaParent: 'FMA265291', system: 'muscular', tissue: 'muscle', split: 'components', group: 'pelvicDiaphragm', replaces: ['FJ2545', 'FJ2550'], note: 'the source\'s "pubovisceral muscle" comprises the pubococcygeus and iliococcygeus of most atlases; its layers have no FMA class' },
  { item: 'pubovisceral_muscle_external_layer', name: 'External layer of pubovisceral muscle', sided: 'External layer of {s} pubovisceral muscle', concept: 'WUC_pubovisceral_muscle_external_layer', isaParent: 'FMA265291', system: 'muscular', tissue: 'muscle', split: 'components', group: 'pelvicDiaphragm', replaces: ['FJ1453M', 'FJ2549'] },
  { item: 'puborectal_muscle_deep_part', name: 'Deep part of puborectalis', sided: 'Deep part of {s} puborectalis', concept: 'WUC_puborectalis_deep_part', isaParent: 'FMA19091', system: 'muscular', tissue: 'muscle', split: 'plane', group: 'pelvicDiaphragm', replaces: ['FJ1458M', 'FJ2551'], note: 'one U-shaped sling in the source, cut at the midline' },
  { item: 'puborectal_muscle_superficial_part', name: 'Superficial part of puborectalis', sided: 'Superficial part of {s} puborectalis', concept: 'WUC_puborectalis_superficial_part', isaParent: 'FMA19091', system: 'muscular', tissue: 'muscle', split: 'plane', group: 'pelvicDiaphragm', note: 'one U-shaped sling in the source, cut at the midline' },
  { item: 'rectococcygeal_muscle', name: 'Rectococcygeus', concept: 'FMA77237', system: 'muscular', tissue: 'muscle', split: 'whole', group: 'rectum' },
  { item: 'rectoperineal_muscle', name: 'Rectoperinealis', concept: 'FMA77241', system: 'muscular', tissue: 'muscle', split: 'whole', group: 'analPerineum' },
  { item: 'external_anal_sphincter', name: 'External anal sphincter', concept: 'FMA21930', system: 'muscular', tissue: 'muscle', split: 'whole', group: 'analPerineum', male: ['FJ1450'], replaces: ['FJ1450M'] },
  { item: 'internal_anal_sphincter', name: 'Internal anal sphincter', concept: 'FMA15710', system: 'digestive', tissue: 'muscle', split: 'whole', group: 'analPerineum' },
  { item: 'conjoint_longitudinal_muscle_of_rectum', name: 'Conjoint longitudinal muscle', concept: 'WUC_conjoint_longitudinal_muscle', isaParent: 'FMA15709', system: 'digestive', tissue: 'muscle', split: 'whole', group: 'analPerineum', note: 'source label "conjoint longitudinal muscle of rectum"; FMA has only layers of parts of the anal canal under similar names' },
  { item: 'anal_intermuscular_septum', name: 'Anal intermuscular septum', concept: 'WUC_anal_intermuscular_septum', system: 'digestive', tissue: 'fascia', split: 'whole', group: 'analPerineum' },
  { item: 'anococcygeal_ligament', name: 'Anococcygeal ligament', concept: 'FMA20273', system: 'muscular', tissue: 'ligament', split: 'whole', group: 'analPerineum', note: 'FMA "anococcygeal body" (synonym: anococcygeal ligament)' },
  { item: 'smooth_muscle_of_rectum', name: 'Rectum', concept: 'FMA14544', system: 'digestive', tissue: 'organ', split: 'whole', group: 'rectum', male: ['FJ2571'], note: 'source label "smooth muscle of rectum": the muscular wall of the rectum and anal canal up to the top of the specimen slab' },
  { item: 'rectal_lumen', name: 'Lumen of rectum', concept: 'FMA14598', system: 'digestive', tissue: 'space', split: 'whole', group: 'rectum' },
  { item: 'mesorectum', name: 'Mesorectum', concept: 'FMA323690', system: 'digestive', tissue: 'fascia', split: 'whole', group: 'rectum' },
  { item: 'vaginal_wall', name: 'Vagina', concept: 'FMA19949', system: 'reproductive', tissue: 'organ', split: 'whole', group: 'genital', note: 'source label "vaginal wall"' },
  { item: 'uterine_wall', name: 'Uterus', concept: 'FMA17558', system: 'reproductive', tissue: 'organ', split: 'whole', group: 'genital', note: 'source label "uterine wall" (body and cervix as one surface)' },
  { item: 'uterine_and_vaginal_lumen', name: 'Uterine and vaginal lumen', concept: 'WUC_uterine_and_vaginal_lumen', system: 'reproductive', tissue: 'space', split: 'whole', group: 'genital' },
  { item: 'uterine_tube', name: 'Uterine tube', sided: '{S} uterine tube', concept: 'FMA18245', sidedConcept: ['FMA18484', 'FMA18483'], system: 'reproductive', tissue: 'organ', split: 'components', group: 'genital' },
  { item: 'ovary', name: 'Ovary', sided: '{S} ovary', concept: 'FMA7209', sidedConcept: ['FMA7214', 'FMA7213'], system: 'reproductive', tissue: 'gland', split: 'components', group: 'genital' },
  { item: 'round_ligament_of_uterus', name: 'Round ligament of uterus', sided: '{S} round ligament of uterus', concept: 'FMA20420', sidedConcept: ['FMA57790', 'FMA57789'], system: 'reproductive', tissue: 'ligament', split: 'components', group: 'genital', note: 'pelvic part only, as far as the specimen slab reaches' },
  { item: 'denonvillier_fascia', name: 'Rectovaginal septum', concept: 'FMA19934', system: 'reproductive', tissue: 'fascia', split: 'whole', group: 'genital', note: 'source label "Denonvilliers\' fascia"; in a female this is the rectovaginal septum (FMA synonym: rectovaginal fascia)' },
  { item: 'perineal_body', name: 'Perineal body', concept: 'FMA20274', system: 'muscular', tissue: 'tendon', split: 'whole', group: 'urogenitalPerineum' },
  { item: 'deep_perineal_muscle', name: 'Deep transverse perineal muscle', sided: '{S} deep transverse perineal muscle', concept: 'FMA19732', sidedConcept: ['FMA21926', 'FMA21925'], system: 'muscular', tissue: 'muscle', split: 'plane', group: 'urogenitalPerineum', note: 'source label "deep perineal muscle"; one mesh across the midline, cut there' },
  { item: 'superficial_transverse_perineal_muscle', name: 'Superficial transverse perineal muscle', sided: '{S} superficial transverse perineal muscle', concept: 'FMA19731', sidedConcept: ['FMA21920', 'FMA21919'], system: 'muscular', tissue: 'muscle', split: 'plane', group: 'urogenitalPerineum', note: 'one mesh across the midline, cut there' },
  { item: 'bulbospongiosus_muscle', name: 'Bulbospongiosus', sided: '{S} bulbospongiosus', concept: 'FMA19729', sidedConcept: ['FMA21922', 'FMA21921'], system: 'muscular', tissue: 'muscle', split: 'plane', group: 'urogenitalPerineum', note: 'one mesh joined at the perineal body, cut at the midline' },
  { item: 'ischiocavernous_muscle', name: 'Ischiocavernosus', sided: '{S} ischiocavernosus', concept: 'FMA19730', sidedConcept: ['FMA21924', 'FMA21923'], system: 'muscular', tissue: 'muscle', split: 'components', group: 'urogenitalPerineum' },
  { item: 'vestibular_bulb', name: 'Bulb of vestibule', sided: '{S} bulb of vestibule', concept: 'FMA20199', sidedConcept: ['FMA74318', 'FMA74317'], system: 'reproductive', tissue: 'organ', split: 'components', group: 'urogenitalPerineum' },
  { item: 'bartholin_gland', name: 'Greater vestibular gland', sided: '{S} greater vestibular gland', concept: 'FMA9598', sidedConcept: ['FMA20012', 'FMA20011'], system: 'reproductive', tissue: 'gland', split: 'components', group: 'urogenitalPerineum', note: 'source label "Bartholin\'s gland"' },
  { item: 'cavernous_body_of_clitoris', name: 'Corpus cavernosum of clitoris', concept: 'FMA20172', system: 'reproductive', tissue: 'organ', split: 'whole', group: 'urogenitalPerineum', note: 'both corpora (crura and body) as one mesh, as in the source' },
  { item: 'submucous_layer_of_urethra', name: 'Submucous layer of female urethra', concept: 'WUC_submucous_layer_of_female_urethra', system: 'urinary', tissue: 'organ', split: 'whole', group: 'urethra', note: 'the urethral tube inside its sphincter; the source has no separate mucosa or smooth muscle coat' },
  { item: 'urethral_sphincter_proper', name: 'Urethral sphincter proper', concept: 'WUC_urethral_sphincter_proper', isaParent: 'FMA19778', system: 'urinary', tissue: 'muscle', split: 'whole', group: 'urethra', note: 'the circular part of the female external urethral sphincter' },
  { item: 'raphe_of_urethral_sphincter', name: 'Raphe of urethral sphincter', concept: 'WUC_raphe_of_urethral_sphincter', system: 'urinary', tissue: 'tendon', split: 'whole', group: 'urethra' },
  { item: 'urethral_compressor_muscle', name: 'Compressor urethrae', concept: 'FMA30438', system: 'urinary', tissue: 'muscle', split: 'whole', group: 'urethra' },
  { item: 'urethro_vaginal_sphincter', name: 'Sphincter urethrovaginalis', concept: 'FMA30439', system: 'urinary', tissue: 'muscle', split: 'whole', group: 'urethra' },
  { item: 'pubovesical_ligament', name: 'Pubovesical ligament', sided: '{S} pubovesical ligament', concept: 'FMA329212', system: 'urinary', tissue: 'ligament', split: 'components', group: 'urethra' },
]

/** 不输出的 Wu 条目及原因 / Wu items that are not shipped, and why */
export const WU_NOT_SHIPPED: Record<string, string> = {
  internal_obturator_muscle: 'the donor\'s own obturator internus (Denver) is used',
  pelvic_bone: 'the donor\'s own hip bones are used; registration target only',
  sacral_and_coccygeal_bone: 'the donor\'s own sacrum is used; registration target only',
  bladder_wall: 'her scanned bladder is kept for size and dome position; the Wu bladder (lumen 275 ml in the anchor frame) gives the neck position only',
  bladder_and_urethral_lumen: 'bladder part belongs to the Wu bladder, which is not shipped; the urethral part is not separable without an arbitrary cut',
  ureter: 'pelvic fragments only; the warped ureters are kept whole and joined to her bladder',
  peritoneum: 'an open sheet of another individual that would not meet the warped abdominal organs',
  fat_tissue: 'unnamed aggregate',
  arteries: 'one unnamed aggregate of all arteries of the slab',
  veins: 'one unnamed aggregate of all veins of the slab (403 fragments)',
  skin: 'the outline of the specimen slab (thighs and buttocks of a slimmer individual, cut at the slab ends), not a skin patch that could be joined to the body surface; used only to say where the perineal skin must lie',
}

/** 被 Wu 的子宫、附件和阴道取代的 HRA 条目 / HRA items replaced by the Wu uterus, adnexa and vagina */
export const HRA_REPLACED_BY_WU = /^HRA_(vagina|cervicovaginal_junction|anterior_wall_of_uterus|posterior_wall_of_uterus|body_of_uterus|fundus_of_uterus|cervix|cornua|external_cervical_os|internal_cervical_os|lower_uterine_segment|abdominal_ostium_of_uterine_tube|ampulla_of_uterine_tube_[LR]|isthmus_of_fallopian_tube_[LR]|uterine_tube_infundibulum_[LR]|fibria_of_uterine_tube_[LR]|(left|right)_ovary|(left|right)_round_ligament_of_uterus)$/

export interface WuPart {
  id: string
  spec: WuSpec
  name: string
  side: 'L' | 'R' | 'M'
  concept: string
  /** 不分侧的概念及其标签（分侧部件的父概念） / the unsided concept and its label (parent of a sided part's concept) */
  mesh: Mesh
  male?: string
  watertight: boolean
  volumeMl: number
}

export interface WuBuildRow {
  item: string
  parts: { id: string; side: string; triangles: number; watertight: boolean; boundaryEdges: number; nonManifoldEdges: number; volumeMl: number }[]
  split: Split
  trianglesIn: number
  fragmentsRemoved: number
  fragmentTriangles: number
  nonManifoldEdgesBefore: number
  verticesSplit: number
  trianglesPatched: number
  flipped: boolean
  volumeMlIn: number
  volumeMlOut: number
  note?: string
}

/**
 * 把（已带到她的骨盆上的）Wu 条目修成封闭网格并分左右。`xMid`：正中矢状面的 x。
 * 成对且两侧本来就是分开的结构按连通分量分侧；跨过中线连成一体的成对结构沿正中矢状面切开并加盖。
 * Repairs the Wu items (already carried onto her pelvis) into closed meshes and splits them into left
 * and right. `xMid`: x of the midsagittal plane. Paired structures whose sides are separate anyway are
 * split by connected component; paired structures that are one piece across the midline are cut along
 * the midsagittal plane and capped.
 */
export function buildWuParts(meshOf: (item: string) => Mesh | null, xMid: number): { parts: WuPart[]; rows: WuBuildRow[] } {
  const parts: WuPart[] = []
  const rows: WuBuildRow[] = []
  const cx = (m: Mesh) => {
    let s = 0
    for (let i = 0; i < m.positions.length; i += 3) s += m.positions[i]!
    return s / (m.positions.length / 3)
  }
  for (const spec of WU_SPECS) {
    const src = meshOf(spec.item)
    if (!src) continue
    const rep = repairClosed(src)
    const pieces: { side: 'L' | 'R' | 'M'; mesh: Mesh }[] = []
    let note: string | undefined
    if (spec.split === 'whole') pieces.push({ side: 'M', mesh: rep.mesh })
    else if (spec.split === 'components') {
      // 每个连通分量归到它质心所在的一侧；同侧的各分量并成一个部件
      // every connected component goes to the side its centroid is on; components of one side form one part
      const by: Record<'L' | 'R', number[]> = { L: [], R: [] }
      const comps = components(rep.mesh)
      comps.forEach((c, i) => by[cx(c) > xMid ? 'L' : 'R'].push(i))
      for (const side of ['L', 'R'] as const) {
        if (!by[side].length) continue
        const list = by[side].map((i) => comps[i]!)
        const positions = new Float32Array(list.reduce((s, m) => s + m.positions.length, 0))
        const indices = new Uint32Array(list.reduce((s, m) => s + m.indices.length, 0))
        let vo = 0
        let io = 0
        for (const m of list) {
          positions.set(m.positions, 3 * vo)
          for (let k = 0; k < m.indices.length; k++) indices[io + k] = m.indices[k]! + vo
          vo += m.positions.length / 3
          io += m.indices.length
        }
        pieces.push({ side, mesh: { positions, indices } })
      }
    } else {
      // 两半各切一刀，切面相距 0.2 mm：两个盖子若完全重合，谁在谁里面就说不清
      // one cut per half, the cut faces 0.2 mm apart: with exactly coincident caps "inside" would be undecidable
      const cut = cutByPlane(rep.mesh, [1, 0, 0], xMid + 0.0001)
      const cutR = cutByPlane(rep.mesh, [1, 0, 0], xMid - 0.0001)
      pieces.push({ side: 'L', mesh: cut.positive }, { side: 'R', mesh: cutR.negative })
      note = `cut at the midsagittal plane: ${cut.loops} cut outline${cut.loops === 1 ? '' : 's'} capped`
    }
    const row: WuBuildRow = {
      item: `WU_${spec.item}`, parts: [], split: spec.split, trianglesIn: rep.report.trianglesIn, fragmentsRemoved: rep.report.fragmentsRemoved, fragmentTriangles: rep.report.fragmentTriangles,
      nonManifoldEdgesBefore: rep.report.nonManifoldEdgesBefore, verticesSplit: rep.report.verticesSplit, trianglesPatched: rep.report.trianglesPatched, flipped: rep.report.flipped,
      volumeMlIn: Number((Math.abs(signedVolume(src)) * 1e6).toFixed(2)), volumeMlOut: 0, ...(note ? { note } : {}),
    }
    for (const piece of pieces) {
      const S = piece.side === 'L' ? 'Left' : 'Right'
      const name = piece.side === 'M' ? spec.name : spec.sided!.replace('{S}', S).replace('{s}', S.toLowerCase())
      const concept = piece.side === 'M' ? spec.concept : (spec.sidedConcept?.[piece.side === 'L' ? 0 : 1] ?? `${spec.concept}_${piece.side}`)
      const tp = topology(piece.mesh)
      const vol = Number((signedVolume(piece.mesh) * 1e6).toFixed(2))
      const id = `WU_${spec.item}${piece.side === 'M' ? '' : `_${piece.side}`}`
      parts.push({ id, spec, name, side: piece.side, concept, mesh: piece.mesh, male: spec.male?.[piece.side === 'R' ? 1 : 0], watertight: tp.watertight, volumeMl: vol })
      row.parts.push({ id, side: piece.side, triangles: tp.triangles, watertight: tp.watertight, boundaryEdges: tp.boundaryEdges, nonManifoldEdges: tp.nonManifoldEdges, volumeMl: vol })
      row.volumeMlOut = Number((row.volumeMlOut + vol).toFixed(2))
    }
    rows.push(row)
  }
  return { parts, rows }
}

// ── 光滑的局部场 / smooth local fields ───────────────────────────────────────────────────────────────

/**
 * 高斯加权的平移场：`from` 处的点移到 `to`，影响随距离按 σ 衰减；处处光滑，不产生逐顶点噪声。
 * 多个控制点时各自的位移按归一化的高斯权重混合（控制点处精确到位）。
 * A Gaussian-weighted translation field: a point at `from` goes to `to`, the effect fading with distance
 * by σ; smooth everywhere, no per-vertex noise. With several controls the displacements are blended by
 * normalised Gaussian weights (exact at the controls).
 */
export function pullField(controls: { from: Vec3; to: Vec3; sigma: number }[]): (points: Float32Array) => Float32Array {
  return (points) => {
    const out = Float32Array.from(points)
    for (let i = 0; i < points.length; i += 3) {
      let wSum = 0
      let wMax = 0
      const d = [0, 0, 0]
      for (const c of controls) {
        const r2 = (points[i]! - c.from[0]) ** 2 + (points[i + 1]! - c.from[1]) ** 2 + (points[i + 2]! - c.from[2]) ** 2
        const w = Math.exp(-r2 / (2 * c.sigma * c.sigma))
        wSum += w
        wMax = Math.max(wMax, w)
        d[0] = d[0]! + w * (c.to[0] - c.from[0])
        d[1] = d[1]! + w * (c.to[1] - c.from[1])
        d[2] = d[2]! + w * (c.to[2] - c.from[2])
      }
      if (wSum < 1e-9) continue
      // 归一化后的混合位移，再乘以最大权重使其在远处衰减到零
      // the normalised blend, times the largest weight so that it fades to zero far away
      const k = wMax / wSum
      out[i] = points[i]! + k * d[0]!
      out[i + 1] = points[i + 1]! + k * d[1]!
      out[i + 2] = points[i + 2]! + k * d[2]!
    }
    return out
  }
}

// ── 度量 / measurements ──────────────────────────────────────────────────────────────────────────────

export const surfaceSamples = (m: Mesh, spacing = 0.002): Float32Array => thinPoints(surfacePoints(m, spacing), spacing * 0.8)

/** `a` 的表面位于 `b` 内部的比例（射线奇偶；`b` 应封闭）。 / Share of the surface of `a` inside `b` (ray parity; `b` should be closed). */
export function insideFraction(a: Mesh, b: Mesh, spacing = 0.002): number {
  return new InsideTester(b, 96).fractionInside(surfaceSamples(a, spacing))
}

/** 两个表面之间的最小距离（米，按采样间距近似）。 / Smallest distance between two surfaces (m, approximate to the sampling). */
export function minGap(a: Mesh, b: Mesh, spacing = 0.001): number {
  const ix = new PointIndex(surfaceSamples(b, spacing), 0.004)
  const pa = surfaceSamples(a, spacing)
  let d = Infinity
  for (let i = 0; i < pa.length; i += 3) d = Math.min(d, ix.distance(pa[i]!, pa[i + 1]!, pa[i + 2]!, d))
  return d
}

export function bboxOf(m: Mesh): [number, number, number, number, number, number] {
  const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  const p = m.positions
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    if (p[i + k]! < b[k]!) b[k] = p[i + k]!
    if (p[i + k]! > b[k + 3]!) b[k + 3] = p[i + k]!
  }
  return b
}

export function centroidOf(m: Mesh): Vec3 {
  const c: Vec3 = [0, 0, 0]
  const n = m.positions.length / 3
  for (let i = 0; i < m.positions.length; i++) c[i % 3] = c[i % 3]! + m.positions[i]! / n
  return c
}

/** 网格在高度 [y0, y1] 这一层内的顶点（展平的 xyz）。 / Vertices of a mesh within the slab [y0, y1] (flat xyz). */
export function slabPoints(m: Mesh, y0: number, y1: number): number[] {
  const out: number[] = []
  const p = m.positions
  for (let i = 0; i < p.length; i += 3) if (p[i + 1]! >= y0 && p[i + 1]! <= y1) out.push(p[i]!, p[i + 1]!, p[i + 2]!)
  return out
}

/** 一组点在 XZ 平面上的凸包（逆时针，[x, z] 对）。 / Convex hull in the XZ plane of a set of points (counter-clockwise [x, z] pairs). */
export function hullXZ(points: number[]): [number, number][] {
  const pts: [number, number][] = []
  for (let i = 0; i < points.length; i += 3) pts.push([points[i]!, points[i + 2]!])
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: [number, number][] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: [number, number][] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop()
    upper.push(p)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

export function inHullXZ(hull: [number, number][], x: number, z: number): boolean {
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!
    const b = hull[(i + 1) % hull.length]!
    if ((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false
  }
  return hull.length >= 3
}

// ── 盆腔协调 / reconciliation ────────────────────────────────────────────────────────────────────────

export interface PelvisPart {
  id: string
  name: string
  system: SystemId
  tissue: TissueId
  provenance: string
  side: 'L' | 'R' | 'M'
  source?: string
  mesh: Mesh
  centrelines?: { points: Float32Array; radius: Float32Array }[]
}

export interface PelvisInput {
  /** 全部部件；本函数就地修改其中盆腔部件的网格 / all parts; the meshes of pelvic parts are changed in place */
  parts: PelvisPart[]
  /** 不输出的参考网格：Wu 的膀胱壁和皮肤、形变后的男性直肠（`male_rectum`）等 / reference meshes that are not shipped: Wu bladder wall and skin, the warped male rectum (`male_rectum`), … */
  extras: Map<string, Mesh>
  /** 被 Wu 结构取代的 HRA 器官（只作对比和配准之用） / HRA organs replaced by Wu structures (for comparison and registration only) */
  hraReplaced: PelvisPart[]
  log?: (line: string) => void
}

/**
 * 相互重叠时谁让位：排在前面的保持不动，后面的把陷入前者的表面推出来。中空器官在先，其次括约肌和
 * 肛提肌，薄的筋膜和腔在最后。
 * Who gives way where two overlap: earlier entries stay, later ones have the surface sunk into an earlier
 * one slid out. Hollow organs first, then sphincters and levator, thin fasciae and lumina last.
 */
export const WU_PRIORITY = [
  'vaginal_wall', 'smooth_muscle_of_rectum', 'submucous_layer_of_urethra', 'uterine_wall', 'internal_anal_sphincter', 'urethral_sphincter_proper', 'external_anal_sphincter',
  'conjoint_longitudinal_muscle_of_rectum', 'puborectal_muscle_deep_part', 'puborectal_muscle_superficial_part', 'pubovisceral_muscle_inner_layer', 'pubovisceral_muscle_external_layer',
  'coccygeal_muscle', 'perineal_body', 'urethral_compressor_muscle', 'urethro_vaginal_sphincter', 'bulbospongiosus_muscle', 'deep_perineal_muscle', 'superficial_transverse_perineal_muscle',
  'ischiocavernous_muscle', 'cavernous_body_of_clitoris', 'vestibular_bulb', 'bartholin_gland', 'rectococcygeal_muscle', 'rectoperineal_muscle', 'anococcygeal_ligament', 'ovary', 'uterine_tube',
  'round_ligament_of_uterus', 'pubovesical_ligament', 'raphe_of_urethral_sphincter', 'anal_intermuscular_septum', 'denonvillier_fascia', 'mesorectum', 'rectal_lumen', 'uterine_and_vaginal_lumen',
]
const wuItemOf = (id: string) => id.replace(/^WU_/, '').replace(/_[LR]$/, '')
const wuRank = (id: string) => {
  const r = WU_PRIORITY.indexOf(wuItemOf(id))
  return r < 0 ? WU_PRIORITY.length : r
}
const sideRank = (id: string) => (id.endsWith('_R') ? 1 : 0)

const overlaps = (a: readonly number[], b: readonly number[], pad = 0) => !(a[0]! > b[3]! + pad || a[3]! < b[0]! - pad || a[1]! > b[4]! + pad || a[4]! < b[1]! - pad || a[2]! > b[5]! + pad || a[5]! < b[2]! - pad)
const r1 = (v: number, d = 1) => Number(v.toFixed(d))
const mmOf = (v: number, d = 1) => r1(v * 1000, d)
const pct = (v: number) => r1(v * 100, 2)
const volMl = (m: Mesh) => r1(Math.abs(signedVolume(m)) * 1e6, 2)
const concatF = (arrays: Float32Array[]): Float32Array => {
  const out = new Float32Array(arrays.reduce((n, a) => n + a.length, 0))
  let o = 0
  for (const a of arrays) {
    out.set(a, o)
    o += a.length
  }
  return out
}
const union = (meshes: Mesh[]): Mesh => {
  const positions = concatF(meshes.map((m) => m.positions))
  const indices = new Uint32Array(meshes.reduce((n, m) => n + m.indices.length, 0))
  let vo = 0
  let io = 0
  for (const m of meshes) {
    for (let k = 0; k < m.indices.length; k++) indices[io + k] = m.indices[k]! + vo
    vo += m.positions.length / 3
    io += m.indices.length
  }
  return { positions, indices }
}
/** 网格最高（或最低）一段厚 `depth` 的层内顶点的质心。 / Centroid of the vertices in the top (or bottom) slab of thickness `depth`. */
function endCentroid(m: Mesh, end: 'top' | 'bottom', depth: number): Vec3 {
  const b = bboxOf(m)
  const pts = end === 'top' ? slabPoints(m, b[4] - depth, b[4]) : slabPoints(m, b[1], b[1] + depth)
  const c: Vec3 = [0, 0, 0]
  for (let i = 0; i < pts.length; i++) c[i % 3] = c[i % 3]! + pts[i]! / (pts.length / 3)
  return c
}
function nearestOn(m: Mesh, p: Vec3, spacing = 0.001): { point: Vec3; distance: number } {
  const ix = new PointIndex(surfaceSamples(m, spacing), 0.004)
  const I = new Int32Array(1)
  const D = new Float64Array(1)
  ix.nearest(p[0], p[1], p[2], 1, I, D)
  return { point: [ix.points[3 * I[0]!]!, ix.points[3 * I[0]! + 1]!, ix.points[3 * I[0]! + 2]!], distance: Math.sqrt(D[0]!) }
}
const moveMesh = (p: PelvisPart, f: (q: Float32Array) => Float32Array) => {
  p.mesh = { positions: f(p.mesh.positions), indices: p.mesh.indices }
  if (p.centrelines) p.centrelines = p.centrelines.map((l) => ({ points: f(l.points), radius: l.radius }))
}
/** 中空器官的“填实”检验所需的腔：壁 → 腔的条目名 / the lumina needed to test hollow organs as filled bodies: wall → lumen items */
const FILL: Record<string, string[]> = { WU_vaginal_wall: ['WU_uterine_and_vaginal_lumen'], WU_uterine_wall: ['WU_uterine_and_vaginal_lumen'], WU_smooth_muscle_of_rectum: ['WU_rectal_lumen'] }

interface Body {
  bbox: number[]
  contains(x: number, y: number, z: number): boolean
  surface: PointIndex
}
const bodyCache = new WeakMap<Mesh, Body>()
/**
 * 一个部件作为“填实的实体”：只取体积为正的连通分量（去掉朝向腔内的内表面），再并上它的腔。
 * A part as a filled body: only its connected components of positive volume (inner surfaces facing a
 * cavity are left out), united with its lumina.
 */
function bodyOf(p: PelvisPart, byId: Map<string, PelvisPart>): Body {
  const hit = bodyCache.get(p.mesh)
  if (hit) return hit
  const comps = components(p.mesh)
  const outer = comps.length > 1 ? comps.filter((c) => signedVolume(c) > 0) : comps
  const fills = (FILL[p.id] ?? []).map((id) => byId.get(id)?.mesh).filter((m): m is Mesh => !!m)
  const testers = [...outer, ...fills].map((m) => new InsideTester(m, 96))
  const body: Body = {
    bbox: bboxOf(p.mesh),
    contains: (x, y, z) => testers.some((t) => t.contains(x, y, z)),
    surface: new PointIndex(thinPoints(surfacePoints(p.mesh, 0.0005), 0.0004), 0.002),
  }
  bodyCache.set(p.mesh, body)
  return body
}
/**
 * 让位：`p` 陷在 `solids`（按填实的实体计）里的顶点移到该实体表面上最近、且再往外 `clearance` 确在体外的
 * 一点之外；需要移动超过 `maxPush` 的顶点不动（会出现在重叠报告里）。贴合后 `p` 的这片表面顺着对方的
 * 表面走，是接触面，不是噪声。返回移动的顶点数。
 * Giving way: vertices of `p` sunk in `solids` (taken as filled bodies) move just beyond the nearest point
 * of that body's surface from which a further `clearance` is really outside; vertices that would have to
 * move more than `maxPush` stay (they show up in the overlap report). The patch of `p` then follows the
 * other surface — a contact face, not noise. Returns the number of vertices moved.
 */
export function slideOut(p: PelvisPart, solids: PelvisPart[], opts: { clearance: number; maxPush: number; maxEdge?: number; unfilled?: boolean; coherent?: boolean; margin?: number }, byId: Map<string, PelvisPart> = new Map()): number {
  const bb = bboxOf(p.mesh)
  const near = solids.filter((q) => q !== p && overlaps(bb, bboxOf(q.mesh), 0.002)).map((q) => bodyOf(q, opts.unfilled ? new Map() : byId))
  if (!near.length) return 0
  const inAny = (x: number, y: number, z: number) => near.some((b) => !(x < b.bbox[0]! || x > b.bbox[3]! || y < b.bbox[1]! || y > b.bbox[4]! || z < b.bbox[2]! || z > b.bbox[5]!) && (b.contains(x, y, z) || b.surface.distance(x, y, z, 0.0008) < 0.0008))
  // 先在重叠处把三角形加密：粗三角形的顶点都在体外时，它的面仍可能穿过对方
  // triangles are refined where the overlap is first: with all its vertices outside, the face of a coarse triangle can still pass through the other body
  const mesh = refineWhere(p.mesh, inAny, opts.maxEdge ?? 0.0008)
  const out = Float32Array.from(mesh.positions)
  // 出路在所有相邻实体的表面里找：夹在两层肌之间的结构不能从一层出来又进了另一层
  // the way out is sought on the surfaces of all the bodies at once: what lies between two muscle layers must not leave one only to enter the other
  // 只取并集的外表面：落在另一个实体之内的表面采样点不是出路
  // only the outer surface of the union: surface samples lying inside another body are no way out
  const cand: number[] = []
  for (const b of near) {
    const q = b.surface.points
    for (let i = 0; i < q.length; i += 3) {
      const x = q[i]!
      const y = q[i + 1]!
      const z = q[i + 2]!
      if (x < bb[0] - opts.maxPush || x > bb[3] + opts.maxPush || y < bb[1] - opts.maxPush || y > bb[4] + opts.maxPush || z < bb[2] - opts.maxPush || z > bb[5] + opts.maxPush) continue
      if (near.some((o) => o !== b && !(x < o.bbox[0]! || x > o.bbox[3]! || y < o.bbox[1]! || y > o.bbox[4]! || z < o.bbox[2]! || z > o.bbox[5]!) && o.contains(x, y, z))) continue
      cand.push(x, y, z)
    }
  }
  if (!cand.length) return 0
  const all = new PointIndex(Float32Array.from(cand), 0.002)
  const pad = opts.margin ?? 0
  // 带 `margin` 时，实体按向外膨胀 margin 计 / with `margin`, bodies count as dilated by it
  const inBody = (x: number, y: number, z: number) => near.some((b) => !(x < b.bbox[0]! - pad || x > b.bbox[3]! + pad || y < b.bbox[1]! - pad || y > b.bbox[4]! + pad || z < b.bbox[2]! - pad || z > b.bbox[5]! + pad) && (b.contains(x, y, z) || (pad > 0 && b.surface.distance(x, y, z, pad) < pad)))
  const K = 64
  const I = new Int32Array(K)
  const D = new Float64Array(K)
  let moved = 0
  if (opts.coherent) {
    // 整段一起出去：陷在实体里的顶点按网格连通性分成若干段，每一段选同一个方向（26 个方向中使全段都出去
    // 所需位移最小的那个），各顶点沿它走到出了所有实体为止。一条穿过器官中部的血管若各顶点各走最近的路，
    // 会从中间被撕开，两半各贴到器官的一面。
    // A stretch leaves together: the sunk vertices are grouped by mesh connectivity, each group takes ONE
    // direction (of 26, the one that gets the whole group out with the least travel) and every vertex
    // advances along it until it is outside every body. A vessel through the middle of an organ would be
    // torn in two, each half plastered on one face, if every vertex took its own nearest way.
    const nv = out.length / 3
    const sunk = new Uint8Array(nv)
    for (let v = 0; v < nv; v++) if (inBody(out[3 * v]!, out[3 * v + 1]!, out[3 * v + 2]!)) sunk[v] = 1
    const parent = Int32Array.from({ length: nv }, (_, k) => k)
    const find = (k: number): number => {
      while (parent[k] !== k) {
        parent[k] = parent[parent[k]!]!
        k = parent[k]!
      }
      return k
    }
    const idx = mesh.indices
    for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = idx[t + k]!
      const b = idx[t + ((k + 1) % 3)]!
      if (sunk[a] && sunk[b]) parent[find(a)] = find(b)
    }
    const groups = new Map<number, number[]>()
    for (let v = 0; v < nv; v++) if (sunk[v]) groups.set(find(v), [...(groups.get(find(v)) ?? []), v])
    const dirs: Vec3[] = []
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) if (a || b || c) {
      const l = Math.hypot(a, b, c)
      dirs.push([a / l, b / l, c / l])
    }
    const travel = (v: number, d: Vec3, step: number): number => {
      for (let t = step; t <= opts.maxPush; t += step) if (!inBody(out[3 * v]! + d[0] * t, out[3 * v + 1]! + d[1] * t, out[3 * v + 2]! + d[2] * t)) return t
      return Infinity
    }
    for (const list of groups.values()) {
      const sample = list.length <= 24 ? list : list.filter((_, k) => k % Math.ceil(list.length / 24) === 0)
      let best: Vec3 | null = null
      let bestCost = Infinity
      for (const d of dirs) {
        let cost = 0
        for (const v of sample) {
          cost = Math.max(cost, travel(v, d, 0.001))
          if (cost >= bestCost) break
        }
        if (cost < bestCost) {
          bestCost = cost
          best = d
        }
      }
      if (!best) continue
      for (const v of list) {
        const t = travel(v, best, 0.0003)
        if (!Number.isFinite(t)) continue
        out[3 * v] = out[3 * v]! + best[0] * (t + opts.clearance)
        out[3 * v + 1] = out[3 * v + 1]! + best[1] * (t + opts.clearance)
        out[3 * v + 2] = out[3 * v + 2]! + best[2] * (t + opts.clearance)
        moved++
      }
    }
  }
  for (let i = 0; i < out.length; i += 3) {
    const x = out[i]!
    const y = out[i + 1]!
    const z = out[i + 2]!
    if (!inBody(x, y, z)) continue
    if (pad > 0 && !near.some((b) => b.contains(x, y, z))) {
      // 在体外、但在膨胀层内：离表面太近时“背离最近采样点”的方向几乎与表面相切，所以改用占据梯度
      // （周围 26 个方向上 margin + 0.3 mm 处哪些在体内）给出的外法向，沿它退到层外
      // outside but within the dilated layer: this close to the surface "away from the nearest sample" is
      // almost tangential, so the outward normal is taken from the occupancy gradient (which of 26 points
      // at margin + 0.3 mm around lie in a body) and the vertex backs out of the layer along it
      const probe = pad + 0.0003
      let nx = 0
      let ny = 0
      let nz = 0
      for (let a = -1; a <= 1; a++) for (let b2 = -1; b2 <= 1; b2++) for (let c = -1; c <= 1; c++) {
        if (!a && !b2 && !c) continue
        const l = Math.hypot(a, b2, c)
        if (!near.some((b) => b.contains(x + (a / l) * probe, y + (b2 / l) * probe, z + (c / l) * probe))) continue
        nx -= a / l
        ny -= b2 / l
        nz -= c / l
      }
      const nl = Math.hypot(nx, ny, nz)
      if (nl > 1e-6) {
        for (let t = 0.0002; t <= 0.004; t += 0.0002) {
          if (inBody(x + (nx / nl) * t, y + (ny / nl) * t, z + (nz / nl) * t)) continue
          out[i] = x + (nx / nl) * t
          out[i + 1] = y + (ny / nl) * t
          out[i + 2] = z + (nz / nl) * t
          moved++
          break
        }
        continue
      }
    }
    // 逐步放大搜索半径 / the search radius grows step by step
    for (const reach of [0.003, 0.008, opts.maxPush]) {
      if (reach > opts.maxPush) continue
      const n = all.nearest(x, y, z, K, I, D, reach)
      let done = false
      for (let k = 0; k < n && !done; k++) {
        const d = Math.sqrt(D[k]!) || 1e-9
        // 在体内：越过最近的表面点；在体外但在膨胀层内：背离最近的表面点退到层外
        // inside: past the nearest surface point; outside but within the dilated layer: back away from the nearest surface point to beyond the layer
        const sx = all.points[3 * I[k]!]!
        const sy = all.points[3 * I[k]! + 1]!
        const sz = all.points[3 * I[k]! + 2]!
        const within = near.some((b) => b.contains(x, y, z))
        const e = within ? (d + opts.clearance + pad) / d : -(pad + 0.0002 - d) / d
        const ex = within ? x + (sx - x) * e : x + (sx - x) * e
        const ey = within ? y + (sy - y) * e : y + (sy - y) * e
        const ez = within ? z + (sz - z) * e : z + (sz - z) * e
        if (inBody(ex, ey, ez)) continue
        out[i] = ex
        out[i + 1] = ey
        out[i + 2] = ez
        moved++
        done = true
      }
      if (done) break
    }
  }
  p.mesh = { positions: out, indices: mesh.indices }
  return moved
}

/**
 * 局部加密：凡有一端满足 `where` 且长于 `maxEdge` 的边在中点处一分为二（最多四轮），相邻三角形按被分的
 * 边数相应细分，所以网格保持封闭、流形。
 * Local refinement: every edge longer than `maxEdge` with an end where `where` holds is split at its
 * midpoint (up to four rounds), and the triangles on it are subdivided according to how many of their
 * edges were split, so the mesh stays closed and manifold.
 */
export function refineWhere(mesh: Mesh, where: (x: number, y: number, z: number) => boolean, maxEdge: number): Mesh {
  let pos = Array.from(mesh.positions)
  let idx = Array.from(mesh.indices)
  for (let round = 0; round < 4; round++) {
    const nv = pos.length / 3
    const flag = new Uint8Array(nv)
    for (let v = 0; v < nv; v++) if (where(pos[3 * v]!, pos[3 * v + 1]!, pos[3 * v + 2]!)) flag[v] = 1
    const mid = new Map<number, number>()
    const midOf = (a: number, b: number): number => {
      const dx = pos[3 * a]! - pos[3 * b]!
      const dy = pos[3 * a + 1]! - pos[3 * b + 1]!
      const dz = pos[3 * a + 2]! - pos[3 * b + 2]!
      if (dx * dx + dy * dy + dz * dz <= maxEdge * maxEdge) return -1
      const key = a < b ? a * nv + b : b * nv + a
      let m = mid.get(key)
      if (m === undefined && !flag[a] && !flag[b]) {
        // 两端都在外面的长边仍可能从中间穿过：再查边上的三个点 / a long edge with both ends outside can still pass through: three points along it are tested too
        let hit = false
        for (const t of [0.25, 0.5, 0.75]) if (where(pos[3 * b]! + t * dx, pos[3 * b + 1]! + t * dy, pos[3 * b + 2]! + t * dz)) hit = true
        if (!hit) return -1
      }
      if (m === undefined) {
        m = pos.length / 3
        pos.push((pos[3 * a]! + pos[3 * b]!) / 2, (pos[3 * a + 1]! + pos[3 * b + 1]!) / 2, (pos[3 * a + 2]! + pos[3 * b + 2]!) / 2)
        mid.set(key, m)
      }
      return m
    }
    const next: number[] = []
    for (let t = 0; t < idx.length; t += 3) {
      const v = [idx[t]!, idx[t + 1]!, idx[t + 2]!]
      const m = [midOf(v[0]!, v[1]!), midOf(v[1]!, v[2]!), midOf(v[2]!, v[0]!)]
      const n = m.filter((x) => x >= 0).length
      if (n === 0) next.push(v[0]!, v[1]!, v[2]!)
      else if (n === 3) next.push(v[0]!, m[0]!, m[2]!, m[0]!, v[1]!, m[1]!, m[2]!, m[1]!, v[2]!, m[0]!, m[1]!, m[2]!)
      else if (n === 1) {
        const k = m.findIndex((x) => x >= 0)
        const a = v[k]!
        const b = v[(k + 1) % 3]!
        const c = v[(k + 2) % 3]!
        next.push(a, m[k]!, c, m[k]!, b, c)
      } else {
        // 未被分的那条边转到 c→a 的位置 / rotate so that the unsplit edge is c→a
        const k = (m.findIndex((x) => x < 0) + 1) % 3
        const a = v[k]!
        const b = v[(k + 1) % 3]!
        const c = v[(k + 2) % 3]!
        const mab = m[k]!
        const mbc = m[(k + 1) % 3]!
        next.push(mab, b, mbc, a, mab, mbc, a, mbc, c)
      }
    }
    if (!mid.size) break
    idx = next
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

const BOWEL_HANGERS = /colic|sigmoid|rectal|mesenteric|colon/i
const UTERUS_PARTS = /^HRA_(anterior_wall_of_uterus|posterior_wall_of_uterus|body_of_uterus|fundus_of_uterus|cervix|cornua|lower_uterine_segment)$/

/**
 * 把女性小骨盆协调成一个整体（方案 a）：Wu 的盆底、括约肌、会阴、尿道、阴道、肛门直肠、子宫和附件
 * 作为骨架不动（只解除它们彼此之间以及与骨之间的浅重叠）；她扫描得到的膀胱的颈部接到 Wu 尿道上端；
 * 形变来的乙状结肠接到 Wu 直肠上端并整体移开子宫和附件；形变来的输尿管接到膀胱；HRA 的盆腔韧带和
 * 子宫血管随 HRA 器官 → Wu 器官的对应关系移到新位置；其余形变来的软组织被推出这些器官。
 * 所有位移都是光滑的局部场或沿最近出路的滑移，没有逐顶点噪声。返回报告和应当去掉的部件 id。
 * Makes the female lesser pelvis one consistent whole (option a): the Wu pelvic floor, sphincters,
 * perineum, urethra, vagina, anorectum, uterus and adnexa are the backbone and stay (only shallow
 * overlaps among themselves and with bone are resolved); the neck of her scanned bladder is joined to
 * the top of the Wu urethra; the warped sigmoid colon is joined to the top of the Wu rectum and shifted
 * as a whole off the uterus and adnexa; the warped ureters are joined to the bladder; the HRA pelvic
 * ligaments and uterine vessels follow the correspondence HRA organs → Wu organs to their new place;
 * other warped soft tissue is slid out of these organs. Every displacement is a smooth local field or a
 * slide along the nearest way out; no per-vertex noise. Returns the report and the ids of parts to drop.
 */
export function reconcilePelvis(input: PelvisInput): { report: Record<string, unknown>; drop: Set<string> } {
  const { parts, extras } = input
  const log = input.log ?? (() => {})
  const report: Record<string, unknown> = {}
  const drop = new Set<string>()
  const byId = new Map(parts.map((p) => [p.id, p]))
  const wu = parts.filter((p) => p.id.startsWith('WU_')).sort((a, b) => wuRank(a.id) - wuRank(b.id) || sideRank(a.id) - sideRank(b.id))
  if (!wu.length) return { report, drop }
  const W = (k: string) => byId.get(`WU_${k}`)
  const bones = parts.filter((p) => HARD_TISSUES.includes(p.tissue) && /hip bone|Sacrum|Coccyx|femur|lumbar vertebra/i.test(p.name))
  const pelvicBones = bones.filter((p) => /hip bone|Sacrum|Coccyx/i.test(p.name))
  const bladder = parts.find((p) => p.name === 'Urinary bladder')
  const vagina = W('vaginal_wall')!
  const uterus = W('uterine_wall')!
  const rectum = W('smooth_muscle_of_rectum')!
  const urethra = W('submucous_layer_of_urethra')!
  const wuSolid = () => wu.filter((p) => p.tissue !== 'space')
  const region = (() => {
    const b = wu.map((p) => bboxOf(p.mesh)).reduce((a, c) => [Math.min(a[0]!, c[0]), Math.min(a[1]!, c[1]), Math.min(a[2]!, c[2]), Math.max(a[3]!, c[3]), Math.max(a[4]!, c[4]), Math.max(a[5]!, c[5])], [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
    return b as number[]
  })()

  // ── 0. 两种方案的数值对比（在任何改动之前） / the two options in numbers (before anything is changed)
  {
    const hra = new Map(input.hraReplaced.map((p) => [p.id, p]))
    const hv = hra.get('HRA_vagina')
    const options: Record<string, unknown> = {}
    if (hv) {
      // (b) 保留 HRA 阴道：它与 Wu 盆底各结构的重叠，以及它距 Wu 阴道（即盆底为阴道留出的通道）多远
      // (b) keeping the HRA vagina: its overlap with the Wu pelvic-floor structures, and how far it is from the Wu vagina (the passage the floor leaves for it)
      const ins: Record<string, number> = {}
      for (const p of wuSolid()) {
        if (p === vagina || p === uterus || /lumen|ovary|tube|round/.test(p.id)) continue
        if (!overlaps(bboxOf(hv.mesh), bboxOf(p.mesh))) continue
        const f = insideFraction(hv.mesh, p.mesh)
        if (f > 0.005) ins[p.id] = pct(f)
      }
      let covered = 0
      {
        // HRA 阴道表面落在任一 Wu 实体内的比例 / share of the HRA vaginal surface inside any Wu solid
        const pts = surfaceSamples(hv.mesh)
        const testers = wuSolid().filter((p) => p !== vagina && p !== uterus && !/lumen|ovary|tube|round/.test(p.id) && overlaps(bboxOf(hv.mesh), bboxOf(p.mesh))).map((p) => new InsideTester(p.mesh, 96))
        for (let i = 0; i < pts.length; i += 3) if (testers.some((t) => t.contains(pts[i]!, pts[i + 1]!, pts[i + 2]!))) covered++
        covered /= pts.length / 3
      }
      const ch = centroidOf(hv.mesh)
      const cw = centroidOf(vagina.mesh)
      const lowH = endCentroid(hv.mesh, 'bottom', 0.015)
      const lowU = endCentroid(urethra.mesh, 'bottom', 0.015)
      const lowW = endCentroid(vagina.mesh, 'bottom', 0.015)
      options.b = {
        what: 'keep the HRA uterus and vagina and her scanned bladder, relax them into the Wu pelvic floor',
        hraVaginaSurfaceInsideWuStructuresPct: pct(covered),
        hraVaginaInsidePct: ins,
        hraVaginaInsideScannedBladderPct: bladder ? pct(insideFraction(hv.mesh, bladder.mesh)) : null,
        hraVaginaCentroidFromWuVaginaMm: mmOf(Math.hypot(ch[0] - cw[0], ch[1] - cw[1], ch[2] - cw[2])),
        hraVaginaLowerEndFromWuUrethraLowerEndMm: mmOf(Math.hypot(lowH[0] - lowU[0], lowH[2] - lowU[2])),
        hraVaginaLowerEndFromWuVaginaLowerEndMm: mmOf(Math.hypot(lowH[0] - lowW[0], lowH[2] - lowW[2])),
        verdict: 'the HRA vagina lies where the Wu urethra and its sphincter are; relaxing it into the floor means moving it to where the Wu vagina already is',
      }
    }
    const hu = input.hraReplaced.filter((p) => UTERUS_PARTS.test(p.id))
    if (hu.length) {
      // (a) 两种子宫：HRA 子宫接到 Wu 阴道上，或用 Wu 自己的子宫
      // (a) two uteri: the HRA uterus joined to the Wu vagina, or Wu's own uterus
      const hraU = union(hu.map((p) => p.mesh))
      const axisOf = (m: Mesh) => axisParam(surfaceSamples(m, 0.003))
      const angle = (a: Vec3, b: Vec3) => r1((Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI)
      const forward = (a: Vec3) => r1((Math.atan2(a[2], a[1]) * 180) / Math.PI)
      const vagAxis = axisOf(vagina.mesh).axis
      const cervix = hra.get('HRA_cervix')
      const vTop = endCentroid(vagina.mesh, 'top', 0.01)
      const describe = (m: Mesh, lower: Vec3) => {
        const ax = axisOf(m).axis
        const c = centroidOf(m)
        const sac = pelvicBones.find((p) => p.name === 'Sacrum')
        return {
          volumeMl: volMl(m),
          centroidMm: c.map((v) => mmOf(v, 0)),
          axisForwardTiltDeg: forward(ax),
          angleToVaginalAxisDeg: angle(ax, vagAxis),
          lowerEndToTopOfWuVaginaMm: mmOf(Math.hypot(lower[0] - vTop[0], lower[1] - vTop[1], lower[2] - vTop[2])),
          gapToWuVaginaMm: mmOf(minGap(m, vagina.mesh, 0.0015)),
          insideWuVaginaPct: pct(insideFraction(m, vagina.mesh)),
          insideWuRectumPct: pct(insideFraction(m, rectum.mesh)),
          insideScannedBladderPct: bladder ? pct(insideFraction(m, bladder.mesh)) : null,
          gapToScannedBladderMm: bladder ? mmOf(minGap(m, bladder.mesh, 0.0015)) : null,
          gapToSacrumMm: sac ? mmOf(minGap(m, sac.mesh, 0.002)) : null,
        }
      }
      const ovary = (m: Mesh | undefined, side: 'L' | 'R') => {
        if (!m) return null
        const wall = parts.filter((p) => (p.name === `${side === 'L' ? 'Left' : 'Right'} hip bone` || p.name === `${side === 'L' ? 'Left' : 'Right'} obturator internus`))
        return { volumeMl: volMl(m), centroidMm: centroidOf(m).map((v) => mmOf(v, 0)), gapToLateralPelvicWallMm: wall.length ? mmOf(Math.min(...wall.map((w) => minGap(m, w.mesh, 0.002)))) : null }
      }
      options.a = {
        what: 'Wu vagina, urethra and anorectum as they are; uterus and adnexa either HRA (joined at the cervix) or Wu\'s own',
        hraUterus: describe(hraU, cervix ? endCentroid(cervix.mesh, 'bottom', 0.005) : endCentroid(hraU, 'bottom', 0.005)),
        wuUterus: describe(uterus.mesh, endCentroid(uterus.mesh, 'bottom', 0.005)),
        hraOvaries: { left: ovary(hra.get('HRA_left_ovary')?.mesh, 'L'), right: ovary(hra.get('HRA_right_ovary')?.mesh, 'R') },
        wuOvaries: { left: ovary(W('ovary_L')?.mesh, 'L'), right: ovary(W('ovary_R')?.mesh, 'R') },
        chosen: 'Wu uterus, tubes, ovaries and round ligaments',
        why: 'the Wu uterus is continuous with the Wu vagina (one reconstruction of one woman); the HRA uterus would have to be moved by the distance given under lowerEndToTopOfWuVaginaMm and reshaped at the fornix to meet it, and its ovaries are a tenth of the volume of real ones. The HRA ligaments and uterine vessels, which Wu lacks, are kept and carried to the Wu organs.',
      }
    }
    report.options = options
  }

  // ── 1. Wu 结构与骨：配准误差使附着处略微陷入骨内，推出 / Wu structures against bone: registration error sinks attachments slightly into bone; slid out
  const volBefore = new Map(wu.map((p) => [p.id, volMl(p.mesh)]))
  const insideBoneBefore: Record<string, number> = {}
  {
    for (const p of wu) {
      const near = bones.filter((b) => overlaps(bboxOf(p.mesh), bboxOf(b.mesh)))
      if (!near.length) continue
      let f = 0
      for (const b of near) f += insideFraction(p.mesh, b.mesh)
      if (f > 0.002) insideBoneBefore[p.id] = pct(f)
      if (f > 0) slideOut(p, near, { clearance: 0.0003, maxPush: 0.008 }, byId)
    }
  }

  // ── 2. Wu 结构彼此之间：作者分别平滑的相邻表面有浅重叠，按 WU_PRIORITY 让位 / among the Wu structures: neighbouring surfaces smoothed separately overlap shallowly; they give way by WU_PRIORITY
  const pairTable = (list: PelvisPart[]) => {
    const rows: { a: string; b: string; insidePct: number }[] = []
    const bb = list.map((p) => bboxOf(p.mesh))
    const tester = new Map<PelvisPart, InsideTester>()
    for (let i = 0; i < list.length; i++) {
      const pts = surfaceSamples(list[i]!.mesh, 0.0015)
      for (let j = 0; j < list.length; j++) {
        if (i === j || list[j]!.tissue === 'space' || !overlaps(bb[i]!, bb[j]!)) continue
        let t = tester.get(list[j]!)
        if (!t) tester.set(list[j]!, (t = new InsideTester(list[j]!.mesh, 96)))
        const f = t.fractionInside(pts)
        if (f > 0) rows.push({ a: list[i]!.id, b: list[j]!.id, insidePct: pct(f) })
      }
    }
    return rows.sort((x, y) => y.insidePct - x.insidePct)
  }
  const summary = (rows: { insidePct: number }[]) => ({ pairsOverlapping: rows.length, over1pct: rows.filter((r) => r.insidePct > 1).length, maxPct: rows[0]?.insidePct ?? 0, meanPct: rows.length ? r1(rows.reduce((s, r) => s + r.insidePct, 0) / rows.length, 2) : 0 })
  const wuBefore = pairTable(wu.filter((p) => p.tissue !== 'space'))
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < wu.length; i++) {
      const p = wu[i]!
      // 腔本来就在器官之内，保持作者给出的形状 / lumina lie inside their organs by nature and keep the shape the authors gave them
      if (p.tissue === 'space') continue
      // 子宫颈本来就突入阴道穹窿：子宫对阴道只按壁的实质让位，不按填实的阴道
      // the cervix belongs inside the vaginal vault: the uterus gives way to the tissue of the vaginal wall only, not to the vagina as a filled body
      slideOut(p, wu.slice(0, i).filter((q) => q.tissue !== 'space'), { clearance: 0.0005, maxPush: 0.008, unfilled: p === uterus }, byId)
    }
  }
  // 中空器官的壁之间留出 1 mm：直肠对阴道、子宫对直肠（尿道与阴道前壁本来就长在一起，不分开）
  // 1 mm is kept between the walls of hollow organs: rectum against vagina, uterus against rectum (the urethra is fused with the anterior vaginal wall by nature and is not separated)
  slideOut(rectum, [vagina], { clearance: 0.001, maxPush: 0.008, margin: 0.001 }, byId)
  slideOut(uterus, [rectum], { clearance: 0.001, maxPush: 0.008, margin: 0.001 }, byId)
  // 让位之后再对骨查一遍 / once more against bone after the giving way
  for (const p of wu) {
    const near = bones.filter((b) => overlaps(bboxOf(p.mesh), bboxOf(b.mesh)))
    if (near.length && near.some((b) => insideFraction(p.mesh, b.mesh, 0.003) > 0)) slideOut(p, near, { clearance: 0.0003, maxPush: 0.008 }, byId)
  }
  const wuAfter = pairTable(wu.filter((p) => p.tissue !== 'space'))
  {
    const vol: Record<string, { beforeMl: number; afterMl: number }> = {}
    for (const p of wu) {
      const a = volMl(p.mesh)
      if (Math.abs(a - volBefore.get(p.id)!) > 0.05 * Math.max(0.2, volBefore.get(p.id)!)) vol[p.id] = { beforeMl: volBefore.get(p.id)!, afterMl: a }
    }
    report.wuOverlaps = { method: 'vertices sunk into a higher-priority structure (taken as a filled body) move just beyond the nearest point of its surface (0.5 mm clearance, at most 8 mm); order = WU_PRIORITY', insideBoneBeforePct: insideBoneBefore, before: { ...summary(wuBefore), worst: wuBefore.slice(0, 12) }, after: { ...summary(wuAfter), worst: wuAfter.slice(0, 12) }, volumeChangedMoreThan5pct: vol }
    log(`Wu structures among themselves: overlapping pairs ${wuBefore.length} → ${wuAfter.length}, above 1 % of surface ${summary(wuBefore).over1pct} → ${summary(wuAfter).over1pct}, worst ${summary(wuBefore).maxPct} % → ${summary(wuAfter).maxPct} %`)
  }

  // ── 3. 膀胱：大小和顶的位置取她的扫描，颈部接到 Wu 尿道上端 / bladder: size and dome from her scan, the neck joined to the top of the Wu urethra
  if (bladder) {
    const before = { volumeMl: volMl(bladder.mesh), bbox: bboxOf(bladder.mesh) }
    const top = endCentroid(urethra.mesh, 'top', 0.003)
    const near0 = nearestOn(bladder.mesh, top)
    // 膀胱上离尿道上端最近的一点移到尿道上端之上 0.5 mm 处；σ = 12 mm 的光滑场，膀胱顶基本不动
    // the point of the bladder nearest the top of the urethra goes to 0.5 mm above it; a smooth field with σ = 12 mm, the dome hardly moves
    // 拉出的漏斗使体积增大：绕膀胱顶点均匀缩放把体积调回，再补拉一次，反复三轮
    // the funnel this draws out adds volume: a uniform scaling about the apex of the dome restores it, then the neck is pulled again; three rounds
    const apex = endCentroid(bladder.mesh, 'top', 0.002)
    const v0 = Math.abs(signedVolume(bladder.mesh))
    const closest = (a: Mesh, b: Mesh): { pa: Vec3; pb: Vec3; d: number } => {
      const ix = new PointIndex(surfaceSamples(b, 0.001), 0.004)
      const pa = surfaceSamples(a, 0.001)
      const I = new Int32Array(1)
      const D = new Float64Array(1)
      let best = { pa: [0, 0, 0] as Vec3, pb: [0, 0, 0] as Vec3, d: Infinity }
      for (let i = 0; i < pa.length; i += 3) {
        if (!ix.nearest(pa[i]!, pa[i + 1]!, pa[i + 2]!, 1, I, D, best.d)) continue
        if (Math.sqrt(D[0]!) < best.d) best = { pa: [pa[i]!, pa[i + 1]!, pa[i + 2]!], pb: [ix.points[3 * I[0]!]!, ix.points[3 * I[0]! + 1]!, ix.points[3 * I[0]! + 2]!], d: Math.sqrt(D[0]!) }
      }
      return best
    }
    const baseGap0 = closest(bladder.mesh, vagina.mesh).d
    for (let round = 0; round < 3; round++) {
      const near = round === 0 ? near0 : nearestOn(bladder.mesh, top)
      // 膀胱底靠在阴道前壁上：底上离阴道最近的一点拉到距阴道 2 mm 处 / the base rests on the anterior vaginal wall: its point nearest the vagina is drawn to 2 mm from it
      const base = closest(bladder.mesh, vagina.mesh)
      const controls = [{ from: near.point, to: [top[0], top[1] + 0.0005, top[2]] as Vec3, sigma: 0.012 }]
      if (base.d > 0.0025 && Math.hypot(base.pa[0] - near.point[0], base.pa[1] - near.point[1], base.pa[2] - near.point[2]) > 0.008) controls.push({ from: base.pa, to: [base.pb[0] + ((base.pa[0] - base.pb[0]) / base.d) * 0.002, base.pb[1] + ((base.pa[1] - base.pb[1]) / base.d) * 0.002, base.pb[2] + ((base.pa[2] - base.pb[2]) / base.d) * 0.002], sigma: 0.012 })
      moveMesh(bladder, pullField(controls))
      const k = Math.cbrt(v0 / Math.abs(signedVolume(bladder.mesh)))
      if (round < 2) moveMesh(bladder, (q) => Float32Array.from(q, (v, i) => apex[i % 3]! + k * (v - apex[i % 3]!)))
    }
    const insideBefore = Object.fromEntries(wuSolid().filter((p) => overlaps(bboxOf(bladder.mesh), bboxOf(p.mesh))).map((p) => [p.id, pct(insideFraction(p.mesh, bladder.mesh))]).filter(([, f]) => (f as number) > 0))
    // 膀胱是空瘪的软器官：陷入 Wu 结构的壁面让位（1 mm 间隙）
    // the bladder is an empty, soft organ: its wall gives way where it is sunk into Wu structures (1 mm gap)
    slideOut(bladder, wuSolid(), { clearance: 0.001, maxPush: 0.01 }, byId)
    slideOut(bladder, wuSolid(), { clearance: 0.001, maxPush: 0.01 }, byId)
    const dome = bboxOf(bladder.mesh)
    report.bladder = {
      method: 'her scanned bladder kept for size and dome; the point of its wall nearest the top of the Wu urethra pulled onto it, and the point of its base nearest the Wu vagina drawn to 2 mm from the anterior vaginal wall, by Gaussian fields (σ 12 mm), the volume restored by a uniform scaling about the apex of the dome (three rounds); wall then slid out of Wu structures (1 mm gap)',
      baseToVaginaMm: { before: mmOf(baseGap0), after: mmOf(minGap(bladder.mesh, vagina.mesh, 0.001)) }, neckToUrethraBeforeMm: mmOf(near0.distance), neckToUrethraAfterMm: mmOf(nearestOn(bladder.mesh, top).distance), neckMovedMm: mmOf(Math.hypot(top[0] - near0.point[0], top[1] - near0.point[1], top[2] - near0.point[2])),
      volumeMl: { before: before.volumeMl, after: volMl(bladder.mesh) }, domeTopMovedMm: mmOf(Math.abs(dome[4] - before.bbox[4])), wuSurfaceInsideBladderBeforeSlidePct: insideBefore,
      wuBladderForComparison: extras.get('bladder_wall') ? { note: 'not shipped', lumenMl: extras.get('bladder_and_urethral_lumen') ? volMl(extras.get('bladder_and_urethral_lumen')!) : null, centroidOffsetFromHersMm: centroidOf(extras.get('bladder_wall')!).map((v, k) => mmOf(v - centroidOf(bladder.mesh)[k]!)) } : null,
    }
    log(`Bladder: neck ${mmOf(near0.distance)} mm from the top of the Wu urethra → ${(report.bladder as { neckToUrethraAfterMm: number }).neckToUrethraAfterMm} mm; volume ${before.volumeMl} → ${volMl(bladder.mesh)} ml`)
  }

  // ── 4. HRA 的盆腔韧带和子宫血管：随 HRA 器官 → Wu 器官的对应关系走 / HRA pelvic ligaments and uterine vessels follow the correspondence HRA organs → Wu organs
  {
    const hra = new Map(input.hraReplaced.map((p) => [p.id, p]))
    const kept = parts.filter((p) => p.id.startsWith('HRA_') && (p.system === 'reproductive' || p.system === 'cardiovascular'))
    const from: Float32Array[] = []
    const to: Float32Array[] = []
    const fits: Record<string, unknown> = {}
    const pair = (name: string, src: Mesh[], dst: Mesh | undefined, mode: 'icp' | 'centroid') => {
      if (!src.length || !dst) return
      const s = union(src)
      const pts = surfaceSamples(s, 0.004)
      let moved: Float32Array
      if (mode === 'icp') {
        const res = icp(surfaceSamples(s, 0.003), new PointIndex(surfaceSamples(dst, 0.002), 0.006), { maxIterations: 60, scale: true })
        moved = applyRigid(res.transform, pts)
        const t = res.transform as Rigid
        fits[name] = { method: 'similarity ICP', rmsMm: mmOf(res.rms), scale: r1(Math.cbrt(Math.abs(t.r[0]! * (t.r[4]! * t.r[8]! - t.r[5]! * t.r[7]!) - t.r[1]! * (t.r[3]! * t.r[8]! - t.r[5]! * t.r[6]!) + t.r[2]! * (t.r[3]! * t.r[7]! - t.r[4]! * t.r[6]!))), 2) }
      } else {
        const a = centroidOf(s)
        const b = centroidOf(dst)
        const k = Math.min(2.5, Math.max(0.6, Math.cbrt(Math.abs(signedVolume(dst)) / Math.max(1e-9, Math.abs(signedVolume(s))))))
        moved = Float32Array.from(pts, (v, i) => b[i % 3]! + k * (v - a[i % 3]!))
        fits[name] = { method: 'centroid and volume', shiftMm: mmOf(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])), scale: r1(k, 2) }
      }
      from.push(pts)
      to.push(moved)
    }
    const hraOf = (rx: RegExp) => [...hra.values()].filter((p) => rx.test(p.id)).map((p) => p.mesh)
    pair('uterus', hraOf(UTERUS_PARTS), uterus.mesh, 'icp')
    pair('left ovary', hraOf(/^HRA_left_ovary$/), W('ovary_L')?.mesh, 'centroid')
    pair('right ovary', hraOf(/^HRA_right_ovary$/), W('ovary_R')?.mesh, 'centroid')
    pair('left uterine tube', hraOf(/^HRA_.*(uterine_tube|fallopian_tube).*_L$/), W('uterine_tube_L')?.mesh, 'centroid')
    pair('right uterine tube', hraOf(/^HRA_.*(uterine_tube|fallopian_tube).*_R$/), W('uterine_tube_R')?.mesh, 'centroid')
    pair('vagina', hraOf(/^HRA_vagina$/), vagina.mesh, 'centroid')
    if (from.length && kept.length) {
      // 盆壁不动：韧带在盆壁一侧的附着留在原处 / the pelvic wall stays: ligament attachments on the wall remain where they are
      const wall = thinPoints(concatF(pelvicBones.map((b) => surfaceSamples(b.mesh, 0.008))), 0.008)
      from.push(wall)
      to.push(wall)
      const field = buildDeformation(concatF(from), concatF(to), { minSigma: 0.012, k: 32 })
      const organOf = (id: string): PelvisPart[] => (/mesosalpinx/.test(id) ? [W(`uterine_tube_${id.slice(-1)}`)!] : /mesovarium|ovarian_ligament|suspensory/.test(id) ? [W(`ovary_${id.slice(-1)}`)!] : [uterus, vagina]).filter(Boolean)
      const solids = [...wuSolid(), ...(bladder ? [bladder] : []), ...pelvicBones]
      const rows: Record<string, unknown>[] = []
      for (const p of kept) {
        const areaBefore = measure(p.mesh).area
        const cBefore = centroidOf(p.mesh)
        moveMesh(p, (q) => field.apply(q))
        const insideBefore = solids.filter((q) => overlaps(bboxOf(p.mesh), bboxOf(q.mesh))).reduce((sum, q) => sum + insideFraction(p.mesh, q.mesh, 0.003), 0)
        slideOut(p, solids, { clearance: 0.0005, maxPush: 0.02, maxEdge: 0.0015, coherent: true }, byId)
        const insideAfter = solids.filter((q) => overlaps(bboxOf(p.mesh), bboxOf(q.mesh))).reduce((sum, q) => sum + insideFraction(p.mesh, q.mesh, 0.003), 0)
        const reach = Math.min(...organOf(p.id).map((o) => minGap(p.mesh, o.mesh, 0.002)))
        const c = centroidOf(p.mesh)
        const areaRatio = measure(p.mesh).area / Math.max(1e-12, areaBefore)
        // 放得不可信的不输出：仍有较多表面在器官或骨内、够不到它所连的器官、或被拉伸得过分
        // not shipped when implausibly placed: much surface still inside organs or bone, not reaching the organ it belongs to, or stretched too far
        const ok = insideAfter <= 0.05 && reach <= 0.006 && areaRatio > 0.4 && areaRatio < 2.5
        rows.push({ id: p.id, movedMm: mmOf(Math.hypot(c[0] - cBefore[0], c[1] - cBefore[1], c[2] - cBefore[2])), insideSolidsPct: { before: pct(insideBefore), after: pct(insideAfter) }, gapToItsOrganMm: mmOf(reach), areaRatio: r1(areaRatio, 2), shipped: ok })
      }
      // 成对的结构一侧不合格时两侧都不输出 / of a pair, both sides go when one fails
      const twin = (id: string) => (/_L$/.test(id) ? id.replace(/_L$/, '_R') : /_R$/.test(id) ? id.replace(/_R$/, '_L') : /left/.test(id) ? id.replace('left', 'right') : id.replace('right', 'left'))
      for (const r of rows) if (!r.shipped) for (const o of rows) if (o.id === twin(r.id as string) && o.shipped) Object.assign(o, { shipped: false, reason: 'its twin on the other side failed' })
      for (const r of rows) if (!r.shipped) drop.add(r.id as string)
      report.hraLigaments = { method: 'smooth field from the correspondences HRA organ → Wu organ (uterus: similarity ICP; ovaries, tubes, vagina: centroid and volume) with the pelvic bones held fixed; then slid out of Wu organs, bladder and bone (≤ 15 mm); dropped unless ≤ 5 % of the surface is inside a solid, the part comes within 6 mm of the organ it belongs to and its area changed by less than 2.5×; of a pair both sides are dropped when one fails', fits, parts: rows, dropped: rows.filter((r) => !r.shipped).map((r) => r.id) }
      log(`HRA ligaments and uterine vessels carried to the Wu organs: ${rows.filter((r) => r.shipped).length} kept, ${rows.filter((r) => !r.shipped).length} dropped (${rows.filter((r) => !r.shipped).map((r) => r.id).join(', ') || 'none'})`)
    }
  }

  // ── 5. 肠管：乙状结肠下端接到 Wu 直肠上端，再整体移开子宫和附件 / bowel: the lower end of the sigmoid colon joined to the top of the Wu rectum, then shifted as a whole off the uterus and adnexa
  const bowelAll = () => parts.filter((p) => p.provenance === 'warped' && p.system === 'digestive' && p.tissue !== 'tooth' && !drop.has(p.id))
  const bowelSolid = () => bowelAll().filter((p) => p.tissue === 'organ' && overlaps(bboxOf(p.mesh), region, 0.05))
  const hangers = () => parts.filter((p) => p.provenance === 'warped' && p.system !== 'digestive' && BOWEL_HANGERS.test(p.name))
  const moveBowel = (f: (q: Float32Array) => Float32Array) => {
    for (const p of [...bowelAll(), ...hangers()]) if (overlaps(bboxOf(p.mesh), region, 0.12)) moveMesh(p, f)
  }
  const colon = parts.find((p) => p.name === 'Descending colon' && p.provenance === 'warped')
  let junction: Vec3 | null = null
  {
    const maleRectum = extras.get('male_rectum')
    const row: Record<string, unknown> = {}
    if (maleRectum && colon) {
      const volBeforeMl = volMl(colon.mesh)
      // 乙状结肠的下端：结肠表面上离（已去掉的）男性直肠上端最近的一带
      // the lower end of the sigmoid: the band of the colon's surface nearest the top of the (removed) male rectum
      const mTop = endCentroid(maleRectum, 'top', 0.008)
      const end = nearestOn(colon.mesh, mTop, 0.002)
      const wTop = endCentroid(rectum.mesh, 'top', 0.004)
      const lumen = W('rectal_lumen')
      const target: Vec3 = lumen ? endCentroid(lumen.mesh, 'top', 0.004) : wTop
      // 结肠末端的管心：末端附近表面点的质心 / the centre of the tube at its end: centroid of surface points near the end
      const ix = surfaceSamples(colon.mesh, 0.002)
      const c: Vec3 = [0, 0, 0]
      let n = 0
      for (let i = 0; i < ix.length; i += 3) {
        if (Math.hypot(ix[i]! - end.point[0], ix[i + 1]! - end.point[1], ix[i + 2]! - end.point[2]) > 0.02) continue
        c[0] += ix[i]!
        c[1] += ix[i + 1]!
        c[2] += ix[i + 2]!
        n++
      }
      const centre: Vec3 = [c[0] / n, c[1] / n, c[2] / n]
      // 管心放在 Wu 直肠（腔）上端之上 12 mm：这个管心是末端 20 mm 范围内表面点的质心，离末端的盖约 10 mm
      // the tube centre goes 12 mm above the top of the Wu rectum (lumen): it is the centroid of surface points within 20 mm of the end, about 10 mm from the end cap
      const to: Vec3 = [target[0], target[1] + 0.012, target[2]]
      const shift = Math.hypot(to[0] - centre[0], to[1] - centre[1], to[2] - centre[2])
      moveBowel(pullField([{ from: centre, to, sigma: Math.max(0.03, 0.8 * shift) }]))
      junction = to
      Object.assign(row, { method: 'Gaussian translation field centred on the lower end of the warped sigmoid colon (σ = max(30 mm, 0.8 × shift)), applied to all warped bowel and the vessels and nodes hanging on it', lowerEndOfSigmoidMovedMm: mmOf(shift), maleRectumTopToWuRectumTopMm: mmOf(Math.hypot(mTop[0] - wTop[0], mTop[1] - wTop[1], mTop[2] - wTop[2])), colonVolumeMl: { before: volBeforeMl, afterJoin: volMl(colon.mesh) } })
    }
    report.rectosigmoid = row
  }
  {
    const shifts: Record<string, unknown>[] = []
    const obstacles = [...pelvicBones, ...parts.filter((p) => HARD_TISSUES.includes(p.tissue) && /lumbar vertebra/i.test(p.name)), ...(bladder ? [bladder] : []), rectum].map((p) => new InsideTester(p.mesh, 64))
    const groups: [string, PelvisPart[]][] = [
      ['left adnexa', [W('ovary_L'), W('uterine_tube_L'), W('round_ligament_of_uterus_L')].filter((p): p is PelvisPart => !!p)],
      ['right adnexa', [W('ovary_R'), W('uterine_tube_R'), W('round_ligament_of_uterus_R')].filter((p): p is PelvisPart => !!p)],
      ['uterus', [uterus]],
    ]
    const insideColon = () => Object.fromEntries(groups.map(([name, members]) => [name, colon ? pct(new InsideTester(colon.mesh, 96).fractionInside(concatF(members.map((p) => surfaceSamples(p.mesh))))) : 0]))
    const before = insideColon()
    for (let pass = 0; pass < 4; pass++) {
      const done = shifts.length
      for (const [name, members] of groups) {
        if (!members.length) continue
        const pts = concatF(members.map((p) => surfaceSamples(p.mesh)))
        const c: Vec3 = [0, 0, 0]
        for (let i = 0; i < pts.length; i++) c[i % 3] = c[i % 3]! + pts[i]! / (pts.length / 3)
        let ro = 0
        for (let i = 0; i < pts.length; i += 3) ro = Math.max(ro, Math.hypot(pts[i]! - c[0], pts[i + 1]! - c[1], pts[i + 2]! - c[2]))
        for (const container of bowelSolid()) {
          const insideBefore = new InsideTester(container.mesh, 96).fractionInside(pts)
          if (insideBefore < 0.01) continue
          // 以器官为中心的高斯平移场；在直肠乙状结肠交界处钉住（位移为零），不破坏对接
          // a Gaussian translation field centred on the organ; pinned (zero displacement) at the rectosigmoid junction so that the join survives
          const sigma = ro + 0.03
          const movedBy = (arr: Float32Array, d: number[], sft: number) => {
            const out = Float32Array.from(arr)
            for (let i = 0; i < out.length; i += 3) {
              let w = Math.exp(-((out[i]! - c[0]) ** 2 + (out[i + 1]! - c[1]) ** 2 + (out[i + 2]! - c[2]) ** 2) / (2 * sigma * sigma))
              if (junction) w *= 1 - Math.exp(-((out[i]! - junction[0]) ** 2 + (out[i + 1]! - junction[1]) ** 2 + (out[i + 2]! - junction[2]) ** 2) / (2 * 0.02 * 0.02))
              out[i] = out[i]! + d[0]! * sft * w
              out[i + 1] = out[i + 1]! + d[1]! * sft * w
              out[i + 2] = out[i + 2]! + d[2]! * sft * w
            }
            return out
          }
          const dirs: number[][] = []
          for (let a8 = 0; a8 < 8; a8++) {
            const ang = (a8 * Math.PI) / 4
            dirs.push([Math.cos(ang), 0, Math.sin(ang)], [Math.cos(ang) * 0.7, 0.7, Math.sin(ang) * 0.7])
          }
          dirs.push([0, 1, 0])
          let best: { d: number[]; shift: number; after: number; cost: number; inObstacle: number } | null = null
          for (const d of dirs) {
            let shift = 0
            let after = insideBefore
            while (after > 0.003 && shift < 0.07) {
              shift += 0.004
              after = new InsideTester({ positions: movedBy(container.mesh.positions, d, shift), indices: container.mesh.indices }, 96).fractionInside(pts)
            }
            const sp = surfaceSamples({ positions: movedBy(container.mesh.positions, d, shift), indices: container.mesh.indices }, 0.004)
            let inObstacle = 0
            for (const o of obstacles) inObstacle += o.fractionInside(sp)
            const cost = shift + 0.5 * inObstacle + 0.5 * after
            if (!best || cost < best.cost) best = { d, shift, after, cost, inObstacle }
          }
          moveBowel((q) => movedBy(q, best!.d, best!.shift))
          shifts.push({ organ: name, bowel: container.name, insideBeforePct: pct(insideBefore), insideAfterPct: pct(best!.after), shiftMm: mmOf(best!.shift, 0), direction: best!.d.map((v) => r1(v, 2)), bowelInBoneBladderOrRectumPct: pct(best!.inObstacle) })
        }
      }
      if (shifts.length === done) break
    }
    if (colon) (report.rectosigmoid as Record<string, unknown>).gapColonToWuRectumMm = mmOf(Math.min(minGap(colon.mesh, rectum.mesh, 0.002), W('rectal_lumen') ? minGap(colon.mesh, W('rectal_lumen')!.mesh, 0.002) : Infinity))
    report.bowel = { method: 'the bowel is a closed tube: it is shifted as a whole by Gaussian translation fields centred on the organ it contains (direction and size chosen to clear the organ at least cost), never by pushing its surface', adnexaAndUterusInsideColonPct: { before, after: insideColon() }, shifts, colonVolumeMl: colon ? volMl(colon.mesh) : null }
    log(`Bowel: joined to the Wu rectum (${JSON.stringify((report.rectosigmoid as { lowerEndOfSigmoidMovedMm?: number }).lowerEndOfSigmoidMovedMm ?? null)} mm), ${shifts.length} shifts off uterus and adnexa; inside the colon before → after ${JSON.stringify(before)} → ${JSON.stringify(insideColon())}`)
  }

  // ── 6. 其余形变来的软组织（血管、淋巴结、筋膜、输尿管、肠管表面的残余）：推出 Wu 实体和膀胱
  // ── 6. other warped soft tissue (vessels, nodes, fasciae, ureters, what is left of bowel surface): slid out of the Wu solids and the bladder
  {
    // 筋膜和直肠系膜不算实体：直肠上血管和直肠旁淋巴结本来就在直肠系膜之内
    // fasciae and the mesorectum are not solids here: the superior rectal vessels and pararectal nodes belong inside the mesorectum
    const solids = [...wuSolid().filter((p) => p.tissue !== 'fascia'), ...(bladder ? [bladder] : [])]
    const rows: { id: string; name: string; beforePct: number; afterPct: number; note?: string }[] = []
    const frac = (p: PelvisPart) => {
      const near = solids.filter((q) => overlaps(bboxOf(p.mesh), bboxOf(q.mesh)))
      if (!near.length) return 0
      const pts = surfaceSamples(p.mesh, 0.003)
      let n = 0
      const testers = near.map((q) => new InsideTester(q.mesh, 96))
      for (let i = 0; i < pts.length; i += 3) if (testers.some((t) => t.contains(pts[i]!, pts[i + 1]!, pts[i + 2]!))) n++
      return n / Math.max(1, pts.length / 3)
    }
    for (const p of parts) {
      if (p.provenance !== 'warped' || !/^W_/.test(p.id) || drop.has(p.id) || p.tissue === 'skin' || p.tissue === 'fat' || HARD_TISSUES.includes(p.tissue) || p.tissue === 'nerve') continue
      if (!overlaps(bboxOf(p.mesh), region)) continue
      const before = frac(p)
      if (before < 0.002) continue
      // 肠管是封闭的管：只整体平移（上一步），不推它的表面 / the bowel is a closed tube: shifted as a whole (previous step), its surface is never pushed
      const tube = p.system === 'digestive' && p.tissue === 'organ'
      if (!tube) slideOut(p, solids, { clearance: 0.0005, maxPush: 0.03, maxEdge: 0.0015, coherent: true }, byId)
      rows.push({ id: p.id, name: p.name, beforePct: pct(before), afterPct: pct(frac(p)), ...(tube ? { note: 'bowel: not pushed' } : {}) })
    }
    rows.sort((a, b) => b.afterPct - a.afterPct)
    // 推出之后仍有五分之一以上表面在这些器官之内的形变部件放不进女性盆腔（如男性的“膀胱后淋巴结”正落在子宫的位置）：不输出，成对的两侧都去掉
    // a warped part with a fifth or more of its surface still inside these organs has no place in the female pelvis (the male "postvesical nodes" sit where the uterus is): not shipped, and of a pair both sides go
    const gone: string[] = []
    for (const r of rows) {
      if (r.afterPct < 20 || r.note) continue
      const twinName = /^Left /.test(r.name) ? r.name.replace(/^Left /, 'Right ') : /^Right /.test(r.name) ? r.name.replace(/^Right /, 'Left ') : null
      for (const q of parts) if (q.id === r.id || (twinName && q.name === twinName && q.provenance === 'warped' && /^W_/.test(q.id))) {
        drop.add(q.id)
        gone.push(q.name)
      }
    }
    report.warpedDropped = { rule: 'more than 20 % of the surface still inside Wu organs or the bladder after the slide-out (and its twin of the other side)', parts: gone }
    // 神经管由中心线重建，这里不动，只报告 / nerve tubes are rebuilt from centrelines and are not moved here, only reported
    const nerves = parts.filter((p) => p.tissue === 'nerve' && overlaps(bboxOf(p.mesh), region)).map((p) => ({ name: p.name, insidePct: pct(frac(p)) })).filter((r) => r.insidePct > 0.5).sort((a, b) => b.insidePct - a.insidePct)
    report.nervesInsideBackbone = { count: nerves.length, worst: nerves.slice(0, 10) }
    report.warpedAgainstBackbone = { parts: rows.length, meanBeforePct: rows.length ? r1(rows.reduce((s, r) => s + r.beforePct, 0) / rows.length, 2) : 0, meanAfterPct: rows.length ? r1(rows.reduce((s, r) => s + r.afterPct, 0) / rows.length, 2) : 0, rows }
    log(`Warped soft parts against the Wu backbone and bladder: ${rows.length} had surface inside; mean ${(report.warpedAgainstBackbone as { meanBeforePct: number }).meanBeforePct} % → ${(report.warpedAgainstBackbone as { meanAfterPct: number }).meanAfterPct} %; worst after: ${rows.slice(0, 5).map((r) => `${r.name} ${r.afterPct} %`).join(', ')}`)
  }

  // ── 7. 输尿管：下端接到膀胱后外侧壁 / ureters: the lower end joined to the posterolateral wall of the bladder
  if (bladder) {
    const rows: Record<string, unknown>[] = []
    for (const side of ['Left', 'Right']) {
      const u = parts.find((p) => p.name === `${side} ureter` && p.provenance === 'warped')
      if (!u) continue
      const volBeforeMl = volMl(u.mesh)
      const end = endCentroid(u.mesh, 'bottom', 0.004)
      // 目标：膀胱壁上离输尿管下端最近的一点（形变场已把输尿管带到她的膀胱附近）
      // target: the point of the bladder wall nearest the lower end of the ureter (the warp already brings the ureters close to her bladder)
      const t = nearestOn(bladder.mesh, end)
      const d = t.distance
      const gapBefore = minGap(u.mesh, bladder.mesh, 0.001)
      if (d > 0.001) moveMesh(u, pullField([{ from: end, to: t.point, sigma: Math.max(0.02, 0.8 * d) }]))
      slideOut(u, [...wuSolid()], { clearance: 0.0005, maxPush: 0.02, maxEdge: 0.0015, coherent: true }, byId)
      rows.push({ side, gapBeforeMm: mmOf(gapBefore), endMovedMm: mmOf(d), gapAfterMm: mmOf(minGap(u.mesh, bladder.mesh, 0.001)), volumeMl: { before: volBeforeMl, after: volMl(u.mesh) }, insideWuSolidsAfterPct: pct(wuSolid().filter((q) => overlaps(bboxOf(u.mesh), bboxOf(q.mesh))).reduce((sum, q) => sum + insideFraction(u.mesh, q.mesh), 0)) })
    }
    report.ureters = { method: 'Gaussian translation field centred on the lower end of each warped ureter (σ = max(20 mm, 0.8 × shift)), target the nearest point of the bladder wall; then slid out of Wu solids', rows }
    log(`Ureters joined to the bladder: ${rows.map((r) => `${r.side} moved ${r.endMovedMm} mm, gap ${r.gapAfterMm} mm`).join('; ')}`)
  }
  return { report, drop }
}

// ── 成品几何的数值检查 / numeric checks on the finished geometry ──────────────────────────────────────

export interface PelvisCheck {
  id: string
  pass: boolean
  measured: Record<string, unknown>
}

/** XZ 平面内一组点绕 (cx, cz) 的方位覆盖：12 个 30° 扇区中有点的个数。 / Angular coverage in the XZ plane round (cx, cz): how many of twelve 30° sectors hold a point. */
function sectors(points: number[], cx: number, cz: number): number {
  const seen = new Set<number>()
  for (let i = 0; i < points.length; i += 3) seen.add(Math.floor(((Math.atan2(points[i + 2]! - cz, points[i]! - cx) + Math.PI) / (2 * Math.PI)) * 12) % 12)
  return seen.size
}
const meanOf = (points: number[]): Vec3 | null => {
  if (!points.length) return null
  const c: Vec3 = [0, 0, 0]
  for (let i = 0; i < points.length; i++) c[i % 3] = c[i % 3]! + points[i]! / (points.length / 3)
  return c
}

/** 检查中“核心”结构：阴道、尿道、膀胱、直肠、肛门括约肌、尿道括约肌和肛提肌各部。 / The "core" structures of the checks: vagina, urethra, bladder, rectum, anal and urethral sphincters and the levator parts. */
export const PELVIS_CORE = /^(WU_(vaginal_wall|submucous_layer_of_urethra|smooth_muscle_of_rectum|internal_anal_sphincter|external_anal_sphincter|urethral_sphincter_proper|puborectal_muscle_.*|pubovisceral_muscle_.*|coccygeal_muscle_.*|uterine_wall)|VF_urinary_bladder)$/

/**
 * 对成品几何的盆腔检查。`get` 按部件 id 或名称取网格；`ids` 为全部部件 id。管线在输出前调用，
 * 测试则对解码后的 GLB 调用同一个函数。
 * Pelvic checks on finished geometry. `get` returns a mesh by part id or name; `ids` lists all part
 * ids. The pipeline calls it before writing; the tests call the same function on the decoded GLBs.
 */
export function pelvisChecks(get: (idOrName: string) => Mesh | null, ids: string[]): { checks: PelvisCheck[]; pairs: { a: string; b: string; insidePct: number }[]; gapsMm: Record<string, number> } {
  const checks: PelvisCheck[] = []
  const add = (id: string, pass: boolean, measured: Record<string, unknown>) => checks.push({ id, pass, measured })
  const M = (k: string) => get(`WU_${k}`)
  const wuIds = ids.filter((id) => id.startsWith('WU_'))
  const hipL = get('Left hip bone')
  const hipR = get('Right hip bone')
  const sacrum = get('Sacrum')
  const bladder = get('Urinary bladder')
  const pb = M('perineal_body')
  const xMid = pb ? centroidOf(pb)[0] : 0
  const band = (m: Mesh | null, y: number, h: number) => (m ? slabPoints(m, y - h, y + h) : [])
  const levator = wuIds.filter((id) => /^WU_(puborectal|pubovisceral)_muscle/.test(id)).map((id) => ({ id, mesh: get(id)! }))
  const vagina = M('vaginal_wall')
  const urethra = M('submucous_layer_of_urethra')
  const rectum = M('smooth_muscle_of_rectum')
  const ias = M('internal_anal_sphincter')
  const eas = M('external_anal_sphincter')
  const usp = M('urethral_sphincter_proper')
  const uterus = M('uterine_wall')

  // 1. 肛提肌裂孔 / levator hiatus
  if (levator.length && vagina && urethra && (rectum || ias) && hipL && hipR) {
    const sling = levator.filter((l) => /puborectal_muscle_deep/.test(l.id))
    const yc = sling.reduce((s, l) => s + centroidOf(l.mesh)[1], 0) / Math.max(1, sling.length)
    const H = 0.006
    const lev = levator.flatMap((l) => band(l.mesh, yc, H))
    const hull = hullXZ(lev)
    const cu = meanOf(band(urethra, yc, H))
    const cv = meanOf(band(vagina, yc, H))
    const ca = meanOf([...band(ias, yc, H), ...band(rectum, yc, H)])
    const inside = (c: Vec3 | null) => !!c && inHullXZ(hull, c[0], c[2])
    const xs = hull.map((h) => h[0])
    const zs = hull.map((h) => h[1])
    // 内径：阴道所在前后位置处左右肛提肌内侧缘之间的横径；耻骨联合后缘到直肠后方肌袢前缘的前后径
    // inner size: transverse between the medial borders of the left and right levator at the vagina's front-to-back level; anteroposterior from the back of the pubic symphysis to the front of the sling behind the anorectum
    let xl = Infinity
    let xr = -Infinity
    for (const l of levator) {
      const q = band(l.mesh, yc, H)
      for (let i = 0; i < q.length; i += 3) {
        if (!cv || Math.abs(q[i + 2]! - cv[2]) > 0.008) continue
        if (l.id.endsWith('_L')) xl = Math.min(xl, q[i]!)
        else xr = Math.max(xr, q[i]!)
      }
    }
    let zPubis = Infinity
    for (const b of [hipL, hipR]) {
      const q = band(b, yc, 0.012)
      for (let i = 0; i < q.length; i += 3) if (Math.abs(q[i]! - xMid) < 0.012) zPubis = Math.min(zPubis, q[i + 2]!)
    }
    let zSling = -Infinity
    for (const l of levator.filter((x) => /puborectal/.test(x.id))) {
      const q = band(l.mesh, yc, H)
      for (let i = 0; i < q.length; i += 3) if (Math.abs(q[i]! - xMid) < 0.005 && ca && q[i + 2]! < ca[2]) zSling = Math.max(zSling, q[i + 2]!)
    }
    add('levatorHiatusContainsUrethraVaginaAnorectum', inside(cu) && inside(cv) && inside(ca), {
      levelYmm: mmOf(yc), slabMm: 12, urethraInside: inside(cu), vaginaInside: inside(cv), anorectumInside: inside(ca),
      outerHullMm: { transverse: mmOf(Math.max(...xs) - Math.min(...xs)), anteroposterior: mmOf(Math.max(...zs) - Math.min(...zs)) },
      innerMm: { transverseAtVagina: Number.isFinite(xl - xr) ? mmOf(xl - xr) : null, symphysisToSling: Number.isFinite(zPubis - zSling) ? mmOf(zPubis - zSling) : null },
      order: cu && cv && ca ? { urethraZmm: mmOf(cu[2]), vaginaZmm: mmOf(cv[2]), anorectumZmm: mmOf(ca[2]), anteriorToPosterior: cu[2] > cv[2] && cv[2] > ca[2] } : null,
      norms: 'unreferenced: no published norm for hiatus dimensions was opened in this work; the specimen pelvis is 0.91× the donor\'s, scaled 1.096 and then narrowed 0.886 with the skeleton',
    })
  } else add('levatorHiatusContainsUrethraVaginaAnorectum', false, { missing: true })

  // 2. 肛门外括约肌环绕肛管，内括约肌在其内。在这份数据里，“肛门外括约肌”只在肛缘一段是完整的环
  // （皮下部），再往上只剩后方连到肛尾韧带的一束；传统所说的外括约肌深部在来源中算作耻骨直肠肌深部。
  // 所以分三项：(i) 外括约肌在其下端有一层是四周完整的环；(ii) 内括约肌下端落在这个环（水平投影）之内；
  // (iii) 在内括约肌中段，外括约肌加耻骨直肠肌从后方和两侧围住它（U 形，前方开口），且在它外面。
  // 2. The external anal sphincter encircles the anal canal, the internal one lies inside it. In this
  // data the "external anal sphincter" is a complete ring only at the anal verge (its subcutaneous
  // part); higher up only a posterior bundle to the anococcygeal ligament is left, and what is
  // traditionally the deep external sphincter is the source's deep part of puborectalis. Hence three
  // items: (i) the external sphincter is a complete ring at some level of its lower end; (ii) the lower
  // end of the internal sphincter falls within that ring (in horizontal projection); (iii) at mid-height
  // of the internal sphincter, external sphincter plus puborectalis surround it behind and on both sides
  // (a U open in front) and lie outside it.
  if (eas && ias) {
    const be = bboxOf(eas)
    const ring: number[] = []
    let ringLevels = 0
    let levelsChecked = 0
    for (let yy = be[1] + 0.002; yy <= be[4]; yy += 0.002) {
      const q = band(eas, yy, 0.002)
      const c = meanOf(q)
      if (!c) continue
      levelsChecked++
      if (sectors(q, c[0], c[2]) === 12) {
        ringLevels++
        for (const v of q) ring.push(v)
      }
    }
    const hull = hullXZ(ring)
    const tip = endCentroid(ias, 'bottom', 0.004)
    const tipInside = inHullXZ(hull, tip[0], tip[2])
    const ym = centroidOf(ias)[1]
    const pi = band(ias, ym, 0.003)
    const c = meanOf(pi)
    const around = [...band(eas, ym, 0.003), ...levator.filter((l) => /puborectal/.test(l.id)).flatMap((l) => band(l.mesh, ym, 0.003))]
    const radius = (q: number[]) => {
      let sum = 0
      for (let i = 0; i < q.length; i += 3) sum += Math.hypot(q[i]! - c![0], q[i + 2]! - c![2])
      return q.length ? sum / (q.length / 3) : 0
    }
    const sa = c ? sectors(around, c[0], c[2]) : 0
    const si = c ? sectors(pi, c[0], c[2]) : 0
    add('externalAnalSphincterEncirclesInternal', ringLevels > 0 && tipInside && !!c && si === 12 && sa >= 8 && radius(pi) < radius(around), {
      externalRing: { levelsChecked, levelsAllRound: ringLevels, heightAllRoundMm: ringLevels * 2, lowestYmm: mmOf(be[1]) },
      lowerEndOfInternalInsideRing: tipInside,
      atMidInternal: { levelYmm: mmOf(ym), internalSectorsOf12: si, externalPlusPuborectalisSectorsOf12: sa, meanRadiusMm: c ? { internal: mmOf(radius(pi)), externalPlusPuborectalis: mmOf(radius(around)) } : null },
      note: 'the source (Wu et al. 2015) counts the traditional deep external sphincter as the deep part of puborectalis; its external sphincter is all round only near the anal verge',
    })
  } else add('externalAnalSphincterEncirclesInternal', false, { missing: true })

  // 3. 尿道括约肌在膀胱颈以下环绕尿道 / the urethral sphincter encircles the urethra below the bladder neck
  if (usp && urethra && bladder) {
    const y = centroidOf(usp)[1]
    const c = meanOf(band(urethra, y, 0.003))
    const s = c ? sectors(band(usp, y, 0.003), c[0], c[2]) : 0
    const hull = hullXZ(band(usp, y, 0.003))
    const neckY = bboxOf(bladder)[1]
    add('urethralSphincterEncirclesUrethra', !!c && s >= 11 && inHullXZ(hull, c[0], c[2]) && y < neckY, { levelYmm: mmOf(y), sphincterSectorsOf12: s, urethraInsideSphincterHull: !!c && inHullXZ(hull, c[0], c[2]), bladderLowestYmm: mmOf(neckY), sphincterTopYmm: mmOf(bboxOf(usp)[4]) })
  } else add('urethralSphincterEncirclesUrethra', false, { missing: true })

  // 4. 会阴体位于阴道与肛管之间 / the perineal body lies between the vagina and the anal canal
  if (pb && vagina && eas) {
    const c = centroidOf(pb)
    const v = endCentroid(vagina, 'bottom', 0.01)
    const a = meanOf(band(eas, c[1], 0.008)) ?? centroidOf(eas)
    add('perinealBodyBetweenVaginaAndAnalCanal', v[2] > c[2] && c[2] > a[2] && Math.abs(c[0] - a[0]) < 0.01, { zMm: { vaginaLowerEnd: mmOf(v[2]), perinealBody: mmOf(c[2]), analCanal: mmOf(a[2]) }, offMidlineMm: mmOf(Math.abs(c[0] - a[0])) })
  } else add('perinealBodyBetweenVaginaAndAnalCanal', false, { missing: true })

  // 5. 阴蒂海绵体和前庭球在耻骨弓前下方、骨盆出口之外 / clitoral bodies and vestibular bulbs antero-inferior to the pubic arch, outside the pelvic outlet
  if (hipL && hipR) {
    // 耻骨联合下缘：中线两侧 8 mm 内髋骨的最低点；坐骨结节：每侧髋骨的最低点
    // lower border of the symphysis: lowest hip-bone point within 8 mm of the midline; ischial tuberosity: lowest point of each hip bone
    let sy = Infinity
    let sz = 0
    const tub: Vec3[] = []
    for (const b of [hipL, hipR]) {
      const p = b.positions
      let ty = Infinity
      let t: Vec3 = [0, 0, 0]
      for (let i = 0; i < p.length; i += 3) {
        if (Math.abs(p[i]! - xMid) < 0.008 && p[i + 1]! < sy) {
          sy = p[i + 1]!
          sz = p[i + 2]!
        }
        if (p[i + 1]! < ty) {
          ty = p[i + 1]!
          t = [p[i]!, p[i + 1]!, p[i + 2]!]
        }
      }
      tub.push(t)
    }
    const tz = (tub[0]![2] + tub[1]![2]) / 2
    const rows: Record<string, unknown> = {}
    let ok = true
    for (const k of ['cavernous_body_of_clitoris', 'vestibular_bulb_L', 'vestibular_bulb_R']) {
      const m = M(k)
      if (!m) {
        ok = false
        continue
      }
      const c = centroidOf(m)
      const inBone = insideFraction(m, hipL) + insideFraction(m, hipR)
      const good = c[1] < sy + 0.003 && c[2] > tz && inBone < 0.01
      ok &&= good
      rows[k] = { centroidBelowSymphysisMm: mmOf(sy - c[1]), centroidAnteriorToTuberositiesMm: mmOf(c[2] - tz), anteriorEndBeyondSymphysisMm: mmOf(bboxOf(m)[5] - sz), insideBonePct: pct(inBone), pass: good }
    }
    add('clitorisAndBulbsBelowPubicArch', ok, { symphysisLowerBorderMm: { y: mmOf(sy), z: mmOf(sz) }, tuberosityZmm: mmOf(tz), parts: rows })
  }

  // 6. 尾骨肌从坐骨棘一带到骶尾骨 / coccygeus from the region of the ischial spine to sacrum and coccyx
  {
    const rows: Record<string, unknown> = {}
    let ok = !!sacrum
    for (const [side, hip] of [['L', hipL], ['R', hipR]] as const) {
      const m = M(`coccygeal_muscle_${side}`)
      if (!m || !hip || !sacrum) {
        ok = false
        continue
      }
      const toHip = minGap(m, hip, 0.0015)
      const toSac = minGap(m, sacrum, 0.0015)
      ok &&= toHip < 0.006 && toSac < 0.006
      rows[side] = { gapToHipBoneMm: mmOf(toHip), gapToSacrumMm: mmOf(toSac) }
    }
    add('coccygeusSpansIschialSpineToSacrum', ok, rows)
  }

  // 7. 两两重叠表和间隙 / pairwise overlap table and gaps
  const solid = [...wuIds.filter((id) => !/lumen/.test(id)), ...(bladder ? ['VF_urinary_bladder'] : [])].map((id) => ({ id, mesh: id === 'VF_urinary_bladder' ? bladder! : get(id)! })).filter((p) => p.mesh)
  const pairs: { a: string; b: string; insidePct: number }[] = []
  {
    const bb = solid.map((p) => bboxOf(p.mesh))
    const testers = solid.map((p) => new InsideTester(p.mesh, 96))
    for (let i = 0; i < solid.length; i++) {
      const pts = surfaceSamples(solid[i]!.mesh, 0.0015)
      for (let j = 0; j < solid.length; j++) {
        if (i === j || !overlaps(bb[i]!, bb[j]!)) continue
        const f = testers[j]!.fractionInside(pts)
        if (f > 0) pairs.push({ a: solid[i]!.id, b: solid[j]!.id, insidePct: pct(f) })
      }
    }
    pairs.sort((x, y) => y.insidePct - x.insidePct)
    const core = pairs.filter((p) => PELVIS_CORE.test(p.a) && PELVIS_CORE.test(p.b))
    add('noInterpenetrationAmongCoreStructures', (core[0]?.insidePct ?? 0) <= 2, { rule: 'share of the surface of A inside B, every ordered pair; core = vagina, urethra, bladder, rectum, uterus, anal and urethral sphincters, levator parts, coccygeus; pass at ≤ 2 %', corePairs: core.length, coreMaxPct: core[0]?.insidePct ?? 0, coreAbove1pct: core.filter((p) => p.insidePct > 1).map((p) => `${p.a} in ${p.b} ${p.insidePct}`), allPairs: pairs.length, allMaxPct: pairs[0]?.insidePct ?? 0, allAbove1pct: pairs.filter((p) => p.insidePct > 1).length, worst: pairs.slice(0, 10) })
  }
  const gapsMm: Record<string, number> = {}
  {
    const gap = (name: string, a: Mesh | null, b: Mesh | null) => {
      if (a && b) gapsMm[name] = mmOf(minGap(a, b, 0.001), 2)
    }
    gap('vagina–rectum', vagina, rectum)
    gap('vagina–bladder', vagina, bladder)
    gap('vagina–urethra', vagina, urethra)
    gap('urethra–urethral sphincter', urethra, usp)
    gap('uterus–bladder', uterus, bladder)
    gap('uterus–rectum', uterus, rectum)
    gap('rectum–internal anal sphincter', rectum, ias)
    gap('internal–external anal sphincter', ias, eas)
    gap('bladder neck–urethra', bladder, urethra)
    gap('left ureter–bladder', get('Left ureter'), bladder)
    gap('right ureter–bladder', get('Right ureter'), bladder)
    gap('sigmoid colon–rectum', get('Descending colon'), M('rectal_lumen') ?? rectum)
    add('joinsAreContinuous', (gapsMm['bladder neck–urethra'] ?? 9) <= 2 && (gapsMm['left ureter–bladder'] ?? 9) <= 2 && (gapsMm['right ureter–bladder'] ?? 9) <= 2 && (gapsMm['sigmoid colon–rectum'] ?? 9) <= 6, { gapsMm: { bladderNeckToUrethra: gapsMm['bladder neck–urethra'], leftUreterToBladder: gapsMm['left ureter–bladder'], rightUreterToBladder: gapsMm['right ureter–bladder'], sigmoidToRectum: gapsMm['sigmoid colon–rectum'] }, limitsMm: { bladder: 2, ureters: 2, sigmoid: 6 } })
  }

  // 8. 都在骨盆之内 / everything within the bony pelvis
  if (hipL && hipR && sacrum) {
    const bl = bboxOf(hipL)
    const br = bboxOf(hipR)
    const bs = bboxOf(sacrum)
    const lim = [br[0], Math.min(bl[1], br[1]) - 0.05, bs[2] - 0.005, bl[3], bs[4] + 0.01, Math.max(bl[5], br[5]) + 0.035]
    const out: string[] = []
    const inBone: Record<string, number> = {}
    const bones = [hipL, hipR, sacrum]
    for (const id of wuIds) {
      const m = get(id)!
      const b = bboxOf(m)
      if (b[0] < lim[0]! || b[1] < lim[1]! || b[2] < lim[2]! || b[3] > lim[3]! || b[4] > lim[4]! || b[5] > lim[5]!) out.push(id)
      const f = bones.filter((q) => overlaps(b, bboxOf(q))).reduce((s, q) => s + insideFraction(m, q, 0.002), 0)
      if (f > 0.005) inBone[id] = pct(f)
    }
    add('withinBonyPelvis', out.length === 0 && Object.values(inBone).every((v) => v <= 2), { boundsMm: lim.map((v) => mmOf(v, 0)), note: 'bounds: between the hip bones, from 50 mm below the ischial tuberosities to 10 mm above the sacrum, from the back of the sacrum to 35 mm in front of the pubis', outsideBounds: out, insideBonePctAbove0_5: inBone })
  }

  // 9. 左右成对 / left and right present
  {
    const lonely = wuIds.filter((id) => (/_L$/.test(id) && !ids.includes(id.replace(/_L$/, '_R'))) || (/_R$/.test(id) && !ids.includes(id.replace(/_R$/, '_L'))))
    add('leftRightPresent', lonely.length === 0, { sidedParts: wuIds.filter((id) => /_[LR]$/.test(id)).length, unpaired: lonely })
  }

  // 10. 子宫在膀胱与直肠之间；卵巢、输卵管在两侧且不与肠管相交 / uterus between bladder and rectum; ovaries and tubes on their sides and clear of bowel
  if (uterus && bladder && rectum) {
    const u = centroidOf(uterus)
    const b = centroidOf(bladder)
    const r = centroidOf(rectum)
    add('uterusBetweenBladderAndRectum', b[2] > u[2] && u[2] > r[2], { zMm: { bladder: mmOf(b[2]), uterus: mmOf(u[2]), rectum: mmOf(r[2]) } })
    const colon = get('Descending colon')
    const rows: Record<string, unknown> = {}
    let ok = true
    for (const [side, sgn] of [['L', 1], ['R', -1]] as const) {
      for (const k of ['ovary', 'uterine_tube']) {
        const m = M(`${k}_${side}`)
        if (!m) {
          ok = false
          continue
        }
        const c = centroidOf(m)
        const inColon = colon ? insideFraction(m, colon) : 0
        const good = sgn * (c[0] - xMid) > 0.01 && Math.abs(c[0] - xMid) < 0.09 && inColon < 0.01
        ok &&= good
        rows[`${k}_${side}`] = { centroidMm: c.map((v) => mmOf(v, 0)), insideColonPct: pct(inColon), ...(k === 'ovary' ? { gapToHipBoneMm: mmOf(minGap(m, side === 'L' ? hipL! : hipR!, 0.002)) } : {}) }
      }
    }
    add('adnexaLateralAndClearOfBowel', ok, rows)
  }
  return { checks, pairs, gapsMm }
}

/**
 * 会阴结构相对于体表的位置（供之后的皮肤贴合用，不是检查）：每个结构的最低点、到当前皮肤的最近距离、
 * 是否露在皮肤之外（正下方没有皮肤），以及到 Wu 标本体表轮廓的距离和低于骨盆出口平面多少。
 * Where the perineal structures lie relative to the body surface (for fitting the skin later; not a
 * check): each structure's lowest point, its closest approach to the present skin, whether it shows
 * outside the skin (no skin straight below it), its distance to the specimen's own body outline and how
 * far below the plane of the pelvic outlet it reaches.
 */
export function perineumAgainstSkin(get: (idOrName: string) => Mesh | null, ids: string[], skin: Mesh | null, wuSkin: Mesh | null): Record<string, unknown> {
  const hipL = get('Left hip bone')
  const hipR = get('Right hip bone')
  if (!hipL || !hipR) return {}
  // 骨盆出口平面：过耻骨联合下缘和两侧坐骨结节 / plane of the outlet: through the lower border of the symphysis and both ischial tuberosities
  const low = (m: Mesh, keep: (x: number) => boolean): Vec3 => {
    let best: Vec3 = [0, Infinity, 0]
    const p = m.positions
    for (let i = 0; i < p.length; i += 3) if (keep(p[i]!) && p[i + 1]! < best[1]) best = [p[i]!, p[i + 1]!, p[i + 2]!]
    return best
  }
  const tl = low(hipL, () => true)
  const tr = low(hipR, () => true)
  const sl = low(hipL, (x) => Math.abs(x) < 0.01)
  const sr = low(hipR, (x) => Math.abs(x) < 0.01)
  const s: Vec3 = sl[1] < sr[1] ? sl : sr
  const t: Vec3 = [(tl[0] + tr[0]) / 2, (tl[1] + tr[1]) / 2, (tl[2] + tr[2]) / 2]
  const outletY = (z: number) => t[1] + ((z - t[2]) / (s[2] - t[2] || 1e-9)) * (s[1] - t[1])
  const skinPts = skin ? surfaceSamples(skin, 0.003) : null
  const skinIx = skinPts ? new PointIndex(skinPts, 0.01) : null
  const wuPts = wuSkin ? surfaceSamples(wuSkin, 0.003) : null
  const wuIx = wuPts ? new PointIndex(wuPts, 0.01) : null
  const skinBelow = (p: Vec3): boolean => {
    if (!skinPts) return false
    for (let i = 0; i < skinPts.length; i += 3) if (skinPts[i + 1]! < p[1] && Math.hypot(skinPts[i]! - p[0], skinPts[i + 2]! - p[2]) < 0.004) return true
    return false
  }
  const rows: Record<string, unknown> = {}
  const PERINEAL = /^WU_(cavernous_body_of_clitoris|vestibular_bulb|bartholin_gland|bulbospongiosus|ischiocavernous|superficial_transverse|deep_perineal|perineal_body|external_anal_sphincter|vaginal_wall|submucous_layer_of_urethra|urethro_vaginal)/
  let outside = 0
  for (const id of ids.filter((x) => PERINEAL.test(x))) {
    const m = get(id)
    if (!m) continue
    const l = low(m, () => true)
    const pts = surfaceSamples(m, 0.002)
    let dSkin = Infinity
    let dWu = Infinity
    for (let i = 0; i < pts.length; i += 3) {
      if (skinIx) dSkin = Math.min(dSkin, skinIx.distance(pts[i]!, pts[i + 1]!, pts[i + 2]!, dSkin))
      if (wuIx) dWu = Math.min(dWu, wuIx.distance(pts[i]!, pts[i + 1]!, pts[i + 2]!, dWu))
    }
    const covered = skinBelow(l)
    if (!covered) outside++
    rows[id] = { lowestPointMm: l.map((v) => mmOf(v, 0)), lowestPointBelowOutletPlaneMm: mmOf(outletY(l[2]) - l[1]), closestToPresentSkinMm: skinIx ? mmOf(dSkin) : null, presentSkinBelowLowestPoint: skin ? covered : null, closestToSpecimenOutlineMm: wuIx ? mmOf(dWu) : null }
  }
  // 标本体表轮廓的会阴部分（两坐骨结节之间、出口平面以下）到当前皮肤的距离
  // the perineal part of the specimen's outline (between the tuberosities, below the outlet plane) against the present skin
  let patch: Record<string, unknown> | null = null
  if (wuPts && skinIx) {
    const d: number[] = []
    const below: number[] = []
    for (let i = 0; i < wuPts.length; i += 3) {
      const x = wuPts[i]!
      const y = wuPts[i + 1]!
      const z = wuPts[i + 2]!
      if (Math.abs(x) > Math.abs(tl[0]) || z < t[2] - 0.03 || z > s[2] + 0.03 || y > outletY(z)) continue
      d.push(skinIx.distance(x, y, z, 0.2))
      below.push(outletY(z) - y)
    }
    d.sort((a, b) => a - b)
    below.sort((a, b) => a - b)
    const q = (a: number[], f: number) => (a.length ? mmOf(a[Math.min(a.length - 1, Math.floor(f * a.length))]!) : null)
    patch = { samples: d.length, toPresentSkinMm: { median: q(d, 0.5), p90: q(d, 0.9), max: q(d, 0.999) }, belowOutletPlaneMm: { median: q(below, 0.5), p90: q(below, 0.9), max: q(below, 0.999) } }
  }
  return {
    note: 'for shaping the future skin: the skin must pass below (outside) every structure listed here; the specimen outline is the skin of a slimmer individual scaled 1.096 with thighs apart as in the specimen, not a target surface',
    outletPlane: { symphysisLowerBorderMm: s.map((v) => mmOf(v, 0)), tuberosityMidpointMm: t.map((v) => mmOf(v, 0)) },
    structures: rows, structuresWithNoSkinBelow: outside, specimenPerinealOutline: patch,
  }
}
