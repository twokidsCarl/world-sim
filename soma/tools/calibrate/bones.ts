// 肱骨扭转、提携角和肘屈伸轴：两副身体的左右两侧 vs 已发表的正常范围。
// Humeral torsion, carrying angle and the elbow flexion axis: both sides of both bodies against published normal ranges.
//
// 参照是论文里的汇总统计，写在这里并带出处；不需要下载。SKEL（skel.is.tue.mpg.de）没有使用，原因见表的 notes。
// The references are summary statistics from papers, written here with their sources; no download is needed. SKEL
// (skel.is.tue.mpg.de) was not used; the table's notes say why.

import type { BodyId } from '../../src/anatomy/types.ts'
import { type V3, add, cross, deg, dot, eigSym, len, mul, norm, sub } from '../rig/math.ts'
import { BODIES, type Bilingual, type Ours, type Verdict, count, loadOurs, r1, writeTable } from './ours.ts'
import type { RefInfo } from './refs.ts'

type Side = 'L' | 'R'

export interface ArmGeometry {
  /** 肱骨头后倾（度）：横断面内肱骨头方向相对内外上髁连线，向后为正 / humeral head retroversion (degrees): direction of the head against the epicondylar line in the transverse plane, posterior positive. */
  retroversionDeg: number
  /** 同上，但相对骨架的肘屈伸轴（功能轴）而不是上髁连线 / the same against the rig's elbow flexion axis (the functional axis) instead of the epicondylar line. */
  retroversionVsFlexionAxisDeg: number
  /** 提携角（度）：肱骨冠状面内前臂轴相对肱骨干轴向外偏的角 / carrying angle (degrees): lateral deviation of the forearm axis from the humeral shaft axis in the coronal plane of the humerus. */
  carryingDeg: number
  /** 同上，但前臂轴取尺骨网格的主方向 / the same with the forearm axis taken as the principal direction of the ulna mesh. */
  carryingUlnaDeg: number | null
  /** 骨架的肘屈伸轴与肱骨干轴的夹角（度）/ angle between the rig's elbow flexion axis and the humeral shaft axis (degrees). */
  axisToShaftDeg: number
  /** 骨架的肘屈伸轴与内外上髁连线的夹角（度）/ angle between the rig's elbow flexion axis and the epicondylar line (degrees). */
  axisToEpicondylarDeg: number
  /** 屈伸轴在肱骨自身坐标系里的分量：[向外, 向前, 沿骨干向远端] / the flexion axis in the humerus' own frame: [lateral, anterior, distal along the shaft]. */
  axisInHumerus: V3
  epicondylarWidthMm: number
  humerusLengthMm: number
}

/** 主方向（协方差最大特征向量）/ principal direction (eigenvector of the largest covariance eigenvalue). */
function principal(pts: V3[]): V3 {
  const c: V3 = [0, 0, 0]
  for (const p of pts) (c[0] += p[0] / pts.length), (c[1] += p[1] / pts.length), (c[2] += p[2] / pts.length)
  const m = new Float64Array(9)
  for (const p of pts) {
    const d = sub(p, c)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] = m[i * 3 + j]! + d[i]! * d[j]!
  }
  const e = eigSym(m, 3)
  const k = e.values.indexOf(Math.max(...e.values))
  return norm(e.vectors[k] as V3)
}

/**
 * 由骨的网格和骨架的关节量出一侧上肢的几个角。肱骨头中心取骨架的盂肱关节中心（骨架构建时对关节面做的最小二乘球拟合）；
 * 骨干轴取肱骨中段（长度的 30–70%）顶点的主方向；内外上髁取远端 12% 顶点在垂直骨干的平面内最宽方向上的两个极点；
 * 前臂轴取肘关节中心到腕关节中心（静止姿势，前臂旋后）。
 * Measures the angles of one arm from the bone mesh and the rig's joints. The head centre is the rig's glenohumeral centre (a
 * least-squares sphere fitted to the articular surface when the rig was built); the shaft axis is the principal direction of
 * the vertices in the middle of the humerus (30–70 % of its length); the epicondyles are the two extreme points, along the
 * widest direction in the plane across the shaft, of the vertices in the distal 12 %; the forearm axis runs from the elbow
 * joint centre to the wrist joint centre (rest pose, forearm supinated).
 */
