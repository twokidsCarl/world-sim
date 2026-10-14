// 标定对照表的测试：表的格式、每行的出处、对应关系指向存在的部件和关节、可重复。
// Tests of the calibration tables: well-formed, every row sourced, mappings point at parts and joints that exist, deterministic.
//
// 不需要下载：data/raw/calibration/ 不存在时，依赖参照的重算被跳过。两副身体正在被别的工作改动，所以凡是拿表里的
// 部件 id 去对当前数据的检查，只在表所记录的文件哈希与当前文件一致时才做；不一致时该表需要重新生成（bun tools/calibrate/run.ts）。
// No download is needed: recomputation that depends on a reference is skipped when data/raw/calibration/ is absent. The bodies
// are being reworked elsewhere, so checks of the tables' part ids against the current data run only when the file hashes recorded
// in a table match the current files; otherwise that table needs regenerating (bun tools/calibrate/run.ts).

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnatomyData, Rig } from '../src/anatomy/types.ts'
import type { FaceData } from '../src/face/types.ts'
import { boneRows } from '../tools/calibrate/bones.ts'
import { ARKIT, COEFF_MAP, ICT_AU } from '../tools/calibrate/face.ts'
import { ORGAN_REFS, ORGAN_SOURCES, meshVolumeMl, organRows, unionVolumeMl } from '../tools/calibrate/organs.ts'
import { OUT, REFS, ROOT } from '../tools/calibrate/refs.ts'
import { COORDS, MUSCLE_MAP, ROM_MAP, armTolerance, computeCurveRows, judgeArm, skeletalAvailable } from '../tools/calibrate/skeletal.ts'

interface AnyTable {
  schema: number
  id: string
  title: { zh: string; en: string }
  method: { zh: string; en: string }
  tolerance: { zh: string; en: string }
  references: { id: string; name: string; version: string; url: string; licence: string; clause: string; opened: string }[]
  ourState: Record<string, Record<string, string>>
  notes: { zh: string; en: string }[]
  summary: Record<string, number | string>
  rows: Record<string, unknown>[]
}

// 写实外观的四张表（skin-colour、skin-detail、look-hair、look-eyes）由 tools/look/calibration.ts 生成，另见 tests/look-calibration.test.ts
// the four lifelike-look tables (skin-colour, skin-detail, look-hair, look-eyes) are built by tools/look/calibration.ts; see also tests/look-calibration.test.ts
const EXPECTED = ['arm-bones', 'face-coverage', 'face-displacement', 'instrument-check', 'look-eyes', 'look-hair', 'muscle-attachments-myo', 'muscle-curves-myo', 'muscle-curves-opensim', 'organ-volumes', 'rom', 'segments', 'skin-colour', 'skin-detail']
const read = (id: string): AnyTable => JSON.parse(readFileSync(join(OUT, `${id}.json`), 'utf8')) as AnyTable
const bodyFile = (body: string, file: string): string => join(ROOT, 'public', 'anatomy', body, file)
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)
/** 表所记录的状态是否仍是当前文件 / whether the state a table recorded is still the current files. */
const fresh = (t: AnyTable, body: string, files: string[]): boolean => files.every((f) => t.ourState[body]?.[f] !== undefined && existsSync(bodyFile(body, f)) && t.ourState[body]![f] === sha(bodyFile(body, f)))
const anatomy = (body: string): AnatomyData => JSON.parse(readFileSync(bodyFile(body, 'anatomy.json'), 'utf8')) as AnatomyData
const rig = (body: string): Rig => JSON.parse(readFileSync(bodyFile(body, 'rig.json'), 'utf8')) as Rig

