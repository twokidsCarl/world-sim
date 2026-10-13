// 女性体形重塑的调用层：选目标包、核对它所依据的骨架、给每个部件定角色、唇的搬运，然后调用 shape.ts。
// 从 female.ts 里分出来，是为了能对着部件快照单独重跑这一步（female.ts 的 SOMA_SHAPE_SNAPSHOT）。
//
// 目标包：data/raw/bodyshape/out/female-face-target。它的深层包络在锁骨平面以下与 female-target 的逐顶点相同
// （本文件写成时核对过：y < 1.24 m 处最大相差 0.6 mm，肩、躯干、四肢完全相同），头和颈按她的颅骨和已发表的
// 女性软组织厚度重做。
//
// 骨架的核对：目标包在 manifest.basedOn.key 里写明它所依据的内部结构指纹。接受的条件是下面之一——
//   1. 指纹等于本次构建的骨架指纹（体形重塑之前）；
//   2. 指纹等于“该骨架经第 2 版体形重塑（用 female-target 的包络）之后”的内部结构指纹：面部目标包就是在那样的
//      身体上做的，而第 2 版重塑不动骨；
//   3. 上面两条里的“骨架”换成 031ce88117d19693（做目标包时的骨架），且现在手、足以外每块骨的包围盒与那副骨架的
//      相差不超过 SKELETON_TOLERANCE_MM。手骨和足骨另算：手骨、跖骨和趾骨是形变来的男性骨，男性上肢姿势一改
//      手骨就挪动几毫米，足骨则在本轮被重新摆放过（见 female.ts）；它们相差超过 EXTREMITY_LEAVE_MM 时，
//      该部位（手或足）整个不参加重塑（shape.ts 的 leaveRegions）——那里的包络只有 2.5–5 mm 厚，对不上就会把
//      手指、足趾的软组织从骨上推开；相差超过 EXTREMITY_TOLERANCE_MM 则认为骨架已是另一副，不用目标包。
//      相差多少写进报告。
// 其余情况不用目标包，构建结果与没有这一步时相同。
//
// The calling layer of the female body-shape stage: picks the target package, checks the skeleton it
// was made for, gives every part its role, carries the lips, then calls shape.ts. Split off from
// female.ts so that the stage can be rerun alone on a part snapshot (SOMA_SHAPE_SNAPSHOT of female.ts).
//
// Target package: data/raw/bodyshape/out/female-face-target. Below the level of the clavicles its deep
// envelope is vertex for vertex that of female-target (checked when this file was written: at most
// 0.6 mm apart below y = 1.24 m; shoulders, trunk and limbs identical); head and neck were rebuilt
// from her skull and published female soft-tissue depths.
//
// The skeleton check: a target package states the internals fingerprint it was made for in
// manifest.basedOn.key. It is accepted when one of these holds —
//   1. the fingerprint is this build's skeleton fingerprint (before the body-shape stage);
//   2. it is the internals fingerprint "of that skeleton after body-shape stage v2 with the envelope of
//      female-target": the face target was made on such a body, and stage v2 moves no bone;
//   3. either of the above with the skeleton 031ce88117d19693 (the one the packages were made on) in
//      place of this build's, provided every bone outside the hands and feet now has its bounding box
//      within SKELETON_TOLERANCE_MM of that skeleton's. Hands and feet are judged apart: the bones of the
//      hand, the metatarsals and the toe phalanges are warped male bones; the hand bones shift by a few
//      millimetres whenever the male limb's posture changes, and the foot bones were re-placed in this
//      round (see female.ts). When they are more than EXTREMITY_LEAVE_MM off, that whole region (hand or
//      foot) is left out of the stage (leaveRegions of shape.ts) — the envelope is only 2.5–5 mm deep
//      there, and a mismatch would push the soft tissue of fingers and toes off their bones; beyond
//      EXTREMITY_TOLERANCE_MM the skeleton counts as another one and the package is not used. The
//      differences go into the report.
// Otherwise the package is not used and the build is what it is without this stage.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { measure, type Mesh } from './geometry.ts'
import { lipPartIds } from './lipSplit.ts'
import { signedVolume } from './meshRepair.ts'
import { InsideTester, PointIndex, surfacePoints, thinPoints } from './register.ts'
import { SKELETON_031C_BOXES_MM, SKELETON_031C_KEY } from './femaleSkeleton031c.ts'
import { loadShapeTarget, medianDistanceToBone, regionOfBone, reshapeIntoEnvelope, type ShapePart, type ShapeRegion, type ShapeReport, type ShapeRole } from './shape.ts'
import { internalsKey, parseSkinObj, signedDistanceToSkin, SurfaceDistance, usedVertices } from './skinPackage.ts'

