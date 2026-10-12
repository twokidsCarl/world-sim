// 把一个人体的面部深层部件（眼球各部、睑板、唇、牙、牙龈、舌、下颌骨）和颞下颌关节导出成一个 JSON，
// 供 open_skin.py 比对皮肤上的线、确定口腔袋的大小。只读 public/anatomy/<body>/。
// Exports the deep facial parts of one body (parts of the globe, tarsal plates, lip, teeth, gingiva,
// tongue, mandible) and the temporomandibular joint as one JSON, for open_skin.py to compare the
// lines on the skin with and to size the oral pouch. Reads public/anatomy/<body>/ only.
//
//   bun tools/skinopen/export-deep.ts <body> <out.json>

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readBody } from '../rig/io.ts'

// 分组：名称的正则 / groups: regular expressions on the part name
const WU_ANCHOR = /^WU_(cavernous_body_of_clitoris|vestibular_bulb|vaginal_wall|uterine_and_vaginal_lumen|submucous_layer_of_urethra|urethral_sphincter_proper|perineal_body|external_anal_sphincter|internal_anal_sphincter|bulbospongiosus_muscle|ischiocavernous_muscle|bartholin_gland|superficial_transverse_perineal_muscle|deep_perineal_muscle|urethro_vaginal_sphincter|urethral_compressor_muscle)(_[LR])?$/

const GROUPS: [string, RegExp][] = [
  ['cornea', /^(left|right) cornea$/i],
  ['sclera', /^(left|right) sclera$/i],
  ['iris', /^(left|right) iris$/i],
  ['tarsalUpper', /^tarsal plate of (left|right) upper eyelid$/i],
  ['tarsalLower', /^tarsal plate of (left|right) lower eyelid$/i],
  ['lip', /^lip$/i],
  ['upperTeeth', /upper .*tooth$/i],
  ['lowerTeeth', /lower .*tooth$/i],
  ['upperGingiva', /^gingiva of upper jaw$/i],
  ['lowerGingiva', /^gingiva of lower jaw$/i],
  ['tongue', /^tongue$/i],
  ['mandible', /^mandible$/i],
  // 男性外生殖器的深层部件（graft.py 的 genital 步骤用）/ deep parts of the male external genitalia (for the genital step of graft.py)
  // 足趾的骨（graft.py 的 toes 步骤用）/ bones of the toes (for the toes step of graft.py)
  ['toeBone', /^(distal|middle|proximal) phalanx of (left|right) .*toe$|^(left|right) (first|second|third|fourth|fifth) metatarsal bone$/i],
  ['toeNail', /^(left|right) nail plate \(foot\)$/i],
  ['genitalMale', /^(glans penis|corpus (cavernosum|spongiosum) of penis|(left|right) (testis|epididymis))$/i],
]

const [bodyId, outFile] = process.argv.slice(2)
if (!bodyId || !outFile) throw new Error('usage: bun tools/skinopen/export-deep.ts <body> <out.json>')
const dir = join('public/anatomy', bodyId)
const body = await readBody(dir)
const r5 = (v: number) => Math.round(v * 1e5) / 1e5
const parts: { id: string; name: string; group: string; side: string; positions: number[]; indices: number[] }[] = []
for (const p of body.data.parts) {
  // Wu 等 2015 的会阴部件按 id 选（graft.py 的 vulva 步骤用它们求原始标本到本体的变换）
  // the perineal parts of Wu et al. 2015 are chosen by id (the vulva step of graft.py derives the map from the raw specimen to this body from them)
  const g = WU_ANCHOR.test(p.id) ? (['wuAnchor', WU_ANCHOR] as [string, RegExp]) : GROUPS.find(([, rx]) => rx.test(p.name))
  const m = body.meshes.get(p.id)
  if (!g || !m) continue
  parts.push({ id: p.id, name: p.name, group: g[0], side: p.side, positions: Array.from(m.positions, r5), indices: Array.from(m.indices) })
}
// 颞下颌关节：中心和张口轴（rig.json）/ the temporomandibular joint: centre and opening axis (rig.json)
let footJoints: Record<string, number[]> = {}
let tmj: { center: number[]; axis: number[] } | null = null
try {
  const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as { joints: { id: string; center: number[]; axes: number[][] }[] }
  const j = rig.joints.find((q) => q.id === 'tmj')
  if (j) tmj = { center: j.center, axis: j.axes[0]! }
  // 踝、跖趾关节的中心 / centres of the ankle and metatarsophalangeal joints
  for (const q of rig.joints) if (/^(ankle|mtp[1-5])_[LR]$/.test(q.id)) footJoints[q.id] = q.center
} catch {
  tmj = null
}
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, JSON.stringify({ body: bodyId, frame: 'metres, Y up, +Z anterior, +X subject left', inputs: body.inputs, tmj, footJoints, parts }))
console.log(`${outFile}: ${parts.length} parts (${[...GROUPS.map(([g]) => g), 'wuAnchor'].map((g) => `${g} ${parts.filter((p) => p.group === g).length}`).filter((t) => !t.endsWith(' 0')).join(', ')}); tmj ${tmj ? 'found' : 'absent'}`)
