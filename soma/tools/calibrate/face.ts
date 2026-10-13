// 面部参照：ARKit 的 52 个系数、MediaPipe Face Landmarker 的类别表、ICT-FaceKit 的表情形状、OpenRigLogic 的控制结构。
// Facial references: the 52 ARKit coefficients, the category list of MediaPipe Face Landmarker, the expression shapes of
// ICT-FaceKit and the control structure of OpenRigLogic.
//
// 写出的表 / tables written
//   face-coverage.json       每个系数对应我们的哪个 AU / 通道（或没有），以及反过来每个 AU 对应哪些系数
//   face-displacement.json   满强度时皮肤最大位移的量级：我们的 AU vs ICT-FaceKit 的形状
// which of our AUs / channels corresponds to each coefficient (or none) and the reverse; and the order of magnitude of the
// largest skin displacement at full intensity, our AUs against ICT-FaceKit shapes.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BodyId } from '../../src/anatomy/types.ts'
import type { FaceData } from '../../src/face/types.ts'
import { AU_MAX, activations, displacement } from '../face/model.ts'
import { Poser } from '../rig/pose.ts'
import { BODIES, type Bilingual, type Verdict, count, loadOurs, r1, r2, writeTable } from './ours.ts'
import { RAW, REFS, ROOT, refInfo } from './refs.ts'

/** ARKit 的 52 个系数名（标识符）。下载存在时会与 Apple 的文档 JSON 和 MediaPipe 的源码逐一核对。 The 52 ARKit coefficient identifiers. When the downloads are present they are checked one by one against Apple's documentation JSON and MediaPipe's source. */
export const ARKIT = [
  'eyeBlinkLeft', 'eyeLookDownLeft', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft', 'eyeSquintLeft', 'eyeWideLeft',
  'eyeBlinkRight', 'eyeLookDownRight', 'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpRight', 'eyeSquintRight', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawRight', 'jawOpen', 'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthPressLeft', 'mouthPressRight',
  'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight', 'noseSneerLeft', 'noseSneerRight', 'tongueOut',
] as const

type Coverage = 'covered' | 'partial' | 'none'

/**
 * 系数（去掉 Left/Right）→ 我们的 AU。这是本项目做的对应，依据是系数的一句话定义和 ICT-FaceKit 自己给的 FACS 对照表。
 * Coefficient (without Left/Right) → our AUs. The mapping is this project's, based on the one-line definition of each
 * coefficient and on the FACS table ICT-FaceKit gives for its own shapes.
 */
