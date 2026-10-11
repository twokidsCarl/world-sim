// 生成给外面的 Agent 的数据文件：bun run agent
// 写出 agent/*.json，并把 sim.json 里的 api 和 agent.capabilities 更新成由旋钮表生成的那一份；
// 它们要提交进仓库，测试会检查它们与源码一致。
// Generate the data files offered to outside agents: bun run agent
// Writes agent/*.json and refreshes `api` and `agent.capabilities` in sim.json from the knob
// tables. All of it is committed, and a test checks it matches the source.

import { readFileSync, writeFileSync } from 'node:fs'
import { catalog, serialise, type Card } from '../src/agent/catalog'
import { API, capabilities } from '../src/headless/schema'

const root = new URL('..', import.meta.url).pathname
const sim = JSON.parse(readFileSync(`${root}sim.json`, 'utf8')) as { cards: Card[]; api?: unknown; agent: { capabilities?: unknown } }

for (const [name, records] of Object.entries(catalog(sim.cards))) {
  writeFileSync(`${root}agent/${name}.json`, serialise(records))
  console.log(`agent/${name}.json: ${(records as unknown[]).length}`)
}

// 保持键的顺序：api 放在 cards 前面。 / Keep the key order: api goes before cards.
const { cards, agent, ...head } = sim
agent.capabilities = capabilities()
writeFileSync(`${root}sim.json`, JSON.stringify({ ...head, api: API, cards, agent }, null, 2) + '\n')
console.log(`sim.json: api, agent.capabilities: ${capabilities().length}`)
