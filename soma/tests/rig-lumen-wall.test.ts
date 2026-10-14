// 腔随壁（tools/rig/bind.ts 的 lumenWallIds 和 wall 方法）：按名称找壁的规则，以及发布的男性绑定里每个腔部件都用了这个方法。
// 没有腔部件的身体（女性目前如此）跳过后一项。
// Lumina follow their walls (lumenWallIds and the `wall` method of tools/rig/bind.ts): the rule that finds
// the walls by name, and that every lumen part of the shipped male rig is bound by that method. A body
// without lumen parts (the female, for now) skips the second check.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnatomyData } from '../src/anatomy/types.ts'
import { isLumenPart, lumenWallIds } from '../tools/rig/bind.ts'

const part = (id: string, name: string, tissue: string, adjacent: string[] = []) => ({ id, name, tissue, adjacent }) as never

describe('lumen parts are bound to their walls', () => {
  it('finds the wall by name, pieces included, and falls back to the neighbours', () => {
    const parts = [
      part('FJ1', 'Stomach', 'organ'),
      part('FJ2', 'Proximal part of jejunum', 'organ'),
      part('FJ3', 'Distal part of jejunum', 'organ'),
      part('FJ4', 'Left ureter', 'organ'),
      part('FJ5', 'Tongue', 'organ'),
      part('FJ6', 'Left maxilla', 'bone'),
      part('FJ7', 'Facial nerve', 'nerve'),
      // 心腔是扫描的部件，不是腔这一步做的：不算 / a heart cavity is a scanned part, not one of the lumen stage: not counted
      part('FJ8', 'Cavity of left ventricle', 'space'),
      part('LUMEN_stomach', 'Cavity of stomach', 'space', ['FJ7']),
      part('LUMEN_jejunum', 'Lumen of jejunum', 'space', ['FJ1']),
      part('LUMEN_ureter_L', 'Lumen of left ureter', 'space'),
      part('LUMEN_oral_cavity', 'Oral cavity proper', 'space', ['FJ5', 'FJ6', 'FJ7', 'FJ8', 'LUMEN_stomach']),
      part('LUMEN_nothing', 'Lumen of nothing', 'space', ['FJ7']),
    ]
    expect(parts.filter(isLumenPart).length).toBe(5)
    const r = lumenWallIds(parts)
    expect(r.byLumen.get('LUMEN_stomach')).toEqual({ walls: ['FJ1'], how: 'name' })
    expect(r.byLumen.get('LUMEN_jejunum')).toEqual({ walls: ['FJ2', 'FJ3'], how: 'name' })
    expect(r.byLumen.get('LUMEN_ureter_L')).toEqual({ walls: ['FJ4'], how: 'name' })
    // 没有同名部件：相邻的器官和骨，不要神经、别的腔 / no part of that name: the neighbouring organ and bone, not the nerve or another space
    expect(r.byLumen.get('LUMEN_oral_cavity')).toEqual({ walls: ['FJ5', 'FJ6'], how: 'neighbours' })
    expect(r.byLumen.get('LUMEN_nothing')).toEqual({ walls: [], how: 'none' })
    expect(r.pool).toEqual(['FJ1', 'FJ2', 'FJ3', 'FJ4', 'FJ5', 'FJ6'])
    expect(isLumenPart({ id: 'W_LUMEN_rectum' })).toBe(true)
    expect(isLumenPart({ id: 'FJ8' })).toBe(false)
  })

  for (const body of ['male', 'female']) {
    const dir = process.env[`SOMA_${body.toUpperCase()}_DIR`] ?? join(import.meta.dirname, `../public/anatomy/${body}`)
    const present = existsSync(join(dir, 'anatomy.json')) && existsSync(join(dir, 'rig-report.json'))
    const data = present ? (JSON.parse(readFileSync(join(dir, 'anatomy.json'), 'utf8')) as AnatomyData) : null
    const lumina = data ? data.parts.filter(isLumenPart) : []
    it.skipIf(!lumina.length)(`${body}: every lumen part has a wall and is bound by the wall method`, () => {
      const r = lumenWallIds(data!.parts)
      for (const l of lumina) expect(r.byLumen.get(l.id)!.walls.length, l.id).toBeGreaterThan(0)
      const report = JSON.parse(readFileSync(join(dir, 'rig-report.json'), 'utf8')) as { bindings: Record<string, { parts: number }> }
      expect(report.bindings.wall?.parts).toBe(lumina.length)
    })
  }
})