describe('calibration tables', () => {
  it('are all present and nothing else is in the directory', () => {
    expect(readdirSync(OUT).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()).toEqual(EXPECTED)
  })

  for (const id of EXPECTED) {
    describe(id, () => {
      const t = read(id)
      it('is well-formed and bilingual', () => {
        expect(t.schema).toBe(1)
        expect(t.id).toBe(id)
        for (const b of [t.title, t.method, t.tolerance, ...t.notes]) {
          expect(b.zh.length).toBeGreaterThan(0)
          expect(b.en.length).toBeGreaterThan(0)
          // 中文一栏确实含中文 / the Chinese field really contains Chinese
          expect(/[一-鿿]/.test(b.zh)).toBe(true)
        }
        expect(t.rows.length).toBeGreaterThan(0)
        if (typeof t.summary.rows === 'number') expect(t.summary.rows).toBe(t.rows.length)
      })
      it('names its references with version, URL, licence and clause', () => {
        expect(t.references.length).toBeGreaterThan(0)
        for (const r of t.references) {
          for (const k of ['id', 'name', 'version', 'licence', 'clause'] as const) expect(r[k].length, `${r.id}.${k}`).toBeGreaterThan(0)
          expect(r.url).toMatch(/^https:\/\//)
          expect(r.opened).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        }
      })
      it('gives every row a verdict and a source', () => {
        const ids = new Set(t.references.map((r) => r.id))
        for (const row of t.rows) {
          if (id !== 'instrument-check') expect(['within', 'outside', 'not comparable']).toContain(row.verdict)
          // 行里写了 source 的必须是表头列出的参照；没写的表只有一组参照，整表共用
          // a row that names a source must name a listed reference; tables whose rows do not all share the table's references
          if (typeof row.source === 'string' && row.source) expect(ids.has(row.source), `${id}: ${row.source}`).toBe(true)
          if (typeof row.reference === 'string') expect(['opensim', 'myo']).toContain(row.reference)
        }
      })
      it('holds no local path, e-mail address or reference geometry', () => {
        const text = readFileSync(join(OUT, `${id}.json`), 'utf8')
        expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.(com|org|net)/)
        // 不含长的数值数组（参照的网格或参数表）：一行里最长的数组不超过 8 个数
        // no long numeric arrays (a reference mesh or parameter table): no array in a row has more than 8 numbers
        for (const row of t.rows) for (const v of Object.values(row)) if (Array.isArray(v) && typeof v[0] === 'number') expect(v.length).toBeLessThanOrEqual(8)
      })
    })
  }

  it('numeric verdicts agree with their numbers', () => {
    for (const id of ['muscle-curves-opensim', 'muscle-curves-myo']) {
      for (const r of read(id).rows as { ourArmMm: number; refArmMm: number; diffMm: number; toleranceMm: number; verdict: string }[]) {
        expect(Math.abs(r.diffMm - (r.ourArmMm - r.refArmMm))).toBeLessThan(0.11)
        // 表里的数四舍五入到 0.1 mm，贴着容差的行不判 / numbers are rounded to 0.1 mm, so rows right at the tolerance are not judged
        if (Math.abs(Math.abs(r.diffMm) - r.toleranceMm) > 0.2) expect(r.verdict).toBe(Math.abs(r.diffMm) <= r.toleranceMm ? 'within' : 'outside')
      }
    }
    for (const r of read('rom').rows as { ours: number; ref: number; diffDeg: number; verdict: string }[]) {
      if (r.verdict !== 'not comparable' && Math.abs(Math.abs(r.diffDeg) - 10) > 0.2) expect(r.verdict).toBe(Math.abs(r.diffDeg) <= 10 ? 'within' : 'outside')
    }
    for (const r of read('organ-volumes').rows as { oursMl: number; refLowMl: number | null; refHighMl: number | null; verdict: string }[]) {
      if (r.refLowMl === null || r.refHighMl === null) expect(r.verdict).toBe('not comparable')
      else if (Math.abs(r.oursMl - r.refLowMl) > 0.2 && Math.abs(r.oursMl - r.refHighMl) > 0.2) expect(r.verdict).toBe(r.oursMl >= r.refLowMl && r.oursMl <= r.refHighMl ? 'within' : 'outside')
    }
  })
})