/**
 * 体形目标包的位置（相对项目根）：目标体表和深层包络，见 shape.ts。不存在时跳过体形重塑。
 * Where the body-shape target package lives (relative to the project root): target skin and deep envelope, see shape.ts. Without it the body-shape stage is skipped.
 */
export const SHAPE_TARGET_DIR = 'data/raw/bodyshape/out/female-face-target'
/** 表面到骨的距离中位数超过它的韧带算“游离”的，随软组织移动 / a ligament whose surface lies further than this from bone (median) spans free and moves with the soft tissue */
export const FREE_LIGAMENT = 0.008
/**
 * 女性与男性骨骼肌量之比，用作由男性形变而来的肌的体积下限（她自己的肌不受此限）。
 * 出处：Janssen I, Heymsfield SB, Wang ZM, Ross R. Skeletal muscle mass and distribution in 468 men and women aged 18–88 yr.
 * J Appl Physiol 2000;89(1):81–88, doi:10.1152/jappl.2000.89.1.81。摘要原文：全身 MRI，男性骨骼肌 33.0 kg、女性 21.0 kg；
 * “性别差异上半身（40 %）大于下半身（33 %）”。只核对了摘要；上、下半身的分界在正文里，没有核对，这里取髂嵴最高点。
 * Ratio of female to male skeletal muscle mass, used as the volume floor of muscles warped from the male (her own muscles are not bound by it).
 * Source: Janssen I, Heymsfield SB, Wang ZM, Ross R. Skeletal muscle mass and distribution in 468 men and women aged 18–88 yr.
 * J Appl Physiol 2000;89(1):81–88, doi:10.1152/jappl.2000.89.1.81. From the abstract: whole-body MRI, skeletal muscle 33.0 kg in men and
 * 21.0 kg in women; "the gender differences were greater in the upper (40%) than lower (33%) body". Only the abstract was checked; where
 * the paper divides upper from lower body is in its full text and was not checked, so the top of the iliac crest is used here.
 */
export const MUSCLE_SEX_RATIO = { source: 'Janssen et al. 2000, J Appl Physiol 89(1):81-88, doi:10.1152/jappl.2000.89.1.81 (abstract)', upperBody: 0.6, lowerBody: 0.67, division: 'top of the iliac crest (assumed; not taken from the paper)' }
/** 体形重塑的版本号：算法或参数一改就加一，内部结构指纹随之改变 / version of the body-shape stage: raised whenever the algorithm or its parameters change, which changes the internals fingerprint */
export const SHAPE_STAGE_VERSION = 4
/** 现在的骨架与目标包所依据的骨架，每块骨包围盒各面最多可以相差这么多（毫米） / how far each face of every bone's bounding box may now be from the skeleton a target package was made for (mm) */
export const SKELETON_TOLERANCE_MM = 2
/** 手骨、足骨：相差超过前者，该部位不参加重塑；超过后者，不用目标包（毫米） / bones of hand and foot: beyond the first the region is left out of the stage, beyond the second the package is not used (mm) */
export const EXTREMITY_LEAVE_MM = 2
export const EXTREMITY_TOLERANCE_MM = { hand: 8, foot: 60 } as const
/**
 * 第 2 版体形重塑的指纹成分（female-target 的包络、当时的参数）：面部目标包的 basedOn.key 就是这样算出来的
 * （骨架 031ce88117d19693 → d8e55b8725377511，本文件写成时验算过）。
 * What went into the fingerprint of body-shape stage v2 (the envelope of female-target and the options of
 * the time): the face target's basedOn.key was computed this way (skeleton 031ce88117d19693 →
 * d8e55b8725377511, verified when this file was written).
 */
const STAGE_V2 = {
  envelopeSha1: '0f34c286d69f8e08',
  optionsJson: '{"margin":0.0015,"passes":2,"sampleSpacing":0.005,"envelopeSpacing":0.0025,"attachDistance":0.003,"minDepthShare":0.6,"maxPush":0.03,"pull":{"cap":0.015,"maxGap":0.03,"weight":0.5},"mirror":1,"xMid":0,"grid":0.005,"stiffness":20,"sweeps":60,"substeps":4,"balanceSlab":0.04,"flagVolumeLoss":0.25,"depthFloor":0.4,"calibrationTrials":5}',
}

/**
 * 做过体形重塑之后的内部结构指纹：骨架指纹并入重塑的版本、所用包络和参数——软组织变了，按旧软组织拟合的皮肤也就失效。
 * The internals fingerprint after the body-shape stage: the skeleton fingerprint with the stage's version, the envelope
 * it used and its options mixed in — the soft tissue changed, and a skin fitted to the old one is no longer valid.
 */
