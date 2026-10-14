// 骨架绑定的构建：读入一个已生成的人体 → 关节、活动范围、绑定、肌肉作用线 → Rig + rig.bin。
// The rig build: read a generated body → joints, ranges of motion, bindings, muscle lines → Rig + rig.bin.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MuscleLine, Rig, RigBinding } from '../../src/anatomy/types.ts'
import { type AttachReport, type AttachmentPatch, type BindRules, type BoundPart, bindAll } from './bind.ts'
import { type Calibration, calibrateMuscles } from './calibrate.ts'
import { type ExternalWeights, loadExternalWeights } from './external.ts'
import { BodyField, type FieldStats } from './field.ts'
import { Surface, mergeMeshes } from './geom.ts'
import { type Body, hashInput, inputFile } from './io.ts'
import { type BuiltJoint, type JointExt, type JointFile, type Override, type RomEntry, type Skeleton, blendRadius, buildJoints, expandJointDefs, toContract } from './joints.ts'
import { BYTES_PER_VERTEX } from './pose.ts'
import { openedSkinPackageDir, skinPackageDir } from '../pipeline/skinPackageDir.ts'

export const CURATED = join(import.meta.dirname, '..', '..', 'data', 'curated', 'rig')

export interface RigExt extends Rig {
  joints: JointExt[]
}

export interface BuildResult {
  rig: RigExt
  bin: Uint8Array
  built: BuiltJoint[]
  skeleton: Skeleton
  field: BodyField
  fieldStats: FieldStats
  bound: BoundPart[]
  attach: AttachReport[]
  byMethod: Record<string, { parts: number; vertices: number; rigid: number }>
  notes: string[]
  calibration: Calibration[]
  /** 标定前建立的全部作用线（含被去掉的）。 Every line of action established before calibration (dropped ones included). */
  allLines: MuscleLine[]
  /** 皮肤是按下标绑定的开口皮肤（此时不能用射线奇偶判断内外）。 The skin is an opened skin bound by index (ray parity cannot tell inside from outside then). */
  skinOpen: boolean
  /** 用到的外部权重包及其关节映射。 External weight packages used, with their joint mapping. */
  external: { dir: string; source: string; vertices: number; mapping: ExternalWeights['mapped'] }[]
  /** 整理好的输入文件哈希（含 data/curated/rig 下的定义）。 Hashes of every input, the curated definitions included. */
  inputs: Record<string, string>
}

interface RomFile {
  sources: Record<string, { name: string; url: string; license: string }>
  entries: Record<string, { positive: number; negative: number; source: string; status: 'sourced' | 'estimate'; note?: { zh: string; en: string } }>
}