describe('calibration mappings', () => {
  const bodies = ['male', 'female']
  it('muscle names exist as muscle parts in at least one body, and every coordinate joint exists in both rigs', () => {
    const names = new Set(bodies.flatMap((b) => anatomy(b).parts.filter((p) => p.tissue === 'muscle').map((p) => p.name)))
    for (const [name, refs] of MUSCLE_MAP) {
      expect(names.has(name), name).toBe(true)
      expect(refs.length).toBeGreaterThan(0)
    }
    expect(new Set(MUSCLE_MAP.map((m) => m[0])).size).toBe(MUSCLE_MAP.length)
    for (const b of bodies) {
      const joints = new Map(rig(b).joints.map((j) => [j.id, j]))
      for (const c of COORDS) {
        if (c.ours.kind !== 'dof') continue
        const j = joints.get(c.ours.joint)
        expect(j, `${b}: ${c.ours.joint}`).toBeDefined()
        expect(j!.dofs.some((d) => d.axis === (c.ours as { axis: number }).axis), `${b}: ${c.ours.joint}.${c.ours.axis}`).toBe(true)
        for (const side of ['_L'] as const) expect(joints.has(c.ours.joint.replace(/_R$/, side))).toBe(true)
      }
    }
  })
  it('range-of-motion entries exist in rom.json', () => {
    const rom = JSON.parse(readFileSync(join(ROOT, 'data', 'curated', 'rig', 'rom.json'), 'utf8')) as { entries: Record<string, unknown> }
    for (const m of ROM_MAP) expect(rom.entries[m.entry], m.entry).toBeDefined()
  })
  it('facial coefficients are the 52 ARKit names, each mapped, and mapped AUs are FACS ids', () => {
    expect(ARKIT.length).toBe(52)
    expect(new Set(ARKIT).size).toBe(52)
    for (const c of ARKIT) expect(COEFF_MAP[c] ?? COEFF_MAP[c.replace(/(Left|Right)$/, '')], c).toBeDefined()
    for (const m of Object.values(COEFF_MAP)) for (const au of m.aus) expect(au).toMatch(/^AU\d+$/)
    for (const [au, shapes] of ICT_AU) {
      expect(au).toMatch(/^AU\d+$/)
      expect(shapes.length).toBeGreaterThan(0)
    }
    // 表里写的 AU 和通道都在当前的 face.json 里 / AUs and channels written in the table exist in the current face.json
    const t = read('face-coverage')
    for (const b of bodies) {
      const face = JSON.parse(readFileSync(bodyFile(b, 'face.json'), 'utf8')) as FaceData
      if (t.ourState[b]?.aus !== face.aus.map((a) => a.id).join(' ')) continue
      const aus = new Set(face.aus.map((a) => a.id)), channels = new Set(face.channels.map((c) => c.id))
      for (const row of t.rows as { ourAus: string[]; ourChannels: Record<string, string[]> }[]) {
        // 一个 AU 可以只在一副身体上有（面部正在改）；它驱动的通道在这副身体上非空时，它必须在这副身体的 face.json 里
        // an AU may exist on one body only (the face is being reworked); where it drives channels on this body it must be in this body's face.json
        if ((row.ourChannels[b] ?? []).length) expect(row.ourAus.some((au) => aus.has(au)), `${b}: ${row.ourAus.join(' ')}`).toBe(true)
        // 通道里可以有不是肌肉通道的名字（oral_recess 只用于闭合的皮肤）/ a channel may be a non-muscle name (oral_recess applies to a closed skin only)
        for (const ch of row.ourChannels[b] ?? []) expect(channels.has(ch) || ch === 'oral_recess', `${b}: ${ch}`).toBe(true)
      }
    }
  })
  it('organ references each name a listed source and a band that contains its central value', () => {
    for (const r of ORGAN_REFS) {
      expect(ORGAN_SOURCES[r.source], r.source).toBeDefined()
      expect(r.low).toBeLessThanOrEqual(r.central)
      expect(r.high).toBeGreaterThanOrEqual(r.central)
      expect(r.quote.length).toBeGreaterThan(0)
    }
    for (const r of Object.values(REFS)) expect(r.clause.length).toBeGreaterThan(20)
  })
  it('part and joint ids in the tables exist in the body they were computed from', () => {
    for (const b of bodies) {
      const parts = new Set(anatomy(b).parts.map((p) => p.id)), joints = new Set(rig(b).joints.map((j) => j.id))
      for (const id of ['muscle-curves-opensim', 'muscle-curves-myo', 'muscle-attachments-myo', 'organ-volumes']) {
        const t = read(id)
        if (!fresh(t, b, ['anatomy.json', 'rig.json'])) continue
        for (const row of t.rows as { body: string; parts?: string[]; part?: string; ourJoint?: string }[]) {
          if (row.body !== b) continue
          for (const p of row.parts ?? (row.part ? [row.part] : [])) expect(parts.has(p), `${id}: ${p}`).toBe(true)
          if (row.ourJoint) expect(joints.has(row.ourJoint), `${id}: ${row.ourJoint}`).toBe(true)
        }
      }
    }
  })
})

