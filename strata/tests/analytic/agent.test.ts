import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { catalog, serialise, type Card } from '../../src/agent/catalog'

const root = new URL('../..', import.meta.url).pathname
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8')
const sim = JSON.parse(read('sim.json')) as {
  cards: Card[]
  agent: { datasets: { id: string; path: string; key: string; search: string[]; fields: string[] }[] }
}

describe('data offered to outside agents', () => {
  // catalog() 在缺任何一个英文名时会抛出，并说出是哪一个。
  // catalog() throws, naming the item, when any English name is missing.
  const built = catalog(sim.cards)

  it('the committed agent/*.json files match what the source generates (run `bun run agent` to refresh)', () => {
    for (const [name, records] of Object.entries(built)) {
      expect(read(`agent/${name}.json`), `agent/${name}.json`).toBe(serialise(records))
    }
  })

  it('every dataset in sim.json points at a generated file and names fields that exist', () => {
    expect(sim.agent.datasets.map((d) => d.path).sort()).toEqual(Object.keys(built).map((n) => `agent/${n}.json`).sort())
    for (const d of sim.agent.datasets) {
      const records = built[d.path.slice(6, -5) as keyof typeof built] as unknown as Record<string, unknown>[]
      const present = new Set(records.flatMap((r) => Object.keys(r)))
      for (const field of [d.key, ...d.search, ...d.fields]) expect(present.has(field), `${d.id}: ${field}`).toBe(true)
      expect(new Set(records.map((r) => r[d.key])).size, `${d.id}: keys are unique`).toBe(records.length)
    }
  })

  it('reference values are finite numbers or carry a table or formula instead', () => {
    for (const ref of built.references) {
      if (ref.value === null) expect(ref.formula.length).toBeGreaterThan(0)
      else expect(Number.isFinite(ref.value)).toBe(true)
      for (const row of ref.table?.rows ?? []) for (const v of row) expect(Number.isFinite(v)).toBe(true)
    }
  })
})