export function shapedInternalsKey(boneKey: string, envelopeSha1: string, options: unknown): string {
  return createHash('sha1').update(`${boneKey}\nbody-shape v${SHAPE_STAGE_VERSION}\n${envelopeSha1}\n${JSON.stringify(options)}\n${JSON.stringify(MUSCLE_SEX_RATIO)}`).digest('hex').slice(0, 16)
}

/** 骨架 `boneKey` 经第 2 版体形重塑之后的内部结构指纹 / the internals fingerprint of skeleton `boneKey` after body-shape stage v2 */
export function stageV2InternalsKey(boneKey: string): string {
  return createHash('sha1').update(`${boneKey}\nbody-shape v2\n${STAGE_V2.envelopeSha1}\n${STAGE_V2.optionsJson}\n${JSON.stringify(MUSCLE_SEX_RATIO)}`).digest('hex').slice(0, 16)
}

export interface TargetMatch {
  accepted: boolean
  /** 接受的依据，或不接受的原因 / why it was accepted, or why not */
  how: string
  /** 现在的骨架与 031c 骨架的比较（包不是按本次骨架做的时才有） / the present skeleton against skeleton 031c (only when the package was not made for this build's skeleton) */
  skeleton?: { madeFor: string; present: string; toleranceMm: number; bones: number; bonesDiffering: number; maxDifferenceMm: number; worst: { id: string; name: string; differenceMm: number }[]; missing: string[]; extremities: Record<'hand' | 'foot', { toleranceMm: number; leaveOutAboveMm: number; bones: number; maxDifferenceMm: number }> }
  /** 包络与现在的骨架对不上、因而不参加重塑的部位 / regions where the envelope does not match the present skeleton and which are therefore left out of the stage */
  leaveRegions?: ShapeRegion[]
}

/**
 * 目标包是否可用于现在的骨架（规则见文件头）。
 * Whether a target package may be used on the present skeleton (rules at the top of this file).
 */
export function matchTarget(basedOn: { body: string; key: string } | null, boneKey: string, bones: { id: string; name: string; bbox: readonly number[]; shippedBox?: readonly number[] }[]): TargetMatch {
  if (!basedOn) return { accepted: false, how: 'the package does not say which internals it was made for (manifest.basedOn missing)' }
  if (basedOn.body !== 'female') return { accepted: false, how: 'made for another body' }
  if (basedOn.key === boneKey) return { accepted: true, how: 'made for this skeleton' }
  if (basedOn.key === stageV2InternalsKey(boneKey)) return { accepted: true, how: 'made for this skeleton after body-shape stage v2 (which moves no bone)' }
  if (basedOn.key !== SKELETON_031C_KEY && basedOn.key !== stageV2InternalsKey(SKELETON_031C_KEY)) return { accepted: false, how: 'made for other internals' }
  // 包是按 031c 骨架做的：逐骨比较包围盒 / the package was made on skeleton 031c: bounding boxes compared bone by bone
  const rows: { id: string; name: string; differenceMm: number; region: ShapeRegion }[] = []
  const missing: string[] = []
  const seen = new Set<string>()
  for (const b of bones) {
    const ref = SKELETON_031C_BOXES_MM[b.id]
    seen.add(b.id)
    if (!ref) {
      missing.push(b.id)
      continue
    }
    // 参考值抄自输出的（简化后的）骨网格：有同样简化过的包围盒时用它来比，没变的骨差值恰为零
    // the reference was copied from shipped (simplified) bone meshes: where the box of the equally simplified mesh is given it is the one compared, and an unchanged bone differs by exactly zero
    const d = Math.max(...(b.shippedBox ?? b.bbox).map((v, i) => Math.abs(Math.round(v * 1000) - ref[i]!)))
    rows.push({ id: b.id, name: b.name, differenceMm: Math.round(d * 10) / 10, region: regionOfBone(b.name) })
  }
  for (const id of Object.keys(SKELETON_031C_BOXES_MM)) if (!seen.has(id)) missing.push(id)
  rows.sort((a, b) => b.differenceMm - a.differenceMm || (a.id < b.id ? -1 : 1))
  const maxOf = (list: typeof rows) => (list.length ? list[0]!.differenceMm : 0)
  const other = rows.filter((r) => r.region !== 'hand' && r.region !== 'foot')
  const max = other.length ? maxOf(other) : Infinity
  const ext = (k: 'hand' | 'foot') => ({ toleranceMm: EXTREMITY_TOLERANCE_MM[k], leaveOutAboveMm: EXTREMITY_LEAVE_MM, bones: rows.filter((r) => r.region === k).length, maxDifferenceMm: maxOf(rows.filter((r) => r.region === k)) })
  const extremities = { hand: ext('hand'), foot: ext('foot') }
  // 参考值取整到毫米：1 mm 以内不算差别 / the reference is rounded to millimetres: within 1 mm is not counted as a difference
  const skeleton = { madeFor: SKELETON_031C_KEY, present: boneKey, toleranceMm: SKELETON_TOLERANCE_MM, bones: rows.length, bonesDiffering: rows.filter((r) => r.differenceMm > 1).length, maxDifferenceMm: max, worst: rows.filter((r) => r.differenceMm > 1).slice(0, 12).map(({ id, name, differenceMm }) => ({ id, name, differenceMm })), missing: missing.sort(), extremities }
  if (missing.length) return { accepted: false, how: `made for skeleton ${SKELETON_031C_KEY}, which does not have the same bones as this one`, skeleton }
  const tooFar = (['hand', 'foot'] as const).filter((k) => extremities[k].maxDifferenceMm > EXTREMITY_TOLERANCE_MM[k])
  if (max > SKELETON_TOLERANCE_MM || tooFar.length) return { accepted: false, how: `made for skeleton ${SKELETON_031C_KEY}; the present skeleton is up to ${max} mm from it outside hands and feet (${SKELETON_TOLERANCE_MM} mm allowed), ${extremities.hand.maxDifferenceMm} mm in the hands (${EXTREMITY_TOLERANCE_MM.hand}) and ${extremities.foot.maxDifferenceMm} mm in the feet (${EXTREMITY_TOLERANCE_MM.foot})`, skeleton }
  const leaveRegions = (['foot', 'hand'] as const).filter((k) => extremities[k].maxDifferenceMm > EXTREMITY_LEAVE_MM) as ShapeRegion[]
  return { accepted: true, how: `made for skeleton ${SKELETON_031C_KEY}${basedOn.key === SKELETON_031C_KEY ? '' : ' after body-shape stage v2'}; the present skeleton is within ${max} mm of it outside hands and feet, ${extremities.hand.maxDifferenceMm} mm in the hands and ${extremities.foot.maxDifferenceMm} mm in the feet${leaveRegions.length ? ` (left out of the stage: ${leaveRegions.join(', ')})` : ''}`, skeleton, leaveRegions }
}

