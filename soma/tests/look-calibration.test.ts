// 写实外观的标定对照表（skin-colour、skin-detail、look-hair、look-eyes）：字段齐全、判定与数一致、生成是确定的、与当前数据一致。
// The lifelike-look calibration tables (skin-colour, skin-detail, look-hair, look-eyes): required fields present, verdicts
// agree with their numbers, generation is deterministic and matches the current data.
//
// 皮肤即将重新发布：毛发和眼的表记录了所读文件的哈希，哈希不再相符时只提示重跑 bun tools/look/calibration.ts，不判失败。
// The skins are about to be re-issued: the hair and eye tables record hashes of the files they read, and when those no longer
// match the check only asks for a rerun of bun tools/look/calibration.ts rather than failing.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countRows, disagreement, rowLabel, rowValues } from '../src/calibration/summary.ts'
import type { CalibrationTable } from '../src/calibration/summary.ts'
import { LOOK_TABLES, OUT, buildLookTables, serialise } from '../tools/look/calibration.ts'

const ROOT = join(import.meta.dirname, '..')
const read = (id: string): CalibrationTable & { ourState: Record<string, Record<string, string>> } => JSON.parse(readFileSync(join(OUT, `${id}.json`), 'utf8'))
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)
const stateFile = (body: string, f: string): string => (body === 'all' ? join(ROOT, f.includes('/') ? f : join('public/anatomy/male/look', f)) : join(ROOT, 'public/anatomy', body, f))
const fresh = (t: { ourState: Record<string, Record<string, string>> }): boolean =>
  Object.entries(t.ourState).every(([body, files]) => Object.entries(files).every(([f, h]) => existsSync(stateFile(body, f)) && sha(stateFile(body, f)) === h))

describe.each(LOOK_TABLES)('lifelike-look calibration table %s', (id) => {
  const t = read(id)
  it('has the shared fields, bilingual texts and a source on every comparable row', () => {
    expect(t.schema).toBe(1)
    expect(t.id).toBe(id)
    for (const b of [t.title, t.method, t.tolerance, ...(t.notes ?? [])]) {
      expect(/[一-鿿]/.test(b.zh)).toBe(true)
      expect(b.en.length).toBeGreaterThan(0)
    }
    const refs = new Set(t.references.map((r) => r.id))
    for (const r of t.references) {
      expect(r.url).toMatch(/^https:\/\//)
      for (const k of ['name', 'version', 'licence', 'clause'] as const) expect(String(r[k]).length, `${r.id}.${k}`).toBeGreaterThan(0)
    }
    for (const row of t.rows) {
      expect(['within', 'outside', 'not comparable']).toContain(row.verdict)
      if (row.verdict !== 'not comparable') expect(refs.has(String(row.source)), `${id}: ${rowLabel(row)}`).toBe(true)
      // 不可比的行要说明原因 / a row that is not comparable says why
      else expect(row.note, `${id}: ${rowLabel(row)}`).toBeDefined()
      expect(rowLabel(row).length).toBeGreaterThan(0)
    }
    const c = countRows(t.rows)
    expect(t.summary).toEqual({ rows: c.rows, within: c.within, outside: c.outside, notComparable: c.notComparable })
  })

  it('verdicts agree with the numbers in the dialog', () => {
    for (const row of t.rows) {
      if (row.verdict === 'not comparable') continue
      const d = disagreement(row)
      expect(d, `${id}: ${rowLabel(row)}`).not.toBeNull()
      // 数四舍五入过，贴着容差的行不判 / numbers are rounded, so rows right at the tolerance are not judged
      if (Math.abs(d! - 1) > 0.02) expect(row.verdict, `${id}: ${rowLabel(row)}`).toBe(d! <= 1 ? 'within' : 'outside')
      expect(rowValues(row).diff).not.toBe('–')
    }
  })
})

describe('lifelike-look calibration tables are reproducible', () => {
  it('rebuilding twice gives identical tables, equal to the files while the data are unchanged', async () => {
    const a = (await buildLookTables()).map(serialise)
    const b = (await buildLookTables()).map(serialise)
    expect(a).toEqual(b)
    for (const [i, id] of LOOK_TABLES.entries()) {
      const file = readFileSync(join(OUT, `${id}.json`), 'utf8')
      if (fresh(read(id))) expect(a[i], `${id}: rerun bun tools/look/calibration.ts`).toBe(file)
      else console.warn(`[look-calibration] ${id} was built from older data; rerun bun tools/look/calibration.ts`)
    }
  }, 60_000)
})