export function measureArm(o: Ours, side: Side): ArmGeometry | null {
  const part = o.byName.get(side === 'L' ? 'Left humerus' : 'Right humerus')?.[0]
  const mesh = part && o.body.meshes.get(part.id)
  const gh = o.joint.get(`gh_${side}`), elbow = o.joint.get(`elbow_${side}`), wrist = o.joint.get(`wrist_${side}`)
  if (!mesh || !gh || !elbow || !wrist) return null
  const pts: V3[] = []
  for (let i = 0; i < mesh.positions.length; i += 3) pts.push([mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!])
  // 粗轴：整根骨的主方向，指向远端 / rough axis: principal direction of the whole bone, pointing distally
  let u = principal(pts)
  if (dot(u, sub(elbow.center as V3, gh.center as V3)) < 0) u = mul(u, -1)
  const t = pts.map((p) => dot(p, u))
  const t0 = Math.min(...t), t1 = Math.max(...t), L = t1 - t0
  const mid = pts.filter((_, i) => t[i]! > t0 + 0.3 * L && t[i]! < t0 + 0.7 * L)
  let shaft = principal(mid)
  if (dot(shaft, u) < 0) shaft = mul(shaft, -1)
  const midC = mul(mid.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / mid.length)
  const across = (p: V3): V3 => {
    const d = sub(p, midC)
    return sub(d, mul(shaft, dot(d, shaft)))
  }
  // 远端：垂直骨干平面内最宽的方向及其两个极点 / distal end: the widest direction across the shaft and its two extreme points
  const ts = pts.map((p) => dot(sub(p, midC), shaft))
  const tMax = Math.max(...ts), tMin = Math.min(...ts)
  const distal = pts.filter((_, i) => ts[i]! > tMax - 0.12 * (tMax - tMin)).map(across)
  const w = principal(distal)
  const proj = distal.map((d) => dot(d, w))
  const eA = distal[proj.indexOf(Math.max(...proj))]!, eB = distal[proj.indexOf(Math.min(...proj))]!
  // 向外的方向：左侧身体的外侧是 +x / the lateral direction: lateral is +x on the body's left
  let lateral = norm(sub(eA, eB))
  if (lateral[0] * (side === 'L' ? 1 : -1) < 0) lateral = mul(lateral, -1)
  // 向前：与骨干和内外方向都垂直，取 +z 一侧 / anterior: perpendicular to shaft and lateral, on the +z side
  let anterior = norm(cross(shaft, lateral))
  if (anterior[2] < 0) anterior = mul(anterior, -1)
  const head = across(gh.center as V3)
  const medial = mul(lateral, -1)
  const retro = deg(Math.atan2(-dot(head, anterior), dot(head, medial)))
  const f = sub(wrist.center as V3, elbow.center as V3)
  const carrying = deg(Math.atan2(dot(f, lateral), dot(f, shaft)))
  let axis = norm(elbow.axes[0] as V3)
  if (dot(axis, lateral) < 0) axis = mul(axis, -1)
  // 以屈伸轴代替上髁连线重新定“内侧”和“前方” / "medial" and "anterior" again, with the flexion axis in place of the epicondylar line
  const medialF = norm(sub(mul(axis, -1), mul(shaft, dot(mul(axis, -1), shaft))))
  let anteriorF = norm(cross(shaft, medialF))
  if (anteriorF[2] < 0) anteriorF = mul(anteriorF, -1)
  const retroF = deg(Math.atan2(-dot(head, anteriorF), dot(head, medialF)))
  const ulna = o.byName.get(side === 'L' ? 'Left ulna' : 'Right ulna')?.[0]
  const um = ulna && o.body.meshes.get(ulna.id)
  let carryingUlna: number | null = null
  if (um) {
    const up: V3[] = []
    for (let i = 0; i < um.positions.length; i += 3) up.push([um.positions[i]!, um.positions[i + 1]!, um.positions[i + 2]!])
    let ua = principal(up)
    if (dot(ua, f) < 0) ua = mul(ua, -1)
    carryingUlna = r1(deg(Math.atan2(dot(ua, lateral), dot(ua, shaft))))
  }
  const ang = (a: V3, b: V3): number => deg(Math.acos(Math.max(-1, Math.min(1, dot(a, b)))))
  return {
    retroversionDeg: r1(retro), retroversionVsFlexionAxisDeg: r1(retroF), carryingDeg: r1(carrying), carryingUlnaDeg: carryingUlna, axisToShaftDeg: r1(ang(axis, shaft)), axisToEpicondylarDeg: r1(ang(axis, lateral)),
    axisInHumerus: [dot(axis, lateral), dot(axis, anterior), dot(axis, shaft)].map((x) => Math.round(x * 1000) / 1000) as V3,
    epicondylarWidthMm: r1(1000 * len(sub(eA, eB))), humerusLengthMm: r1(1000 * L),
  }
}