export interface FemaleShapePart extends ShapePart {
  system: string
  source?: string
  /** 由哪个男性部件形变而来 / the male part it was warped from */
  male?: string
}

export interface FemaleShapeInput {
  /** 项目根目录 / the project root */
  root: string
  /** 全部部件；可动部件的网格和中心线被就地改写 / every part; meshes and centrelines of the movable ones are rewritten in place */
  parts: FemaleShapePart[]
  /** 男性部件的网格（体积下限的参考） / the male meshes (reference of the volume floor) */
  maleMeshes: ReadonlyMap<string, Mesh>
  /** 各来源的名称 / the names of the sources */
  sources: { wu: string; hra: string; vhf: string; denver: string }
  /** 目标包目录（相对项目根）；缺省为 SHAPE_TARGET_DIR / the target package (relative to the root); SHAPE_TARGET_DIR when absent */
  targetDir?: string
  /**
   * 一块骨按输出时的规则处理（该简化的简化）之后的包围盒（米）：与 031c 骨架比较时用（参考值抄自那一版的输出）。不给则用现有网格的。
   * Bounding box (m) of a bone as it will be shipped (simplified where the output rule simplifies it): for the comparison with
   * skeleton 031c, whose reference was copied from that build's output. The box of the present mesh is used when absent.
   */
  shippedBox?: (part: FemaleShapePart) => Promise<readonly number[]>
  log?: (line: string) => void
}

export interface LipCarryRow {
  id: string
  name: string
  /** lip = 目标包 lipParts 里列出的非肌部件；perioral = 口周的表情肌 / lip = a non-muscle part listed under lipParts of the target package; perioral = a perioral muscle of expression */
  kind: 'lip' | 'perioral'
  /** 目标包要求的覆盖厚度（中位数，毫米）；没有要求的为 null / the cover the target package asks for (as a median, mm); null where it asks for none */
  coverWantedMm: number | null
  /** 部件顶点到目标体表的距离（毫米，负 = 在体表之外）：搬运前、后的中位数，后者的最小值 / distance of the part's vertices to the target skin (mm, negative = outside it): median before and after, least after */
  medianCoverBeforeMm: number
  medianCoverAfterMm: number | null
  leastCoverAfterMm: number | null
  displacementMm: { median: number; max: number }
  volumeMl: { before: number; after: number | null; change: number | null }
  /** 顶点落在牙、上颌骨或下颌骨内的比例，搬运前、后 / share of vertices inside a tooth, the maxilla or the mandible, before and after */
  insideTeethOrJaws: { before: number; after: number | null }
  carried: boolean
  reason?: string
}

