// 构建输出里的腔部件：有腔部件时才检查（没有接入这一步、或用 SOMA_LUMEN=0 关掉时跳过）。
// SOMA_MALE_DIR / SOMA_FEMALE_DIR 可把测试指到另一个输出目录（管线的 --out）。
// The lumen parts in a build's output: checked only when the body has any (skipped when the stage is
// not wired in or was switched off with SOMA_LUMEN=0). SOMA_MALE_DIR / SOMA_FEMALE_DIR point the tests
// at another output directory (the pipeline's --out).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnatomyData, Part } from '../src/anatomy/types.ts'
import { readGlbParts } from '../tools/skinmaps/io.ts'
import { selfIntersections } from '../tools/pipeline/lumen.ts'

const DIRS: Record<string, string> = {
  male: process.env.SOMA_MALE_DIR ?? join(import.meta.dirname, '../public/anatomy/male'),
  female: process.env.SOMA_FEMALE_DIR ?? join(import.meta.dirname, '../public/anatomy/female'),
}

for (const [body, dir] of Object.entries(DIRS)) {
  const has = existsSync(join(dir, 'anatomy.json')) && existsSync(join(dir, 'lumen-filling.json'))
  const data = has ? (JSON.parse(readFileSync(join(dir, 'anatomy.json'), 'utf8')) as AnatomyData) : null
  const lumina: Part[] = data ? data.parts.filter((p) => p.id.startsWith('LUMEN_')) : []
  describe.skipIf(!lumina.length)(`lumen parts in the ${body} build`, () => {
    const byId = new Map(data ? data.parts.map((p) => [p.id, p]) : [])
    const index = has ? (JSON.parse(readFileSync(join(dir, 'lumen-filling.json'), 'utf8')) as { file: string; parts: { part: string; rest: number; offset: number; vertices: number }[] }) : { file: '', parts: [] }

    it('are space parts with curated provenance, a source and a composition', () => {
      for (const p of lumina) {
        expect(p.tissue, p.id).toBe('space')
        expect(p.provenance, p.id).toBe('curated')
        expect(p.source, p.id).toBeTruthy()
        expect(p.fma, p.id).toMatch(/^FMA\d+$/)
        expect(p.composition?.length, p.id).toBeGreaterThan(0)
        // 构造的顶点单独成片 / constructed vertices are a piece of their own
        for (const c of p.composition!) expect(['curated', 'construction'], p.id).toContain(c.provenance)
      }
    })

    it('holds the alimentary canal from mouth to anus in the digestive system', () => {
      const ids = lumina.filter((p) => p.system === 'digestive').map((p) => p.id)
      for (const id of ['LUMEN_oral_cavity', 'LUMEN_pharynx', 'LUMEN_esophagus', 'LUMEN_stomach', 'LUMEN_duodenum', 'LUMEN_jejunum', 'LUMEN_ileum', 'LUMEN_ascending_colon', 'LUMEN_transverse_colon', 'LUMEN_descending_colon', 'LUMEN_anal_canal']) expect(ids, id).toContain(id)
    })

    it('lies inside the bounds of the body and adds no caution longer than the UI allows', () => {
      const skin = data!.parts.filter((p) => p.tissue === 'skin').sort((a, b) => b.triangles - a.triangles)[0]!
      for (const p of lumina) for (let q = 0; q < 3; q++) {
        expect(p.bbox[q]!, p.id).toBeGreaterThanOrEqual(skin.bbox[q]! - 0.002)
        expect(p.bbox[q + 3]!, p.id).toBeLessThanOrEqual(skin.bbox[q + 3]! + 0.002)
      }
      for (const c of data!.cautions ?? []) expect(c.zh.length, c.zh.slice(0, 30)).toBeLessThanOrEqual(260)
    })

    it('has a filling field with one float32 xyz per GLB vertex of every lumen part', async () => {
      const bin = readFileSync(join(dir, index.file))
      expect(index.parts.map((r) => r.part).sort()).toEqual(lumina.map((p) => p.id).sort())
      let end = 0
      for (const sys of new Set(lumina.map((p) => p.system))) {
        const meshes = await readGlbParts(join(dir, `${sys}.glb`), new Set(lumina.map((p) => p.id)))
        for (const [id, m] of meshes) {
          const row = index.parts.find((r) => r.part === id)!
          expect(row.vertices, id).toBe(m.positions.length / 3)
          expect(m.indices.length / 3, id).toBe(byId.get(id)!.triangles)
          expect(row.rest, id).toBeGreaterThanOrEqual(0)
          expect(row.rest, id).toBeLessThanOrEqual(1)
          end = Math.max(end, row.offset + 12 * row.vertices)
        }
      }
      expect(bin.byteLength).toBe(end)
      const f = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4)
      let worst = 0
      for (const v of f) {
        expect(Number.isFinite(v)).toBe(true)
        worst = Math.max(worst, Math.abs(v))
      }
      // 没有哪个顶点的位移超过 6 cm（胃最宽处的半径量级） / no vertex moves by more than 6 cm (the order of the stomach's largest radius)
      expect(worst).toBeLessThan(0.06)
    })

    it('does not intersect itself as shipped', async () => {
      // 每个部件单独查（相邻两个部件共用一圈顶点，各自量化后并在一起会被算成相碰）；部件之间的检查取自构建报告（量化之前、整条管一张网格）
      // each part is checked alone (neighbouring parts share a ring of vertices, which quantised separately and merged would count as touching); the check between parts is the build report's (before quantisation, the whole canal as one mesh)
      for (const sys of new Set(lumina.map((p) => p.system))) {
        const meshes = await readGlbParts(join(dir, `${sys}.glb`), new Set(lumina.map((p) => p.id)))
        for (const [id, m] of meshes) expect(selfIntersections({ positions: m.positions, indices: m.indices }, 1e6), id).toBe(0)
      }
      const report = JSON.parse(readFileSync(join(dir, 'pipeline-report.json'), 'utf8')) as { lumen?: { checks: { lumenSurfaceSelfIntersections: { atFull: number; atRest: number; atEmpty: number } }; allLumina: { intersectingTrianglePairs: number; byPartPair: Record<string, number> } } }
      expect(report.lumen?.checks.lumenSurfaceSelfIntersections).toMatchObject({ atFull: 0, atRest: 0, atEmpty: 0 })
      // 标本自己的腔面（不是这一步做的）自身的相交不算 / intersections of the specimen's own lumen surfaces with themselves (not made by this stage) do not count
      const made = Object.entries(report.lumen!.allLumina.byPartPair).filter(([k]) => k.includes('LUMEN_'))
      expect(made).toEqual([])
    }, 300000)
  })
}