const CAUTIONS: { zh: string; en: string }[] = [
  {
    zh: '这是运动学蒙皮，不是物理仿真：组织之间没有接触和碰撞，没有重力，软组织不会被挤开或下垂；深屈时皮肤和肌肉会互相穿插。',
    en: 'This is kinematic skinning, not physics: tissues do not touch or collide, there is no gravity, and soft tissue is neither pushed aside nor sags; in deep flexion skin and muscles pass through each other.',
  },
  {
    zh: '肌肉只随两端的骨改变长度，并按“体积不变”调整粗细；没有肌肉主动收缩时的隆起，也不区分肌腹与肌腱（实际上肌腱几乎不变长）。',
    en: 'Muscles only change length with the bones at their ends and are thickened or thinned to keep their volume; there is no bulge from active contraction and no distinction between belly and tendon (real tendons hardly change length).',
  },
  {
    zh: '肌肉作用线是起点到止点的直线：绕过骨或关节的肌肉（股四头肌、三角肌、臀大肌等）在大角度时长度和体积修正都不准。',
    en: 'A muscle’s line of action is the straight line from origin to insertion: for muscles that wrap around bone or a joint (quadriceps, deltoid, gluteus maximus …) both the length and the volume correction are wrong at large angles.',
  },
  {
    zh: '所有关节轴都是固定的。真实的膝关节有滚动和滑动，颞下颌关节张口时下颌头前移，拇指腕掌关节两轴不相交，脊柱各节段的瞬时轴会移动——这些都没有建模。',
    en: 'All joint axes are fixed. The real knee rolls and glides, the mandibular heads slide forward when the mouth opens, the two axes of the thumb’s carpometacarpal joint do not intersect, and the instantaneous axes of spinal segments move — none of this is modelled.',
  },
  {
    zh: '肩胛骨没有被约束在胸廓上滑动；肩肱节律只是把抬臂角度按约 2 : 1 分给盂肱关节和肩带的近似。单独转动盂肱关节超过约 90–120° 时，肱骨会穿入肩峰。',
    en: 'The scapula is not constrained to glide on the rib cage; the scapulohumeral rhythm is only an approximate 2 : 1 split of arm elevation between the glenohumeral joint and the shoulder girdle. Turning the glenohumeral joint alone beyond about 90–120° drives the humerus into the acromion.',
  },
  {
    zh: '脊柱各节段的屈伸、侧屈、旋转相互独立，没有耦合运动；胸骨和肋软骨是跟着肋骨“蒙皮”的，脊柱大幅弯曲时会被轻微拉弯。',
    en: 'Flexion, lateral bending and rotation of each spinal segment are independent, without coupled motion; the sternum and costal cartilages are skinned to the ribs and get slightly bent when the spine bends far.',
  },
  {
    zh: '每根肋只有一个绕肋颈轴的自由度。肋上提时，肺、膈、心脏和腹腔脏器只是按距离跟着附近的肋和椎骨移动；膈肌不会下降，肺不会按体积充气。',
    en: 'Every rib has one degree of freedom about the axis of its neck. When the ribs rise, lungs, diaphragm, heart and abdominal organs merely follow the nearby ribs and vertebrae by distance; the diaphragm does not descend and the lungs do not inflate by volume.',
  },
  {
    zh: '髌骨按固定比例跟随膝关节屈曲；膝关节的轴向旋转范围是屈膝位的数值，伸直时也没有被限制。活动范围是成人的平均正常值，各自由度独立限制，不代表任何个人，也没有考虑相邻关节的相互影响。',
    en: 'The patella follows knee flexion by a fixed ratio; the axial rotation range of the knee is the value for the flexed knee and is not reduced in extension. Ranges of motion are average normal adult values applied to each degree of freedom independently; they describe no individual and ignore the influence of neighbouring joints.',
  },
  {
    zh: '血管、神经和脏器按距离跟随附近的骨，保持连续但不保持长度：跨过大关节的神经血管在深屈时可能被拉长、折叠或贴进骨面。',
    en: 'Vessels, nerves and organs follow nearby bones by distance; they stay continuous but do not keep their length: where they cross a large joint they may be stretched, folded or pressed into bone in deep flexion.',
  },
  {
    zh: '本模型的皮肤在腋下把上臂和胸壁连成一体，一直连到上臂中段（原始皮肤网格如此）。因此上臂外展或前屈超过约 40° 时，腋部会被拉出一片“蹼”，那里的皮肤、筋膜和浅层神经血管被拉长数倍到数十倍；背阔肌和胸大肌也会被拉成翼状。',
    en: 'In this model the skin joins the upper arm to the chest wall below the armpit, down to the middle of the arm (the source skin mesh is built that way). Raising the arm sideways or forwards beyond about 40° therefore draws out a web in the axilla, where skin, fascia and superficial nerves and vessels are stretched several-fold to tens of times; latissimus dorsi and pectoralis major are pulled into wings as well.',
  },
  {
    zh: '腘动、静脉在膝关节后方紧贴着屈伸轴走（在髁间窝后方，距轴约 10–12 mm）。真实屈膝时它们会被挤向后方；这里不会，于是屈膝 90° 以上时有三成到七成的表面落入胫骨和股骨内；屈髋时坐骨神经也有约 5% 的表面压进骨里。输入数据里肌肉、血管、神经与骨本来就有重叠（静止时肌肉表面约 16% 在骨内），摆姿势基本不会使它加重，但也不会消除。',
    en: 'The popliteal artery and vein pass close behind the flexion axis of the knee (behind the intercondylar fossa, about 10–12 mm from the axis). In a real knee they are pushed backwards as it bends; here they are not, so from 90° of flexion a third to two thirds of their surface ends up inside tibia and femur; in hip flexion about 5 % of the sciatic nerve is pressed into bone as well. Muscles, vessels and nerves overlap bone in the input data to begin with (about 16 % of the muscle surface at rest); posing hardly adds to that, but does not remove it either.',
  },
  {
    zh: '关节中心和轴由本模型较粗的骨网格拟合得到（多数骨只有约 200–500 个顶点）：手指和足趾关节轴的精度至多为数度，各关节的拟合残差见 rig-report.json。',
    en: 'Joint centres and axes are fitted to this model’s coarse bone meshes (most bones have only about 200–500 vertices): finger and toe axes are good to several degrees at best; the residual of every fit is in rig-report.json.',
  },
]

const EXTERNAL_SKIN_CAUTION = {
  zh: '皮肤采用 MHR 自带的蒙皮权重（手指除外），关节换成了本骨架的关节：胸部皮肤只随椎骨、不随肋骨，深吸气时肋骨和腹直肌会顶出皮肤；足趾皮肤只随跖趾关节；肩前屈超过约 120° 和深蹲时，腋部与腹股沟的皮肤仍被明显拉长，背阔肌、三角肌等深部结构会局部穿出皮肤（最深约 3–5 cm）。',
  en: 'The skin uses MHR’s own skinning weights (except on the fingers) with this rig’s joints: chest skin follows the vertebrae, not the ribs, so in deep inspiration ribs and rectus abdominis come through it; toe skin follows the metatarsophalangeal joints only; beyond about 120° of shoulder flexion and in a deep squat the skin of the axilla and groin is still stretched markedly, and deep parts such as latissimus dorsi and deltoid come through the skin locally (by up to about 3–5 cm).',
}