const OPENED = '2026-10-13'
export const BONE_SOURCES: Record<string, RefInfo> = {
  boileau: { id: 'boileau2008', name: 'Boileau et al. 2008, Clin Orthop Relat Res 466:661–669: CT scan method accurately assesses humeral head retroversion', version: 'PMC2505224; 65 fresh cadaveric humeri (52 paired); abstract', url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=2505224', licence: 'Free to read in PMC; © The Association of Bone and Joint Surgeons; no open licence', clause: 'No licence grant; two numbers of the abstract are cited as facts.', opened: OPENED },
  oswald: { id: 'oswald2026', name: 'Oswald et al. 2026, JSES Int: prediction of humeral torsion from proximal humerus CT', version: 'PMC13571542; statements about earlier literature', url: 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC13571542/fullTextXML', licence: 'CC BY 4.0', clause: 'Licence link in the article XML: creativecommons.org/licenses/by/4.0.', opened: OPENED },
  bhattacharyya: { id: 'bhattacharyya2022', name: 'Bhattacharyya et al. 2022, Indian J Orthop: carrying angle of the elbow in a North-East Indian population, a clinico-radiological study', version: 'PMC8854536; 384 adults (214 men, 170 women), 20–74 y; abstract', url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=8854536', licence: 'Free to read in PMC; © Indian Orthopaedics Association; no open licence', clause: 'No licence grant; means and SDs of the abstract are cited as facts.', opened: OPENED },
  yang: { id: 'yang2024', name: 'Yang et al. 2024, BMC Musculoskelet Disord: CT-based measurement of distal humerus morphology in healthy adults from Northern China', version: 'PMC11445982; 80 adults, CT with 3D reconstruction', url: 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC11445982/fullTextXML', licence: 'CC BY-NC-ND 4.0', clause: 'Licence link in the article XML: creativecommons.org/licenses/by-nc-nd/4.0. Only the mean and SD of one angle are quoted as facts.', opened: OPENED },
}

export interface BoneRow {
  body: BodyId
  side: Side | 'L−R'
  quantity: string
  oursDeg: number
  source: string
  refCentralDeg: number | null
  refLowDeg: number | null
  refHighDeg: number | null
  band: string
  quote: string
  verdict: Verdict
  note?: Bilingual
}

/** 女性按性别取值的提携角：均值、标准差 / carrying angle by sex and side: mean, SD. */
const CARRY: Record<BodyId, Record<Side, [number, number]>> = { male: { R: [12.55, 2.3], L: [12.27, 2.43] }, female: { R: [14.53, 2.34], L: [14.06, 3.37] } }
const CARRY_QUOTE = 'In males, the mean carrying angle of the right elbow was found to be 12.55 ± 2.3° and of the left was found to be 12.27 ± 2.43°, while in females, the mean carrying angle of the right elbow was found to be 14.53 ± 2.34° and 14.06 ± 3.37° in the left'

export async function boneRows(): Promise<{ rows: BoneRow[]; measured: Record<string, Record<string, ArmGeometry | null>> }> {
  const rows: BoneRow[] = []
  const measured: Record<string, Record<string, ArmGeometry | null>> = {}
  const inBand = (v: number, lo: number, hi: number): Verdict => (v >= lo && v <= hi ? 'within' : 'outside')
  for (const id of BODIES) {
    const o = await loadOurs(id)
    const g = { L: measureArm(o, 'L'), R: measureArm(o, 'R') }
    measured[id] = g
    for (const side of ['L', 'R'] as Side[]) {
      const a = g[side]
      if (!a) continue
      rows.push({ body: id, side, quantity: 'humeral head retroversion against the epicondylar line', oursDeg: a.retroversionDeg, source: 'oswald2026', refCentralDeg: 17.9, refLowDeg: 12, refHighDeg: 36, band: 'range of the mean values reported for healthy humeri (12°–36°), not a range of individuals', quote: 'Oswald 2026: "reported mean healthy humeral torsion values vary widely (range, 12° to 36°)"; Boileau 2008 (abstract): "The retroversion with respect to the transepicondylar axis was 17.9°"', verdict: a.retroversionDeg >= 12 && a.retroversionDeg <= 36 ? 'within' : 'not comparable', note: a.retroversionDeg >= 12 && a.retroversionDeg <= 36 ? undefined : { zh: '落在已发表“均值”的范围之外；个体的正常范围更宽，但没有能逐字核对的公开数值（Boileau 2008 全文里的标准差 13.7°、范围 −6.7° 到 47.5° 只经摘要模型转述，未逐字核对）。负值表示肱骨头指向内外上髁连线的前方，即前倾。是否异常请看左右差那一行。', en: 'Outside the range of published means; the normal range of individuals is wider, but no openly verifiable figure for it was found (the SD of 13.7° and the range −6.7° to 47.5° in the full text of Boileau 2008 were only relayed by a summarising model and not checked verbatim). A negative value means the head points anterior of the epicondylar line, i.e. anteversion. For abnormality see the left-minus-right row.' } })
      const [m, sd] = CARRY[id][side]
      rows.push({ body: id, side, quantity: 'carrying angle (forearm axis against humeral shaft, coronal plane of the humerus)', oursDeg: a.carryingDeg, source: 'bhattacharyya2022', refCentralDeg: m, refLowDeg: r1(m - 2 * sd), refHighDeg: r1(m + 2 * sd), band: 'mean ± 2 SD', quote: CARRY_QUOTE, verdict: inBand(a.carryingDeg, m - 2 * sd, m + 2 * sd) })
      rows.push({ body: id, side, quantity: 'elbow flexion axis against humeral shaft axis', oursDeg: a.axisToShaftDeg > 90 ? r1(180 - a.axisToShaftDeg) : a.axisToShaftDeg, source: 'yang2024', refCentralDeg: 86.22, refLowDeg: 79.7, refHighDeg: 92.8, band: 'mean ± 2 SD', quote: 'HAA (°) 86.22 ± 3.27 (angle formed by the humeral shaft axis and the flexion axis of the distal humerus on the radial side in the coronal plane); Right 85.41 ± 3.07°, Left 86.88 ± 3.31°', verdict: inBand(a.axisToShaftDeg > 90 ? 180 - a.axisToShaftDeg : a.axisToShaftDeg, 79.7, 92.8), note: { zh: '参照的角在冠状面内、取桡侧；我们的是三维夹角折到 0–90°，所以只在偏离垂直的大小上可比。', en: 'The reference angle is taken in the coronal plane on the radial side; ours is the 3D angle folded to 0–90°, so only the amount off perpendicular is comparable.' } })
    }
    if (g.L && g.R) {
      const dT = r1(g.L.retroversionDeg - g.R.retroversionDeg)
      rows.push({ body: id, side: 'L−R', quantity: 'side difference of humeral head retroversion', oursDeg: dT, source: 'oswald2026', refCentralDeg: 6.9, refLowDeg: 0, refHighDeg: 17.5, band: 'mean + 2 SD of the absolute bilateral difference (6.9° ± 5.3°)', quote: 'Oswald 2026: "the previously reported mean bilateral difference in torsion of 6.9° ± 5.3°" (cited to an earlier 3D-CT study that was not opened); Boileau 2008 (abstract): "The difference between the right and left humeri was 8.9°."', verdict: Math.abs(dT) <= 17.5 ? 'within' : 'outside' })
      const dC = r1(g.L.carryingDeg - g.R.carryingDeg)
      rows.push({ body: id, side: 'L−R', quantity: 'side difference of carrying angle', oursDeg: dC, source: 'bhattacharyya2022', refCentralDeg: id === 'male' ? -0.28 : -0.47, refLowDeg: null, refHighDeg: null, band: 'difference of the group means only; no paired SD in an open source', quote: CARRY_QUOTE, verdict: 'not comparable', note: { zh: '公开来源里没有同一人左右差的标准差，只有两侧均值相差不到 0.5°。', en: 'No open source gives the SD of the within-person side difference; the two group means differ by less than 0.5°.' } })
      // 两侧屈伸轴在各自肱骨坐标系里的夹角（坐标系本身已左右对称）/ angle between the two flexion axes, each in its own humerus frame (the frames are mirror-symmetric by construction)
      const a = g.L.axisInHumerus, b = g.R.axisInHumerus
      const between = r1(deg(Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b)))))))
      rows.push({ body: id, side: 'L−R', quantity: 'angle between the left and right elbow flexion axes, each expressed in its own humerus frame', oursDeg: between, source: 'yang2024', refCentralDeg: 1.47, refLowDeg: null, refHighDeg: null, band: 'difference of unpaired group means in one plane (86.88° left vs 85.41° right); no paired SD in an open source', quote: 'HAA: Right 85.41 ± 3.07°, Left 86.88 ± 3.31°, P = 0.045', verdict: 'not comparable', note: { zh: '参照只有不同人的左、右两组均值之差（一个平面内 1.5°）。另一篇打开过的尸体研究（Schwarz 等 2025，PMC12222642）报告屈伸轴的轴向旋转左右高度相关（r = 0.906）、两侧均值 12.8° 和 13.4°，同样没有配对差的标准差。', en: 'The reference offers only the difference between group means of different people (1.5° in one plane). Another opened cadaver study (Schwarz et al. 2025, PMC12222642) reports that the axial rotation of the flexion axis is highly correlated between sides (r = 0.906) with side means of 12.8° and 13.4°, again without an SD of the paired difference.' } })
    }
  }
  return { rows, measured }
}