/** 唇的搬运：最多移这么远；唇部件在体表下至少这么深；位移从口轮匝肌表面起在这两个距离之间收到零（米） / the lip carry: the largest displacement; the least depth of the Lip part under the skin; the displacement fades to zero between these two distances from the surface of orbicularis oris (m) */
const LIP_CARRY_MAX = 0.015
const LIP_FRONT_MIN = 0.0005
const LIP_FADE: [number, number] = [0.003, 0.04]
/** 口周的表情肌：随唇面一起搬运 / the perioral muscles of expression: carried with the lip surface */
const PERIORAL_MUSCLE = /orbicularis oris|buccinator|levator labii superioris|levator anguli oris|zygomaticus|risorius|depressor anguli oris|depressor labii inferioris|mentalis/i

/**
 * 女性的体形重塑。返回写进管线报告的 `bodyShape`；没有目标包时返回 null。
 * The female body-shape stage. Returns what goes into the pipeline report as `bodyShape`; null when there is no target package.
 */
export async function shapeFemale(input: FemaleShapeInput): Promise<(Record<string, unknown> & { applied: boolean }) | null> {
  const { parts, sources } = input
  const log = input.log ?? (() => {})
  const dir = input.targetDir ?? SHAPE_TARGET_DIR
  const target = loadShapeTarget(join(input.root, dir))
  if (!target) return null
  const bonesOnly = parts.filter((p) => p.tissue === 'bone')
  const boneRows: { id: string; name: string; bbox: readonly number[]; shippedBox?: readonly number[] }[] = bonesOnly.map((p) => ({ id: p.id, name: p.name, bbox: measure(p.mesh).bbox }))
  const key = internalsKey(boneRows)
  // 只有包不是按本次骨架做的时才需要逐骨比较 / the bone-by-bone comparison is needed only when the package was not made for this build's skeleton
  if (input.shippedBox && target.basedOn && target.basedOn.key !== key && target.basedOn.key !== stageV2InternalsKey(key)) for (let i = 0; i < bonesOnly.length; i++) boneRows[i]!.shippedBox = await input.shippedBox(bonesOnly[i]!)
  const match = matchTarget(target.basedOn, key, boneRows)
  const head = { dir, basedOn: target.basedOn, internalsKeyBeforeShape: key, envelopeSha1: target.envelopeSha1, targetMatch: match }
  if (!match.accepted) {
    log(`Body shape: target package ${dir} not used (${match.how}); this build's skeleton key is ${key}`)
    return { ...head, applied: false, reason: match.how }
  }
  log(`Body shape: soft deep parts into the deep envelope of ${dir} (envelope ${target.envelopeSha1}); ${match.how}`)

  const hard = (p: FemaleShapePart) => p.tissue === 'bone' || p.tissue === 'tooth' || p.tissue === 'cartilage'
  const DRIVING = new Set<string>(['muscle', 'tendon', 'organ', 'gland', 'heart', 'brain'])
  const toBone = medianDistanceToBone(parts.filter((p) => p.tissue === 'ligament' && p.system !== 'integumentary' && p.source !== sources.wu && p.source !== sources.hra), parts.filter(hard))
  const freeLigaments = parts.filter((p) => (toBone.get(p.id) ?? 0) > FREE_LIGAMENT).map((p) => p.name).sort()
  const byId = new Map(parts.map((p) => [p.id, p]))
  const roleOf = (q: { id: string }): ShapeRole => {
    const p = byId.get(q.id)!
    if (hard(p)) return 'bone'
    if (p.system === 'integumentary') return 'ignored'
    if (p.source === sources.wu || p.source === sources.hra) return 'fixed'
    if (p.tissue === 'ligament') return (toBone.get(p.id) ?? 0) > FREE_LIGAMENT ? 'follower' : 'fixed'
    if (p.source === sources.vhf && p.tissue !== 'muscle' && p.tissue !== 'tendon') return 'fixed'
    if (p.system === 'nervous' && p.tissue !== 'nerve') return 'fixed'
    // 淋巴结随场走，每个结整体平移，不参与决定位移场 / lymph nodes go with the field, each translated whole, and do not drive it
    if (p.system === 'lymphatic' && /\bnodes?\b/i.test(p.name)) return 'rigid'
    return DRIVING.has(p.tissue) ? 'driver' : 'follower'
  }
  // 体积下限：由男性形变而来的肌，按部位合计不低于“性别比 × 男性原肌体积”
  // volume floor: muscles warped from the male keep, summed per region, at least "sex ratio × the male muscle's volume"
  const crestTop = Math.max(...parts.filter((p) => /hip bone/i.test(p.name) && p.tissue === 'bone').map((p) => measure(p.mesh).bbox[4]))
  const referenceVolumeMl = (q: { id: string }): number | null => {
    const p = byId.get(q.id)!
    if (!p.male || p.source === sources.vhf || p.source === sources.denver || p.source === sources.wu) return null
    const m = input.maleMeshes.get(p.male)
    if (!m) return null
    return (measure(p.mesh).centroid[1] > crestTop ? MUSCLE_SEX_RATIO.upperBody : MUSCLE_SEX_RATIO.lowerBody) * Math.abs(signedVolume(m)) * 1e6
  }

  // ── 唇的搬运 / the lip carry
  // 目标包的 conflict-list.json 在 lipParts 里列出应当随新的唇面前移的部件和各自在目标体表下应有的覆盖厚度（按中位数）。
  // 做法是一个平滑的平移场，作用于口周各肌的整个厚度，所以肌只平移、略有剪切，不变厚：
  //   方向 n = 口轮匝肌各顶点朝目标体表之外方向的平均（一个常向量）；
  //   幅度 A = 口轮匝肌顶点到目标体表距离的中位数 − 它应有的覆盖厚度；
  //   位移 = A · w(r) · n，r = 该点到口轮匝肌（搬运前）表面的距离，w 在 LIP_FADE[0] 以内为 1，到 LIP_FADE[1] 处平滑收到零——
  //   于是口轮匝肌整块平移，汇入它的各肌（颊肌、提肌、降肌、颧肌、笑肌、颏肌）靠唇的一端跟着走，骨上的起点不动。
  // 唇（非肌部件）按它自己的幅度沿同一方向平移，再逐点收住：不越出体表下 LIP_FRONT_MIN。
  // 这些部件的顶点直接按上式移动（shape.ts 的 carry）：位移场的网格（5 mm）细不到唇与牙之间那几毫米，
  // 而且让它们参加推入、拉出会把它们撑厚。周围的血管、神经由位移场尽量带着走。
  // conflict-list.json of the target package names under lipParts the parts that should move forwards with the new lip
  // surface, each with the cover (as a median) it should have under the target skin. This is done with one smooth
  // translation field acting on the whole thickness of every perioral muscle, so that a muscle translates and shears
  // slightly but does not thicken:
  //   direction n = the mean, over the vertices of orbicularis oris, of the direction out of the target skin (one constant vector);
  //   amount A = median distance of the vertices of orbicularis oris to the target skin − the cover it should have;
  //   displacement = A · w(r) · n, r = distance of the point to the surface of orbicularis oris (before the carry), w = 1
  //   within LIP_FADE[0] and fading smoothly to zero at LIP_FADE[1] — orbicularis oris translates whole, the muscles that
  //   run into it (buccinator, elevators, depressors, zygomatici, risorius, mentalis) follow at their labial end and stay
  //   at their bony origin.
  // The Lip (not a muscle) translates by its own amount along the same direction and is then held back vertex by vertex
  // so that none comes nearer the skin than LIP_FRONT_MIN.
  // The vertices of these parts are moved by this rule directly (carry of shape.ts): the field's grid (5 mm) cannot
  // resolve the few millimetres between lip and teeth, and letting these parts take part in the pushes and pulls
  // thickens them. The field brings the vessels and nerves around them along as far as it can.
  const lipRows: LipCarryRow[] = []
  const carry = new Map<string, (points: Float32Array) => Float32Array>()
  const listFile = join(input.root, dir, 'conflict-list.json')
  const skinFile = join(input.root, dir, 'skin.obj')
  let lipSkin: { tester: InsideTester; surface: SurfaceDistance } | null = null
  const r1 = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d
  const volumeMl = (p: FemaleShapePart) => Math.abs(signedVolume(p.mesh)) * 1e6
  // 牙和颌骨 / the teeth and the jaws
  const jawTesters = parts.filter((p) => p.tissue === 'tooth' || (p.tissue === 'bone' && /mandible|maxilla/i.test(p.name))).map((p) => ({ box: measure(p.mesh).bbox, tester: new InsideTester(p.mesh, 48) }))
  const insideJaws = (v: Float32Array): number => {
    let n = 0
    for (let i = 0; i < v.length; i += 3) if (jawTesters.some((j) => v[i]! >= j.box[0] && v[i]! <= j.box[3] && v[i + 1]! >= j.box[1] && v[i + 1]! <= j.box[4] && v[i + 2]! >= j.box[2] && v[i + 2]! <= j.box[5] && j.tester.contains(v[i]!, v[i + 1]!, v[i + 2]!))) n++
    return v.length ? r1(n / (v.length / 3), 4) : 0
  }
  if (existsSync(listFile) && existsSync(skinFile)) {
    const wanted = ((JSON.parse(readFileSync(listFile, 'utf8')) as { lipParts?: { id?: string; coverWantedMm?: number }[] }).lipParts ?? []).filter((x): x is { id: string; coverWantedMm: number } => typeof x.id === 'string' && typeof x.coverWantedMm === 'number')
    const oo = wanted.map((w) => ({ w, p: byId.get(w.id) })).find((x) => x.p && x.p.tissue === 'muscle' && roleOf(x.p) === 'driver')
    if (oo) {
      const skin = parseSkinObj(readFileSync(skinFile, 'utf8'))
      lipSkin = { tester: new InsideTester(skin, 256), surface: new SurfaceDistance(skin) }
      const S = lipSkin.surface
      const T = lipSkin.tester
      const H = 0.0005
      const cover = (x: number, y: number, z: number) => (T.contains(x, y, z) ? 1 : -1) * S.distance(x, y, z)
      const median = (a: number[]) => [...a].sort((p, q) => p - q)[a.length >> 1]!
      const vo = usedVertices(oo.p!.mesh)
      const dirSum = [0, 0, 0]
      const co: number[] = []
      for (let i = 0; i < vo.length; i += 3) {
        const x = vo[i]!
        const y = vo[i + 1]!
        const z = vo[i + 2]!
        const c = cover(x, y, z)
        co.push(c)
        // 无符号距离的负梯度指向体表；在体表之外时反号，得到“朝体表之外”的方向 / minus the gradient of the unsigned distance points to the skin; outside the skin the sign flips, which gives the direction out of the skin
        const g = [S.distance(x - H, y, z) - S.distance(x + H, y, z), S.distance(x, y - H, z) - S.distance(x, y + H, z), S.distance(x, y, z - H) - S.distance(x, y, z + H)]
        const l = (Math.hypot(g[0]!, g[1]!, g[2]!) || 1) * (c >= 0 ? 1 : -1)
        for (let a = 0; a < 3; a++) dirSum[a] = dirSum[a]! + g[a]! / l
      }
      const dl = Math.hypot(dirSum[0]!, dirSum[1]!, dirSum[2]!) || 1
      const n: [number, number, number] = [dirSum[0]! / dl, dirSum[1]! / dl, dirSum[2]! / dl]
      const A = Math.max(0, Math.min(LIP_CARRY_MAX, median(co) - oo.w.coverWantedMm / 1000))
      const index = new PointIndex(thinPoints(surfacePoints(oo.p!.mesh, 0.0015), 0.0012), 0.006)
      const weight = (x: number, y: number, z: number): number => {
        const r = index.distance(x, y, z, LIP_FADE[1])
        if (r <= LIP_FADE[0]) return 1
        if (r >= LIP_FADE[1]) return 0
        const t = 1 - (r - LIP_FADE[0]) / (LIP_FADE[1] - LIP_FADE[0])
        return t * t * (3 - 2 * t)
      }
      const fieldOf = (amount: number, hold: boolean) => (pts: Float32Array): Float32Array => {
        const out = new Float32Array(pts.length)
        for (let i = 0; i < pts.length; i += 3) {
          let a = amount * weight(pts[i]!, pts[i + 1]!, pts[i + 2]!)
          if (hold) a = Math.min(a, cover(pts[i]!, pts[i + 1]!, pts[i + 2]!) - LIP_FRONT_MIN)
          out[i] = a * n[0]
          out[i + 1] = a * n[1]
          out[i + 2] = a * n[2]
        }
        return out
      }
      const rowOf = (p: FemaleShapePart, kind: 'lip' | 'perioral', coverWantedMm: number | null, fn: (pts: Float32Array) => Float32Array): LipCarryRow => {
        const v = usedVertices(p.mesh)
        const d = fn(v)
        const amounts: number[] = []
        for (let i = 0; i < d.length; i += 3) amounts.push(Math.hypot(d[i]!, d[i + 1]!, d[i + 2]!))
        amounts.sort((p2, q) => p2 - q)
        return { id: p.id, name: p.name, kind, coverWantedMm, medianCoverBeforeMm: r1(-signedDistanceToSkin(T, S, v).medianMm), medianCoverAfterMm: null, leastCoverAfterMm: null, displacementMm: { median: r1(amounts[amounts.length >> 1]! * 1000), max: r1(amounts[amounts.length - 1]! * 1000) }, volumeMl: { before: r1(volumeMl(p), 3), after: null, change: null }, insideTeethOrJaws: { before: insideJaws(v), after: null }, carried: true }
      }
      for (const p of parts) {
        if (p.tissue !== 'muscle' || !PERIORAL_MUSCLE.test(p.name) || roleOf(p) !== 'driver') continue
        const fn = fieldOf(A, false)
        carry.set(p.id, fn)
        lipRows.push(rowOf(p, 'perioral', p.id === oo.p!.id ? oo.w.coverWantedMm : null, fn))
      }
      for (const w of wanted) {
        // 目标包里写的若是已退役的整个唇的 id（唇已切成上唇、下唇，见 lipSplit.ts），就搬运它的两半：
        // 幅度按两半的顶点合起来算一次，两半用同一个位移函数（它只取决于位置），切口上重合的点仍然重合
        // when the target package names the retired id of the whole lip (now split into upper and lower lip, see
        // lipSplit.ts) its two halves are carried: one amount from the vertices of both, one displacement function
        // for both (it depends on position only), so the coincident points of the cut stay coincident
        const whole = byId.get(w.id)
        const halves = lipPartIds(w.id)
        const group = (whole ? [whole] : [byId.get(halves.upper), byId.get(halves.lower)]).filter((p): p is FemaleShapePart => !!p && p.id !== oo.p!.id && !carry.has(p.id) && roleOf(p) === 'driver')
        if (!group.length) continue
        const c: number[] = []
        for (const p of group) {
          const v = usedVertices(p.mesh)
          for (let i = 0; i < v.length; i += 3) c.push(cover(v[i]!, v[i + 1]!, v[i + 2]!))
        }
        const fn = fieldOf(Math.max(0, Math.min(LIP_CARRY_MAX, median(c) - w.coverWantedMm / 1000)), true)
        for (const p of group) {
          carry.set(p.id, fn)
          lipRows.push(rowOf(p, 'lip', w.coverWantedMm, fn))
        }
      }
      lipRows.sort((x, y) => (x.id < y.id ? -1 : 1))
      log(`  lip carry: ${r1(A * 1000)} mm along (${n.map((x) => r1(x, 3)).join(', ')}) for orbicularis oris, fading to zero ${LIP_FADE[1] * 1000} mm from it; ${lipRows.length} parts carried`)
    }
  }

  const shape: ShapeReport = reshapeIntoEnvelope(parts, roleOf, target.envelope, { referenceVolumeMl, ...(carry.size ? { carry } : {}), ...(match.leaveRegions?.length ? { leaveRegions: match.leaveRegions } : {}) }, (l) => log(`  ${l}`))
  if (lipSkin) for (const row of lipRows) {
    const p = byId.get(row.id)!
    const v = usedVertices(p.mesh)
    const sd = signedDistanceToSkin(lipSkin.tester, lipSkin.surface, v)
    row.medianCoverAfterMm = r1(-sd.medianMm)
    row.leastCoverAfterMm = r1(-sd.maxMm)
    row.volumeMl.after = r1(volumeMl(p), 3)
    row.volumeMl.change = row.volumeMl.before > 0 ? r1(row.volumeMl.after / row.volumeMl.before - 1, 4) : null
    row.insideTeethOrJaws.after = insideJaws(v)
  }
  for (const r of lipRows) log(`    ${r.name}: moved ${r.displacementMm.median} mm (median; max ${r.displacementMm.max}); volume ${r.volumeMl.before} → ${r.volumeMl.after} ml (${r.volumeMl.change === null ? '-' : (r.volumeMl.change * 100).toFixed(1)} %); cover under the target skin median ${r.medianCoverBeforeMm} → ${r.medianCoverAfterMm} mm, least ${r.leastCoverAfterMm}${r.coverWantedMm !== null ? ` (wanted ${r.coverWantedMm})` : ''}; inside teeth or jaws ${(r.insideTeethOrJaws.before * 100).toFixed(1)} → ${((r.insideTeethOrJaws.after ?? 0) * 100).toFixed(1)} %`)
  return { ...head, applied: true, stageVersion: SHAPE_STAGE_VERSION, muscleSexRatio: MUSCLE_SEX_RATIO, freeLigaments, lipCarry: { rule: 'one smooth translation field over the whole thickness of the perioral muscles: (median cover of orbicularis oris under the target skin − cover wanted) along the mean direction out of the skin, in full within fadeMm[0] of orbicularis oris and fading to zero at fadeMm[1]; the Lip part by its own amount, held at least frontMinMm under the skin; vertices moved directly, the field carries the surroundings as far as it can', frontMinMm: LIP_FRONT_MIN * 1000, maxMm: LIP_CARRY_MAX * 1000, fadeMm: LIP_FADE.map((x) => x * 1000), parts: lipRows }, ...shape }
}