export const COEFF_MAP: Record<string, { aus: string[]; facs: string; coverage: Coverage; note: Bilingual }> = {
  eyeBlink: { aus: ['AU43'], facs: 'AU45 / AU43', coverage: 'partial', note: { zh: '我们只有两眼同时闭合，没有单侧。', en: 'Ours closes both eyes together; there is no one-sided blink.' } },
  eyeLookDown: { aus: [], facs: 'AU64', coverage: 'none', note: { zh: '没有眼球转动。', en: 'No eye rotation.' } },
  eyeLookIn: { aus: [], facs: 'AU61 / AU62', coverage: 'none', note: { zh: '没有眼球转动。', en: 'No eye rotation.' } },
  eyeLookOut: { aus: [], facs: 'AU61 / AU62', coverage: 'none', note: { zh: '没有眼球转动。', en: 'No eye rotation.' } },
  eyeLookUp: { aus: [], facs: 'AU63', coverage: 'none', note: { zh: '没有眼球转动。', en: 'No eye rotation.' } },
  eyeSquint: { aus: ['AU7'], facs: 'AU7', coverage: 'partial', note: { zh: '只有双侧。', en: 'Bilateral only.' } },
  eyeWide: { aus: ['AU5'], facs: 'AU5', coverage: 'partial', note: { zh: '只有双侧。', en: 'Bilateral only.' } },
  jawForward: { aus: [], facs: 'AU29', coverage: 'none', note: { zh: '颞下颌关节没有前伸这个自由度。', en: 'The temporomandibular joint has no protrusion dof.' } },
  jawLeft: { aus: [], facs: 'AU30', coverage: 'none', note: { zh: '骨架的 tmj 有侧方运动自由度，但没有 AU 用它。', en: 'The rig\'s tmj has a lateral dof, but no AU drives it.' } },
  jawRight: { aus: [], facs: 'AU30', coverage: 'none', note: { zh: '骨架的 tmj 有侧方运动自由度，但没有 AU 用它。', en: 'The rig\'s tmj has a lateral dof, but no AU drives it.' } },
  jawOpen: { aus: ['AU26', 'AU27'], facs: 'AU26 / AU27', coverage: 'covered', note: { zh: '下颌角由 AU26、AU27 的 jaw 分量给出。', en: 'The jaw angle comes from the jaw share of AU26 and AU27.' } },
  mouthClose: { aus: [], facs: '(closes the lips while the jaw is open)', coverage: 'none', note: { zh: '没有“张颌而闭唇”的控制。', en: 'No control that closes the lips over an open jaw.' } },
  mouthFunnel: { aus: ['AU22'], facs: 'AU22', coverage: 'covered', note: { zh: '', en: '' } },
  mouthPucker: { aus: ['AU18'], facs: 'AU18', coverage: 'covered', note: { zh: '', en: '' } },
  mouthLeft: { aus: [], facs: '(no single AU)', coverage: 'none', note: { zh: '没有单侧口部运动。', en: 'No one-sided mouth movement.' } },
  mouthRight: { aus: [], facs: '(no single AU)', coverage: 'none', note: { zh: '没有单侧口部运动。', en: 'No one-sided mouth movement.' } },
  mouthSmile: { aus: ['AU12'], facs: 'AU12', coverage: 'partial', note: { zh: '只有双侧。', en: 'Bilateral only.' } },
  mouthFrown: { aus: ['AU15'], facs: 'AU15', coverage: 'partial', note: { zh: '只有双侧。', en: 'Bilateral only.' } },
  mouthDimple: { aus: ['AU14'], facs: 'AU14', coverage: 'partial', note: { zh: '只有双侧。', en: 'Bilateral only.' } },
  mouthStretch: { aus: ['AU20'], facs: 'AU20', coverage: 'partial', note: { zh: '只有双侧。', en: 'Bilateral only.' } },
  mouthRollLower: { aus: ['AU28'], facs: 'AU28', coverage: 'partial', note: { zh: '我们的 AU28 上下唇一起卷入，不能只卷一片。', en: 'Our AU28 rolls both lips in together, not one alone.' } },
  mouthRollUpper: { aus: ['AU28'], facs: 'AU28', coverage: 'partial', note: { zh: '我们的 AU28 上下唇一起卷入，不能只卷一片。', en: 'Our AU28 rolls both lips in together, not one alone.' } },
  mouthShrugLower: { aus: ['AU17'], facs: 'AU17', coverage: 'covered', note: { zh: 'ICT-FaceKit 把它对到 AU17。', en: 'ICT-FaceKit maps it to AU17.' } },
  mouthShrugUpper: { aus: ['AU10'], facs: 'AU10 (per ICT-FaceKit)', coverage: 'partial', note: { zh: 'ICT-FaceKit 把它对到 AU10；按定义它更像上唇上推，我们没有单独的控制。', en: 'ICT-FaceKit maps it to AU10; by its definition it is more an upward push of the upper lip, for which we have no separate control.' } },
  mouthPress: { aus: ['AU24'], facs: 'AU24', coverage: 'partial', note: { zh: '只有双侧。', en: 'Bilateral only.' } },
  mouthLowerDown: { aus: ['AU16'], facs: 'AU16', coverage: 'partial', note: { zh: '只有双侧。', en: 'Bilateral only.' } },
  mouthUpperUp: { aus: ['AU10', 'AU11'], facs: 'AU10 (AU11 per ICT-FaceKit)', coverage: 'partial', note: { zh: '只有双侧；ICT-FaceKit 把它对到 AU11。', en: 'Bilateral only; ICT-FaceKit maps it to AU11.' } },
  browDown: { aus: ['AU4'], facs: 'AU4', coverage: 'partial', note: { zh: '只有双侧。', en: 'Bilateral only.' } },
  browInnerUp: { aus: ['AU1'], facs: 'AU1', coverage: 'covered', note: { zh: '', en: '' } },
  browOuterUp: { aus: ['AU2'], facs: 'AU2', coverage: 'partial', note: { zh: '只有双侧。', en: 'Bilateral only.' } },
  cheekPuff: { aus: [], facs: 'AU33 / AU34', coverage: 'none', note: { zh: '没有鼓颊。', en: 'No cheek puff.' } },
  cheekSquint: { aus: ['AU6'], facs: 'AU6', coverage: 'partial', note: { zh: '只有双侧。', en: 'Bilateral only.' } },
  noseSneer: { aus: ['AU9'], facs: 'AU9', coverage: 'partial', note: { zh: '只有双侧。', en: 'Bilateral only.' } },
  tongueOut: { aus: [], facs: 'AU19', coverage: 'none', note: { zh: '舌不参与表情。', en: 'The tongue takes no part in expressions.' } },
}

