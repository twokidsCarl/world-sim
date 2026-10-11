// 生成给外面的 Agent 的数据文件：bun run agent
// 写出 agent/*.json；它们要提交进仓库，测试会检查它们与源码一致。
// Generate the data files offered to outside agents: bun run agent
// Writes agent/*.json. They are committed, and a test checks they match the source.

import { readFileSync, writeFileSync } from 'node:fs'
import { catalog, serialise, type Card } from '../src/agent/catalog'

const root = new URL('..', import.meta.url).pathname
const sim = JSON.parse(readFileSync(`${root}sim.json`, 'utf8')) as { cards: Card[] }

for (const [name, records] of Object.entries(catalog(sim.cards))) {
  writeFileSync(`${root}agent/${name}.json`, serialise(records))
  console.log(`agent/${name}.json: ${(records as unknown[]).length}`)
}
