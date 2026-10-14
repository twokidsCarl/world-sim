// 把两副人体的静止皮肤和主要关节中心导出到 data/raw/cloth/work/<body>/，供 measure.py 读取（不提交）。
// Exports both bodies' rest skin and main joint centres to data/raw/cloth/work/<body>/ for measure.py (not committed).
//
//   bun tools/cloth/export-skin.ts

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BODIES, ROOT, loadSkinBody } from './body.ts'

/** measure.py 需要的关节（键名沿用 tools/bodyshape/measure.py）/ The joints measure.py needs (key names follow tools/bodyshape/measure.py). */
const JOINTS: Record<string, string> = {
  shoulder: 'gh', elbow: 'elbow', wrist: 'wrist', hip: 'hip', knee: 'knee', ankle: 'ankle', ac: 'ac', sc: 'sc',
}

for (const id of BODIES) {
  const b = await loadSkinBody(id)
  const out = join(ROOT, 'data', 'raw', 'cloth', 'work', id)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'skin.f32'), new Uint8Array(b.rest.buffer, b.rest.byteOffset, b.rest.byteLength))
  writeFileSync(join(out, 'skin.u32'), new Uint8Array(b.indices.buffer, b.indices.byteOffset, b.indices.byteLength))
  const joints: Record<string, number[]> = {}
  for (const [k, j] of Object.entries(JOINTS)) for (const s of ['L', 'R']) joints[`${k}_${s}`] = b.joint(`${j}_${s}`)
  for (const j of ['C7', 'T1', 'skull', 'pelvis', 'L3']) joints[j] = b.joint(j)
  writeFileSync(join(out, 'joints.json'), JSON.stringify(joints, null, 1))
  console.log(id, b.rest.length / 3, 'vertices →', out)
}