export async function runBones(log: (m: string) => void): Promise<void> {
  const { rows, measured } = await boneRows()
  const ours = await Promise.all(BODIES.map(loadOurs))
  writeTable<BoneRow & { geometry?: ArmGeometry }>({
    schema: 1, id: 'arm-bones', title: { zh: '肱骨扭转、提携角和肘屈伸轴', en: 'Humeral torsion, carrying angle and the elbow flexion axis' },
    method: {
      zh: '由肱骨网格和骨架的关节量出：肱骨头中心取盂肱关节中心（构建骨架时对关节面的球拟合）；骨干轴取肱骨中段顶点的主方向；内外上髁取远端 12% 顶点在垂直骨干平面内最宽方向上的两个极点。后倾角 = 垂直骨干的平面内，“骨干轴 → 肱骨头中心”的方向相对“指向内侧的上髁连线”的夹角，肱骨头偏后为正（即后倾，文献中的常规）。提携角 = 肱骨冠状面（骨干轴与上髁连线张成）内，肘关节中心 → 腕关节中心的方向相对骨干轴向外偏的角；量的是静止姿势（肘约屈 12°、前臂旋后），不是完全伸直。肘屈伸轴取骨架的 elbow 关节的 axes[0]。',
      en: 'Measured from the humerus mesh and the rig\'s joints: the head centre is the glenohumeral joint centre (a sphere fitted to the articular surface when the rig was built); the shaft axis is the principal direction of the mid-shaft vertices; the epicondyles are the two extreme points, along the widest direction across the shaft, of the vertices in the distal 12 %. Retroversion = in the plane across the shaft, the angle of the direction "shaft axis → head centre" against the medially pointing epicondylar line, positive when the head lies posterior (retroversion, the usual convention). Carrying angle = in the coronal plane of the humerus (spanned by shaft axis and epicondylar line), the lateral deviation of the direction elbow centre → wrist centre from the shaft axis; it is measured in the rest pose (elbow about 12° flexed, forearm supinated), not in full extension. The elbow flexion axis is axes[0] of the rig\'s elbow joint.',
    },
    tolerance: { zh: '每行的 band 写明区间的来历；有均值和标准差的取 ± 2 SD。没有可核对的个体范围或配对差标准差时记为 not comparable，并说明原因。', en: 'Every row\'s `band` says where its interval comes from; mean ± 2 SD where a mean and SD exist. Where no verifiable range of individuals or SD of a paired difference exists the row is "not comparable", with the reason.' },
    references: Object.values(BONE_SOURCES), ourState: Object.fromEntries(ours.map((o) => [o.id, o.state])),
    notes: [
      { zh: '骨的网格很粗（每根肱骨约 650 个三角形），上髁极点和骨干轴各有约 2–3° 的不确定度；女性的右前臂和右手是左侧的镜像，她的右侧提携角因此不是独立的测量。', en: 'The bone meshes are coarse (about 650 triangles per humerus), so the epicondylar points and the shaft axis each carry an uncertainty of about 2–3°; the female\'s right forearm and hand are a mirrored left, so her right carrying angle is not an independent measurement.' },
      { zh: 'SKEL（skel.is.tue.mpg.de）没有使用：它的许可是“仅限非商业科学研究”的单用户许可，下载即视为接受条款并需要注册；条款写明数据和软件“不得复制、修改或以任何形式提供给第三方”。本项目是公开仓库、不能代用户接受协议，所以没有下载。', en: 'SKEL (skel.is.tue.mpg.de) was not used: its licence is a single-user licence "for non-commercial scientific research purposes", accepted by downloading and requiring registration, and it states that the data and software may not be "reproduced, modified and/or made available in any form to any third party". This is a public repository and no agreement may be accepted on the user\'s behalf, so nothing was downloaded.' },
    ],
    summary: { rows: rows.length, within: count(rows, (r) => r.verdict === 'within'), outside: count(rows, (r) => r.verdict === 'outside'), notComparable: count(rows, (r) => r.verdict === 'not comparable'), ...Object.fromEntries(BODIES.flatMap((b) => (['L', 'R'] as Side[]).map((s) => [`${b}_${s}`, measured[b]?.[s] ? `retroversion ${measured[b]![s]!.retroversionDeg}° (vs flexion axis ${measured[b]![s]!.retroversionVsFlexionAxisDeg}°), carrying ${measured[b]![s]!.carryingDeg}° (ulna axis ${measured[b]![s]!.carryingUlnaDeg}°), axis-to-shaft ${measured[b]![s]!.axisToShaftDeg}°, axis-to-epicondylar ${measured[b]![s]!.axisToEpicondylarDeg}°, epicondylar width ${measured[b]![s]!.epicondylarWidthMm} mm` : 'not measured']))) },
    rows,
  })
  log(`arm-bones: ${rows.length} rows`)
}
