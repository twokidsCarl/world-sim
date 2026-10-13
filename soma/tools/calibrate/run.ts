// 入口：bun tools/calibrate/run.ts [skeletal|face|organs|bones ...]      （不给参数则全部 / all when none is given）
// Entry point: bun tools/calibrate/run.ts [skeletal|face|organs|bones ...]
//
// 读 public/anatomy/<body>/ 的当前数据和 data/raw/calibration/ 下的参照（先运行 fetch.ts；MyoFullBody 还要运行 myo_dump.py），
// 把对照表写到 data/curated/calibration/*.json。参照缺失的部分跳过，已有的表保持不动。
// Reads the current data under public/anatomy/<body>/ and the references under data/raw/calibration/ (run fetch.ts first; MyoFullBody
// also needs myo_dump.py), and writes the comparison tables to data/curated/calibration/*.json. Parts whose reference is absent are
// skipped and their existing tables are left alone.
//
// 准备参照 / preparing the references:
//   bun tools/calibrate/fetch.ts
//   uv venv --python 3.12 data/raw/calibration/.venv && uv pip install --python data/raw/calibration/.venv/bin/python mujoco myo-sim numpy
//   data/raw/calibration/.venv/bin/python -I tools/calibrate/myo_dump.py data/raw/calibration/myo-sim-derived/myofullbody.json

import { runBones } from './bones.ts'
import { runFace } from './face.ts'
import { runOrgans } from './organs.ts'
import { runSkeletal } from './skeletal.ts'

const STEPS: Record<string, (log: (m: string) => void) => Promise<void>> = { skeletal: runSkeletal, face: runFace, organs: runOrgans, bones: runBones }

if (import.meta.main) {
  const want = process.argv.slice(2)
  const unknown = want.filter((w) => !(w in STEPS))
  if (unknown.length) {
    console.error(`calibrate: unknown step ${unknown.join(', ')}; steps are ${Object.keys(STEPS).join(', ')}`)
    process.exit(2)
  }
  const t0 = performance.now()
  for (const [name, step] of Object.entries(STEPS)) {
    if (want.length && !want.includes(name)) continue
    await step((m) => console.log(`[calibrate ${((performance.now() - t0) / 1000).toFixed(1)}s] ${m}`))
  }
}