describe('calibration arithmetic', () => {
  it('judges a moment arm by max(8 mm, 35 %)', () => {
    expect(armTolerance(10)).toBe(8)
    expect(armTolerance(-60)).toBeCloseTo(21)
    expect(judgeArm(30, 40)).toEqual({ verdict: 'within' })
    expect(judgeArm(-20, 20)).toEqual({ verdict: 'outside', kind: 'opposite sign' })
    expect(judgeArm(5, 40)).toEqual({ verdict: 'outside', kind: 'too small' })
    expect(judgeArm(90, 40)).toEqual({ verdict: 'outside', kind: 'too large' })
  })
  it('measures the volume of a box, alone and overlapping a copy of itself', () => {
    // 40 × 30 × 20 mm 的盒子 = 24 mL / a 40 × 30 × 20 mm box = 24 mL
    const box = (ox: number): { positions: Float32Array; indices: Uint32Array } => {
      const x = [ox, ox + 0.04], y = [0.0003, 0.0303], z = [0.0002, 0.0202]
      const p: number[] = []
      for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) p.push(x[i]!, y[j]!, z[k]!)
      const idx = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3]
      return { positions: Float32Array.from(p), indices: Uint32Array.from(idx) }
    }
    expect(Math.abs(meshVolumeMl(box(0)))).toBeCloseTo(24, 3)
    expect(unionVolumeMl([box(0)]).ml).toBeGreaterThan(24 * 0.93)
    expect(unionVolumeMl([box(0)]).ml).toBeLessThan(24 * 1.07)
    // 两个错开一半的盒子：并集 36 mL，而不是 48 / two boxes offset by half: the union is 36 mL, not 48
    const u = unionVolumeMl([box(0), box(0.02)]).ml
    expect(u).toBeGreaterThan(36 * 0.93)
    expect(u).toBeLessThan(36 * 1.07)
  })
})

describe('calibration is deterministic', () => {
  it('organ and bone rows recompute to what is stored (when the bodies are unchanged)', async () => {
    const organs = read('organ-volumes'), bones = read('arm-bones')
    const current = ['male', 'female'].every((b) => fresh(organs, b, ['anatomy.json', 'rig.json', 'skeletal.glb']))
    const a = await organRows(), b = await organRows()
    expect(a).toEqual(b)
    const bone = await boneRows()
    expect(bone.rows).toEqual((await boneRows()).rows)
    if (!current) return
    expect(JSON.parse(JSON.stringify(a))).toEqual(organs.rows)
    expect(JSON.parse(JSON.stringify(bone.rows))).toEqual(bones.rows)
  }, 120_000)

  // 需要下载的参照；没有就跳过 / needs the downloaded references; skipped without them
  it.skipIf(!skeletalAvailable().myo || !skeletalAvailable().osim)('moment-arm rows recompute to what is stored (references present, bodies unchanged)', async () => {
    for (const [ref, id] of [['myo', 'muscle-curves-myo'], ['opensim', 'muscle-curves-opensim']] as const) {
      const t = read(id)
      for (const body of ['male', 'female'] as const) {
        const rows = JSON.parse(JSON.stringify(await computeCurveRows(body, ref))) as { muscle: string; side: string; refCoordinate: string }[]
        expect(rows).toEqual(JSON.parse(JSON.stringify(await computeCurveRows(body, ref))))
        if (!fresh(t, body, ['anatomy.json', 'rig.json', 'rig.bin', 'muscular.glb'])) continue
        const key = (r: { muscle: string; side: string; refCoordinate: string }): string => `${r.muscle}|${r.side}|${r.refCoordinate}`
        const stored = new Map((t.rows as { body: string; muscle: string; side: string; refCoordinate: string }[]).filter((r) => r.body === body).map((r) => [key(r), r]))
        expect(rows.length).toBe(stored.size)
        for (const r of rows) expect(stored.get(key(r))).toEqual(r)
      }
    }
  }, 120_000)
})