// jawLeft、mouthRight 这类名字本身就是条目，不去后缀 / names such as jawLeft and mouthRight are entries themselves and keep their suffix
const base = (c: string): string => (c in COEFF_MAP ? c : c.replace(/(Left|Right)$/, ''))
const ictName = (c: string): string => c.replace(/Left$/, '_L').replace(/Right$/, '_R')

interface CoverageRow {
  direction: 'coefficient → ours' | 'ours → coefficient'
  /** 系数名，或我们的 AU id / the coefficient, or our AU id. */
  item: string
  facs: string
  inArkitDocs: boolean | null
  inMediaPipe: boolean | null
  /** ICT-FaceKit 里对应的形状文件（没有则为 null；未下载时也为 null）/ the matching ICT-FaceKit shape (null when absent or not downloaded). */
  ictShape: string | null
  ourAus: string[]
  /** 各身体上这些 AU 驱动的通道 / the channels those AUs drive, per body. */
  ourChannels: Record<string, string[]>
  coefficients: string[]
  coverage: Coverage
  verdict: Verdict
  note: Bilingual
}

function loadFace(id: BodyId): FaceData {
  return JSON.parse(readFileSync(join(ROOT, 'public', 'anatomy', id, 'face.json'), 'utf8')) as FaceData
}

const ARKIT_JSON = join(RAW, REFS.arkit.id, 'blendshapelocation.json')
const MP_SRC = join(RAW, REFS.mediapipe.id, 'face_blendshapes_graph.cc')
const ICT_DIR = join(RAW, REFS.ict.id, 'FaceXModel')
/** ICT-FaceKit 的“全脸区域”顶点 [0, 9408]（见其 README 的表）/ ICT-FaceKit's "full face area" vertices [0, 9408] (table in its README). */
const ICT_FACE_VERTICES = 9409