/**
 * 外部蒙皮权重的目录取装入的那个皮肤包（tools/pipeline/skinPackageDir.ts），不取 bindings.json 里写定的目录：
 * 那里女性的目录还是旧头的包，按下标取到的权重与新头的顶点对不上（2026-10-14 发现：口角处有下唇顶点挂在颅骨上）。
 * 男性的包目录两边相同，结果不变。bindings.json 的哈希照旧记入输入。
 * The directories of the external skin weights are those of the installed skin package (tools/pipeline/skinPackageDir.ts), not
 * the ones written into bindings.json: for the female those still named the old head's package, and weights taken by index did
 * not match the new head's vertices (found 2026-10-14: lower-lip vertices at the mouth corners hung on the skull). For the male
 * both name the same directory, so nothing changes. The hash of bindings.json is still recorded as an input.
 */
export function withInstalledSkinPackages(rules: BindRules): BindRules {
  const ext = (rules.externalWeights ?? []).map((e) => (e.body === 'male' || e.body === 'female' ? { ...e, dir: skinPackageDir(e.body), ...(e.openDir ? { openDir: openedSkinPackageDir(e.body) } : {}) } : e))
  return { ...rules, externalWeights: ext }
}

export function loadCurated(bodyId: string): { defs: ReturnType<typeof expandJointDefs>; rom: Record<string, RomEntry>; rules: BindRules; overrides: Record<string, Override>; hashes: Record<string, string> } {
  const hashes: Record<string, string> = {}
  const read = <T>(name: string): T => {
    const text = readFileSync(join(CURATED, name), 'utf8')
    hashes[`data/curated/rig/${name}#data`] = hashInput(`data/curated/rig/${name}#data`, join(CURATED, name))
    return JSON.parse(text) as T
  }
  const jf = read<JointFile>('joints.json')
  const rf = read<RomFile>('rom.json')
  const rules = withInstalledSkinPackages(read<BindRules>('bindings.json'))
  const ov = read<Record<string, Record<string, Override>>>('overrides.json')
  const rom: Record<string, RomEntry> = {}
  for (const [k, e] of Object.entries(rf.entries)) {
    const src = rf.sources[e.source]
    if (!src) throw new Error(`rig: rom.json entry ${k} names unknown source ${e.source}`)
    rom[k] = { positive: e.positive, negative: e.negative, status: e.status, source: src }
  }
  return { defs: expandJointDefs(jf), rom, rules, overrides: ov[bodyId] ?? {}, hashes }
}

export interface BuildOptions {
  /** 不用外部蒙皮权重，皮肤也按距离场绑定（用于对比）。 Ignore external skin weights and bind the skin by the distance field too (for comparison). */
  genericSkin?: boolean
}

