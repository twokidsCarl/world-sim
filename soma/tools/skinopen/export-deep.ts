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
]

const [bodyId, outFile] = process.argv.slice(2)
if (!bodyId || !outFile) throw new Error('usage: bun tools/skinopen/export-deep.ts <body> <out.json>')
const dir = join('public/anatomy', bodyId)
const body = await readBody(dir)
const r5 = (v: number) => Math.round(v * 1e5) / 1e5
const parts: { id: string; name: string; group: string; side: string; positions: number[]; indices: number[] }[] = []
for (const p of body.data.parts) {
  const g = GROUPS.find(([, rx]) => rx.test(p.name))
  const m = body.meshes.get(p.id)
  if (!g || !m) continue
  parts.push({ id: p.id, name: p.name, group: g[0], side: p.side, positions: Array.from(m.positions, r5), indices: Array.from(m.indices) })
}
// 颞下颌关节：中心和张口轴（rig.json）/ the temporomandibular joint: centre and opening axis (rig.json)
let tmj: { center: number[]; axis: number[] } | null = null
try {
  const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as { joints: { id: string; center: number[]; axes: number[][] }[] }
  const j = rig.joints.find((q) => q.id === 'tmj')
  if (j) tmj = { center: j.center, axis: j.axes[0]! }
} catch {
  tmj = null
}
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, JSON.stringify({ body: bodyId, frame: 'metres, Y up, +Z anterior, +X subject left', inputs: body.inputs, tmj, parts }))
console.log(`${outFile}: ${parts.length} parts (${GROUPS.map(([g]) => `${g} ${parts.filter((p) => p.group === g).length}`).join(', ')}); tmj ${tmj ? 'found' : 'absent'}`)