function coverageRows(): { rows: CoverageRow[]; arkitChecked: boolean; mediapipeChecked: boolean } {
  const faces = Object.fromEntries(BODIES.map((b) => [b, loadFace(b)]))
  let arkitNames: Set<string> | null = null, mpNames: Set<string> | null = null
  if (existsSync(ARKIT_JSON)) {
    const j = JSON.parse(readFileSync(ARKIT_JSON, 'utf8')) as { topicSections: { title: string; identifiers: string[] }[]; references: Record<string, { title?: string }> }
    arkitNames = new Set(j.topicSections.filter((s) => !/Creating/.test(s.title)).flatMap((s) => s.identifiers.map((i) => j.references[i]?.title ?? '')))
  }
  if (existsSync(MP_SRC)) {
    const src = readFileSync(MP_SRC, 'utf8')
    const m = /kBlendshapeNames\s*=\s*\{([\s\S]*?)\};/.exec(src)
    if (m) mpNames = new Set([...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!))
  }
  const ict = existsSync(ICT_DIR)
  const channelsOf = (aus: string[]): Record<string, string[]> => Object.fromEntries(BODIES.map((b) => [b, [...new Set(faces[b]!.aus.filter((a) => aus.includes(a.id)).flatMap((a) => Object.keys(a.channels)))].sort()]))
  const have = (au: string): boolean => BODIES.every((b) => faces[b]!.aus.some((a) => a.id === au))
  const rows: CoverageRow[] = []
  for (const c of ARKIT) {
    const m = COEFF_MAP[base(c)]!
    const aus = m.aus.filter(have)
    const coverage: Coverage = aus.length ? m.coverage : 'none'
    const shape = ictName(c)
    // ICT-FaceKit 把 browInnerUp、cheekPuff 分成左右两个形状 / ICT-FaceKit splits browInnerUp and cheekPuff into left and right shapes
    const file = ict ? [`${shape}.obj`, `${shape}_L.obj`].find((f) => existsSync(join(ICT_DIR, f))) ?? null : null
    rows.push({
      direction: 'coefficient → ours', item: c, facs: m.facs, inArkitDocs: arkitNames ? arkitNames.has(c) : null, inMediaPipe: mpNames ? mpNames.has(c) : null, ictShape: file,
      ourAus: aus, ourChannels: channelsOf(aus), coefficients: [c], coverage, verdict: coverage === 'none' ? 'outside' : 'within',
      note: aus.length || !m.aus.length ? m.note : { zh: `对应的 ${m.aus.join('、')} 不在当前的 face.json 里。`, en: `The matching ${m.aus.join(', ')} is not in the current face.json.` },
    })
  }
  // 反过来：我们的每个 AU / the reverse: each of our AUs
  const allAus = [...new Set(BODIES.flatMap((b) => faces[b]!.aus.map((a) => a.id)))]
  for (const au of allAus) {
    const coeffs = ARKIT.filter((c) => COEFF_MAP[base(c)]!.aus.includes(au))
    const name = faces.male!.aus.find((a) => a.id === au)?.name ?? faces.female!.aus.find((a) => a.id === au)!.name
    rows.push({
      direction: 'ours → coefficient', item: au, facs: `${au} ${name.en}`, inArkitDocs: null, inMediaPipe: null, ictShape: null, ourAus: [au], ourChannels: channelsOf([au]), coefficients: coeffs,
      coverage: coeffs.length ? 'covered' : 'none', verdict: coeffs.length ? 'within' : 'outside',
      note: coeffs.length ? { zh: '', en: '' } : { zh: 'ARKit 的系数里没有单独对应它的。', en: 'No ARKit coefficient corresponds to it on its own.' },
    })
  }
  return { rows, arkitChecked: !!arkitNames, mediapipeChecked: !!mpNames }
}

// ── 位移量级 / displacement magnitudes ───────────────────────────────────────────────────────