export function buildRig(body: Body, log: (m: string) => void = () => {}, opts: BuildOptions = {}): BuildResult {
  const cur = loadCurated(body.data.body)
  const t0 = performance.now()
  const { joints: built, skeleton } = buildJoints(body, cur.defs, cur.overrides)
  log(`joints: ${built.length} fitted in ${Math.round(performance.now() - t0)} ms`)
  const { joints, notes: romNotes } = toContract(built, cur.rom)

  // 距离场：皮肤取三角形最多的那个皮肤部件；每个关节的骨合并成一个表面
  // distance field: the skin part with most triangles; the bones of each joint merged into one surface
  const skins = body.data.parts.filter((p) => p.tissue === 'skin').sort((a, b) => b.triangles - a.triangles)
  // 外部蒙皮权重（如 MHR 拓扑的新皮肤）：目录存在就读入，并把它的文件计入输入哈希
  // external skin weights (e.g. the replacement skin in MHR topology): read when the directory exists, its files added to the input hashes
  const external: (ExternalWeights & { byIndexFor?: string })[] = []
  const extHashes: Record<string, string> = {}
  for (const e of opts.genericSkin ? [] : (cur.rules.externalWeights ?? [])) {
    if (e.body !== body.data.body) continue
    // 有下标对照、且有开口后的皮肤包时，用开口后的包并按下标取权重
    // with the index sidecar and an opened package, the opened package is used and weights are taken by index
    const useOpen = !!body.skinSource && !!e.openDir && existsSync(join(CURATED, '..', '..', '..', e.openDir, 'weights.bin'))
    const rel = useOpen ? e.openDir! : e.dir
    const dir = join(CURATED, '..', '..', '..', rel)
    const w: (ExternalWeights & { byIndexFor?: string }) | null = loadExternalWeights(dir, built.map((j) => ({ id: j.def.id, center: j.center, tail: j.tail })), e.map ?? [])
    if (!w) continue
    w.dir = rel
    if (useOpen && skins[0]) w.byIndexFor = skins[0].id
    if (w.body !== null && w.body !== body.data.body) continue
    external.push(w)
    for (const f of ['weights.bin', 'joints.json', 'skin.obj', 'manifest.json#package']) extHashes[`${rel}/${f}`] = hashInput(f, join(dir, inputFile(f)))
    log(`external skin weights: ${w.vertexCount} vertices from ${rel} (${w.sourceName})${useOpen ? ', by index' : ''}`)
  }
  // 距离场要闭合的皮肤：按下标绑定的开口皮肤改用皮肤包里的闭合伴随表面（口腔袋会在头内造出假的皮肤壁）
  // the distance field needs a closed skin: for an opened skin bound by index, the package's closed companion is used (the oral pouch would make false skin walls inside the head)
  const companion = external.find((w) => w.byIndexFor)?.closed() ?? null
  const skin = companion ? [companion] : skins.length ? [body.meshes.get(skins[0]!.id)!] : []
  const sources = built.flatMap((j, i) => (j.boneIds.length ? [{ joint: i, surface: new Surface(mergeMeshes(j.boneIds.map((b) => body.meshes.get(b)!))) }] : []))
  const field = new BodyField(skin, sources)
  log(`field: ${field.stats.insideVoxels} voxels of ${field.stats.voxel * 1000} mm in ${field.stats.buildMs} ms${field.stats.leaked ? ' (LEAKED: Euclidean fallback)' : ''}`)
  const radius = built.map((j) => {
    const r = j.def.bones.map((b) => blendRadius(skeleton, b)).sort((a, b) => a - b)
    return r.length ? r[Math.floor(r.length / 2)]! : 0.01
  })

  const t1 = performance.now()
  const res = bindAll({ body, joints: built, field, radius, rules: cur.rules, patches: body.patches as AttachmentPatch[], external, skinSource: body.skinSource, log })
  log(`bindings: ${res.parts.length} parts in ${Math.round(performance.now() - t1)} ms`)

  // rig.bin：按 anatomy.json 的部件顺序依次排放 / rig.bin: parts laid out in anatomy.json order
  let bytes = 0
  for (const p of res.parts) if (p.joint === undefined) bytes += (p.w!.length / 4) * BYTES_PER_VERTEX
  const bin = new Uint8Array(bytes)
  const dv = new DataView(bin.buffer)
  const bindings: RigBinding[] = []
  let off = 0
  for (const p of res.parts) {
    if (p.joint !== undefined) {
      bindings.push({ part: p.part, joint: joints[p.joint]!.id })
      continue
    }
    const n = p.w!.length / 4
    bindings.push({ part: p.part, offset: off, vertexCount: n })
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 4; k++) {
        dv.setUint16(off + i * BYTES_PER_VERTEX + k * 2, p.idx![i * 4 + k]!, true)
        bin[off + i * BYTES_PER_VERTEX + 8 + k] = p.w![i * 4 + k]!
      }
    }
    off += n * BYTES_PER_VERTEX
  }
  // 皮肤相关的注意事项取决于这副身体用的是哪种皮肤
  // the caution about the skin depends on which skin this body has
  const cautions = CAUTIONS.filter((c) => external.length === 0 || !c.en.startsWith('In this model the skin joins the upper arm'))
  if (external.length) cautions.splice(1, 0, EXTERNAL_SKIN_CAUTION)
  const rig: RigExt = { joints, bindings, muscles: res.muscles, shape: [], cautions }
  const allLines = [...res.muscles]
  const t2 = performance.now()
  const calibration = calibrateMuscles(rig, bin, body)
  log(`muscle lines: ${res.muscles.length} established, ${rig.muscles.length} kept after volume calibration in ${Math.round(performance.now() - t2)} ms`)
  return {
    rig, bin, built, skeleton, field, calibration, allLines, skinOpen: external.some((w) => w.byIndexFor), external: external.map((w) => ({ dir: w.dir, source: w.sourceName, vertices: w.vertexCount, mapping: w.mapped })), fieldStats: field.stats, bound: res.parts, attach: res.attach, byMethod: res.byMethod,
    notes: [...romNotes, ...res.notes, ...external.flatMap((w) => w.notes), ...built.flatMap((j) => j.warnings.map((w) => `${j.def.id}: ${w}`))],
    inputs: { ...body.inputs, ...cur.hashes, ...extHashes },
  }
}