/** 我们的 AU ↔ ICT-FaceKit 的形状，取自 ICT-FaceKit README 里它自己的 FACS 对照表（AU43 ↔ AU45 眨眼是本项目加的）。 Our AU ↔ ICT-FaceKit shapes, from the FACS table in ICT-FaceKit's own README (AU43 ↔ AU45 blink is this project's addition). */
export const ICT_AU: [string, string[], string][] = [
  ['AU1', ['browInnerUp_L', 'browInnerUp_R'], 'brow'], ['AU2', ['browOuterUp_L', 'browOuterUp_R'], 'brow'], ['AU4', ['browDown_L', 'browDown_R'], 'brow'],
  ['AU5', ['eyeWide_L', 'eyeWide_R'], 'lid'], ['AU6', ['cheekSquint_L', 'cheekSquint_R'], 'cheek'], ['AU7', ['eyeSquint_L', 'eyeSquint_R'], 'lid'], ['AU43', ['eyeBlink_L', 'eyeBlink_R'], 'lid'],
  ['AU9', ['noseSneer_L', 'noseSneer_R'], 'nose'], ['AU10', ['mouthShrugUpper'], 'lip'], ['AU11', ['mouthUpperUp_L', 'mouthUpperUp_R'], 'lip'], ['AU18', ['mouthPucker'], 'lip'], ['AU22', ['mouthFunnel'], 'lip'], ['AU28', ['mouthRollLower', 'mouthRollUpper'], 'lip'], ['AU12', ['mouthSmile_L', 'mouthSmile_R'], 'mouth corner'], ['AU14', ['mouthDimple_L', 'mouthDimple_R'], 'mouth corner'],
  ['AU15', ['mouthFrown_L', 'mouthFrown_R'], 'mouth corner'], ['AU16', ['mouthLowerDown_L', 'mouthLowerDown_R'], 'lip'], ['AU17', ['mouthShrugLower'], 'chin'],
  ['AU20', ['mouthStretch_L', 'mouthStretch_R'], 'mouth corner'], ['AU24', ['mouthPress_L', 'mouthPress_R'], 'lip'], ['AU27', ['jawOpen'], 'jaw'],
]

function objVertices(path: string, limit: number): Float64Array {
  const out = new Float64Array(limit * 3)
  let n = 0
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.startsWith('v ')) continue
    const a = line.split(/\s+/)
    out[n * 3] = Number(a[1])
    out[n * 3 + 1] = Number(a[2])
    out[n * 3 + 2] = Number(a[3])
    if (++n >= limit) break
  }
  return out
}

interface DisplacementRow {
  body: BodyId
  au: string
  region: string
  ictShapes: string[]
  /** AU 强度 5 时皮肤顶点的最大位移（毫米）/ largest displacement of a skin vertex at AU intensity 5, mm. */
  oursMm: number
  /** 其中由下颌关节转动产生的部分（只有带 jaw 的 AU）/ the part of it produced by the jaw joint (AUs with a jaw share only). */
  oursJawMm: number | null
  /** ICT 形状权重为 1 时全脸区域顶点的最大位移（毫米；模型单位是厘米），左右两个形状同时为 1 / largest displacement over the full-face vertices at shape weight 1 (mm; the model is in centimetres), both sides at 1. */
  refMm: number
  ratio: number
  toleranceFactor: 2
  verdict: Verdict
}

async function displacementRows(): Promise<DisplacementRow[]> {
  const neutral = objVertices(join(ICT_DIR, 'generic_neutral_mesh.obj'), ICT_FACE_VERTICES)
  const refMax = new Map<string, number>()
  for (const [au, shapes] of ICT_AU) {
    const sum = new Float64Array(ICT_FACE_VERTICES * 3)
    for (const s of shapes) {
      const v = objVertices(join(ICT_DIR, `${s}.obj`), ICT_FACE_VERTICES)
      for (let i = 0; i < sum.length; i++) sum[i] = sum[i]! + v[i]! - neutral[i]!
    }
    let m = 0
    for (let i = 0; i < ICT_FACE_VERTICES; i++) m = Math.max(m, Math.hypot(sum[i * 3]!, sum[i * 3 + 1]!, sum[i * 3 + 2]!))
    refMax.set(au, m * 10)
  }
  const rows: DisplacementRow[] = []
  for (const id of BODIES) {
    const o = await loadOurs(id)
    const face = loadFace(id)
    const bin = new Uint8Array(readFileSync(join(ROOT, 'public', 'anatomy', id, 'face.bin')))
    const rest = o.body.meshes.get(face.skin)!.positions
    const n = rest.length / 3
    for (const [au, shapes, region] of ICT_AU) {
      if (!face.aus.some((a) => a.id === au)) continue
      const act = activations(face, { [au]: AU_MAX })
      const d = displacement(face.channels, bin, face.skin, n, act.channels)
      let jawMm: number | null = null
      let posed: Float32Array | null = null
      if (act.jaw > 0) {
        // 下颌转动：把位移后的皮肤再经骨架蒙皮 / jaw rotation: the displaced skin is then skinned by the rig
        const j = o.joint.get(face.jaw.joint)!
        const pose = { [face.jaw.joint]: j.dofs.map((_, k) => (k === face.jaw.dof ? act.jaw : 0)) }
        const poser = new Poser(o.rig, o.bin, pose)
        const moved = Float32Array.from(rest, (v, i) => v + d[i]!)
        posed = poser.part(face.skin, moved, 'dqs', false)
        const only = poser.part(face.skin, rest, 'dqs', false)
        jawMm = 0
        for (let i = 0; i < n; i++) jawMm = Math.max(jawMm, 1000 * Math.hypot(only[i * 3]! - rest[i * 3]!, only[i * 3 + 1]! - rest[i * 3 + 1]!, only[i * 3 + 2]! - rest[i * 3 + 2]!))
      }
      let m = 0
      for (let i = 0; i < n; i++) {
        const dx = posed ? posed[i * 3]! - rest[i * 3]! : d[i * 3]!, dy = posed ? posed[i * 3 + 1]! - rest[i * 3 + 1]! : d[i * 3 + 1]!, dz = posed ? posed[i * 3 + 2]! - rest[i * 3 + 2]! : d[i * 3 + 2]!
        m = Math.max(m, 1000 * Math.hypot(dx, dy, dz))
      }
      const ref = refMax.get(au)!
      const ratio = m / ref
      rows.push({ body: id, au, region, ictShapes: shapes, oursMm: r1(m), oursJawMm: jawMm === null ? null : r1(jawMm), refMm: r1(ref), ratio: r2(ratio), toleranceFactor: 2, verdict: ratio >= 0.5 && ratio <= 2 ? 'within' : 'outside' })
    }
  }
  return rows
}

export const faceAvailable = (): { ict: boolean } => ({ ict: existsSync(join(ICT_DIR, 'generic_neutral_mesh.obj')) })

export async function runFace(log: (m: string) => void): Promise<void> {
  const cov = coverageRows()
  const c2o = cov.rows.filter((r) => r.direction === 'coefficient → ours'), o2c = cov.rows.filter((r) => r.direction === 'ours → coefficient')
  writeTable<CoverageRow>({
    schema: 1, id: 'face-coverage', title: { zh: '面部控制的覆盖：ARKit / MediaPipe 的系数 vs 我们的动作单元', en: 'Coverage of facial controls: ARKit / MediaPipe coefficients vs our action units' },
    method: {
      zh: '逐个系数（ARKit 的 52 个标识符），列出我们哪个 AU 表达同一个动作、这些 AU 在两副身体上驱动哪些肌肉通道；再反过来逐个 AU 列出对应的系数。对应关系是本项目做的，依据系数的一句话定义和 ICT-FaceKit 给自己形状的 FACS 对照表。covered = 有同样的控制；partial = 有，但我们只有双侧同时动（或定义不完全相同）；none = 没有。没有单独对应系数的 AU 列在 summary.ourAusWithout 里（例如 AU23 唇收紧，ARKit 最接近的是 mouthPress；AU25 唇分开，最接近的是 jawOpen 减去 mouthClose）。AU 的集合读自当前的 face.json；对应表里列的 AU 不在其中时该行记为 none。下载存在时，系数名与 Apple 文档 JSON、MediaPipe 源码里的名单逐一核对，结果写在 inArkitDocs / inMediaPipe。',
      en: 'For each coefficient (the 52 ARKit identifiers): which of our AUs expresses the same movement and which muscle channels those AUs drive on the two bodies; then the reverse, per AU. The mapping is this project\'s, based on the one-line definition of each coefficient and on the FACS table ICT-FaceKit gives for its own shapes. covered = the same control exists; partial = it exists, but ours moves both sides together (or the definition differs somewhat); none = absent. AUs without a coefficient of their own are listed in summary.ourAusWithout (for example AU23, lip tightener, whose nearest is mouthPress, and AU25, lips part, whose nearest is jawOpen less mouthClose). The set of AUs is read from the current face.json; a row whose mapped AU is not in it becomes none. When the downloads are present the names are checked one by one against Apple\'s documentation JSON and the list in MediaPipe\'s source, recorded in inArkitDocs / inMediaPipe.',
    },
    tolerance: { zh: '不是数值比较：covered / partial 记 within，none 记 outside。', en: 'Not a numeric comparison: covered / partial count as within, none as outside.' },
    references: [refInfo(REFS.arkit), refInfo(REFS.mediapipe), refInfo(REFS.ict), refInfo(REFS.openriglogic)],
    ourState: Object.fromEntries(BODIES.map((b) => [b, { aus: loadFace(b).aus.map((a) => a.id).join(' '), channels: String(loadFace(b).channels.length) }])),
    notes: [
      { zh: 'OpenRigLogic（MetaHuman 面部解算器的开源部分）没有可比的控制名单：仓库里只有读 DNA 文件和求值的代码与文档，原始控制（raw control）和界面控制（GUI control）的名字存在每个角色的 DNA 文件的 Definition 层里（DefinitionReader::getRawControlName / getGUIControlName），仓库里没有任何 .dna 文件，也没有控制名的清单。按要求没有下载 MetaHuman 的 DNA，所以“它有哪些控制、张成怎样的 FACS 集合”这一问没有回答。从它的设计文档能读到的只有结构：输入是表情级的控制值 → PSD（多个控制相乘得到的组合/修正表情）→ 关节变换、混合形状权重、动画贴图系数；没有肌肉层。', en: 'OpenRigLogic (the open part of the MetaHuman facial solver) offers no comparable list of controls: the repository holds only the code and documentation that read a DNA file and evaluate it, while the names of raw controls and GUI controls live in the Definition layer of each character\'s DNA file (DefinitionReader::getRawControlName / getGUIControlName); the repository contains no .dna file and no list of control names. As instructed, no MetaHuman DNA was downloaded, so the question of which controls exist and what FACS-like set they span is left unanswered. What its design document does give is the structure: expression-level control values in → PSDs (combination / corrective expressions formed as products of controls) → joint transforms, blend-shape weights and animated-map multipliers; there is no muscle layer.' },
      { zh: 'MediaPipe 的名单是 "_neutral" 加 51 个 ARKit 名，没有 tongueOut；所以两个“52”不是同一个集合。ICT-FaceKit 没有 tongueOut，另把 browInnerUp、cheekPuff 分成左右，并多出 cheekRaiser、PupilDilate。', en: 'MediaPipe\'s list is "_neutral" plus 51 ARKit names, without tongueOut, so the two "52"s are not the same set. ICT-FaceKit has no tongueOut, splits browInnerUp and cheekPuff into left and right, and adds cheekRaiser and PupilDilate.' },
      { zh: 'Apple 的文档只把系数定义为 0.0（中性）到 1.0（最大运动），不给位移的度量；这里只读了索引页的 JSON，没有逐个打开 52 个系数页。', en: 'Apple\'s documentation defines a coefficient only as 0.0 (neutral) to 1.0 (maximum movement) and gives no metric displacement; only the index page\'s JSON was read, not the 52 per-coefficient pages.' },
    ],
    summary: {
      coefficients: c2o.length, covered: count(c2o, (r) => r.coverage === 'covered'), partial: count(c2o, (r) => r.coverage === 'partial'), none: count(c2o, (r) => r.coverage === 'none'),
      ourAus: o2c.length, ourAusWithCoefficient: count(o2c, (r) => r.coverage !== 'none'), ourAusWithout: o2c.filter((r) => r.coverage === 'none').map((r) => r.item).join(' '),
      namesCheckedAgainstArkitDocs: String(cov.arkitChecked), namesCheckedAgainstMediaPipe: String(cov.mediapipeChecked),
      arkitNamesMissingFromMediaPipe: c2o.filter((r) => r.inMediaPipe === false).map((r) => r.item).join(' '),
    },
    rows: cov.rows,
  })
  log(`face-coverage: ${cov.rows.length} rows`)
  if (!faceAvailable().ict) {
    log('face-displacement: ICT-FaceKit not under data/raw/calibration; table left as it is')
    return
  }
  const rows = await displacementRows()
  rows.sort((a, b) => Math.abs(Math.log(b.ratio || 1e-6)) - Math.abs(Math.log(a.ratio || 1e-6)))
  const ours = await Promise.all(BODIES.map(loadOurs))
  writeTable<DisplacementRow>({
    schema: 1, id: 'face-displacement', title: { zh: '表情位移的量级：我们的 AU（强度 5）vs ICT-FaceKit 的形状（权重 1）', en: 'Magnitude of expression displacement: our AUs (intensity 5) vs ICT-FaceKit shapes (weight 1)' },
    method: {
      zh: '我们：AU 强度 5（最大）时皮肤顶点的最大位移，用 tools/face/model.ts 的 activations 和 displacement 求得；带 jaw 分量的 AU 再经骨架蒙皮（oursJawMm 是只转下颌时的最大位移）。参照：ICT-FaceKit 通用中性脸与对应表情形状（左右两个同时取 1）之差在“全脸区域”顶点 [0, 9408] 上的最大值，模型单位是厘米。AU ↔ 形状的对应取自 ICT-FaceKit 自己的 FACS 对照表。没有按脸的大小缩放（ICT 通用脸的全脸区域宽 184 mm）。',
      en: 'Ours: the largest displacement of a skin vertex at AU intensity 5 (the maximum), from `activations` and `displacement` of tools/face/model.ts; AUs with a jaw share are then skinned by the rig (oursJawMm is the largest displacement from the jaw rotation alone). Reference: the largest difference between ICT-FaceKit\'s generic neutral face and the matching expression shapes (both sides at 1) over the "full face area" vertices [0, 9408]; the model is in centimetres. The AU ↔ shape mapping is ICT-FaceKit\'s own FACS table. Nothing is scaled for face size (the full-face area of the ICT generic face is 184 mm wide).',
    },
    tolerance: { zh: '只比量级：比值在 0.5–2 之间记 within。ICT 的形状是美术师为一张通用脸做的满幅表情，不是测量值；FACS 的强度是序数等级，不是位移。', en: 'Order of magnitude only: a ratio between 0.5 and 2 counts as within. The ICT shapes are artist-made full-range expressions on a generic face, not measurements, and FACS intensities are ordinal grades, not displacements.' },
    references: [refInfo(REFS.ict)], ourState: Object.fromEntries(ours.map((o) => [o.id, o.state])),
    notes: [{ zh: '最大位移是单个顶点的值，对局部的尖峰敏感；它回答的是“量级对不对”，不是“形状像不像”。', en: 'The largest displacement is a single-vertex value and sensitive to local spikes; it answers whether the magnitude is right, not whether the shape is alike.' }],
    summary: { rows: rows.length, within: count(rows, (r) => r.verdict === 'within'), outside: count(rows, (r) => r.verdict === 'outside') }, rows,
  })
  log(`face-displacement: ${rows.length} rows`)
}
