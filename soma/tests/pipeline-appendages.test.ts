// 体表附属物贴合到皮肤上（tools/pipeline/appendages.ts）：合成几何上的单元测试，
// 以及——当 public/anatomy/male 是装入了皮肤包的构建时（SOMA_ARM_ABDUCTION=0）——对其报告的检查。
// Conforming appendages to a skin (tools/pipeline/appendages.ts): unit tests on synthetic geometry and,
// when public/anatomy/male is a build with a skin package installed (SOMA_ARM_ABDUCTION=0), checks of its report.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnatomyData } from '../src/anatomy/types.ts'
import { appendageKind, conformAppendages, type AppendageRow } from '../tools/pipeline/appendages.ts'
import { measure, type Mesh } from '../tools/pipeline/geometry.ts'

/** 细分八面体得到的球面，外法向朝外 / a sphere from a subdivided octahedron, wound outwards */
function sphere(radius: number, level: number, centre: [number, number, number] = [0, 0, 0]): Mesh {
  let v: number[][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  let f: number[][] = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]]
  for (let l = 0; l < level; l++) {
    const mid = new Map<string, number>()
    const m = (a: number, b: number) => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`
      if (!mid.has(k)) {
        const p = [0, 1, 2].map((i) => v[a]![i]! + v[b]![i]!)
        const n = Math.hypot(p[0]!, p[1]!, p[2]!)
        mid.set(k, v.length)
        v.push(p.map((x) => x / n))
      }
      return mid.get(k)!
    }
    f = f.flatMap(([a, b, c]) => {
      const ab = m(a!, b!), bc = m(b!, c!), ca = m(c!, a!)
      return [[a!, ab, ca], [b!, bc, ab], [c!, ca, bc], [ab, bc, ca]]
    })
  }
  return { positions: Float32Array.from(v.flatMap((p) => p.map((x, i) => x * radius + centre[i]!))), indices: Uint32Array.from(f.flat()) }
}

/** 球冠形的封闭薄壳：`keep` 选出的球面三角形，内面半径 r0、外面半径 r1，边缘缝合 / a closed thin shell over a cap: the sphere triangles chosen by `keep`, inner face at r0 and outer at r1, stitched along the rim */
function capShell(r0: number, r1: number, level: number, keep: (c: number[]) => boolean): Mesh {
  const s = sphere(1, level)
  const tris: number[][] = []
  for (let t = 0; t < s.indices.length; t += 3) {
    const ids = [s.indices[t]!, s.indices[t + 1]!, s.indices[t + 2]!]
    const c = [0, 1, 2].map((k) => ids.reduce((a, i) => a + s.positions[3 * i + k]!, 0) / 3)
    if (keep(c)) tris.push(ids)
  }
  const used = [...new Set(tris.flat())]
  const at = new Map(used.map((i, j) => [i, j]))
  const n = used.length
  const pos: number[] = []
  for (const r of [r1, r0]) for (const i of used) pos.push(s.positions[3 * i]! * r, s.positions[3 * i + 1]! * r, s.positions[3 * i + 2]! * r)
  const idx: number[] = []
  const edges = new Map<string, [number, number]>()
  for (const [a, b, c] of tris.map((t) => t.map((i) => at.get(i)!))) {
    idx.push(a!, b!, c!, n + a!, n + c!, n + b!)
    for (const [p, q] of [[a!, b!], [b!, c!], [c!, a!]]) {
      if (edges.has(`${q}_${p}`)) edges.delete(`${q}_${p}`)
      else edges.set(`${p}_${q}`, [p!, q!])
    }
  }
  // 边缘：外面的边 p→q 与内面对应的边缝成两个三角形 / the rim: an outer edge p→q and its inner twin make two triangles
  for (const [p, q] of edges.values()) idx.push(p, n + p, q, q, n + p, n + q)
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

const radii = (m: Mesh, c: [number, number, number] = [0, 0, 0]) => {
  const out: number[] = []
  for (let i = 0; i < m.positions.length; i += 3) out.push(Math.hypot(m.positions[i]! - c[0], m.positions[i + 1]! - c[1], m.positions[i + 2]! - c[2]))
  return out
}

describe('appendage kinds', () => {
  it('recognises hair shells, nails and auricles by name and nothing else', () => {
    for (const n of ['Hair of head', 'Eyebrow', 'Pubic hair', 'Eyelash']) expect(appendageKind(n), n).toBe('shell')
    for (const n of ['Left nail plate', 'Right nail plate (foot)', 'Left perionyx', 'Right perionyx (foot)']) expect(appendageKind(n), n).toBe('nail')
    expect(appendageKind('External ear')).toBe('auricle')
    for (const n of ['Skin', 'Left nipple', 'Left female areola', 'Tarsal plate of left upper eyelid', 'Subcutaneous tissue of head']) expect(appendageKind(n), n).toBeNull()
  })
})

describe('conformAppendages on a sphere', () => {
  const R = 0.1
  const skin = sphere(R, 5)
  // 细分 5 次的球面离真球最多凹进约 0.1 mm / a level-5 sphere sags up to about 0.1 mm inside the true one
  const TOL = 0.00025

  it('puts the inner face of a floating hair shell onto the skin and keeps its thickness', () => {
    // 浮在皮肤外 3 mm、厚 4 mm 的壳 / a shell floating 3 mm above the skin, 4 mm thick
    const shell = capShell(R + 0.003, R + 0.007, 4, (c) => c[1]! > 0.5)
    const res = conformAppendages(skin, [{ id: 'hair', name: 'Hair of head', mesh: shell }])
    const out = res.moved.get('hair')!
    const r = radii(out)
    const n = r.length / 2
    const outer = r.slice(0, n)
    const inner = r.slice(n)
    for (const x of inner) expect(Math.abs(x - (R - 0.0005))).toBeLessThan(TOL)
    // 外面跟着走：厚度仍是 4 mm 左右 / the outer face follows: still about 4 mm thick
    for (const x of outer) expect(Math.abs(x - (R + 0.0035))).toBeLessThan(0.0006)
    const row = res.report.parts[0]!
    expect(row.kind).toBe('shell')
    expect(row.skinSide.face).toBe('inner')
    expect(row.skinSide.before.minMm).toBeGreaterThan(2.5)
    expect(Math.abs(row.skinSide.after.maxMm + 0.5)).toBeLessThan(0.1)
    expect(Math.abs(measure(out).signedVolume / measure(shell).signedVolume - 1)).toBeLessThan(0.1)
    // 只沿法向移动 / moved along the normal only
    for (let i = 0; i < out.positions.length; i += 3) {
      const a = [shell.positions[i]!, shell.positions[i + 1]!, shell.positions[i + 2]!]
      const b = [out.positions[i]!, out.positions[i + 1]!, out.positions[i + 2]!]
      const cos = (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (Math.hypot(...a) * Math.hypot(...b))
      expect(cos).toBeGreaterThan(0.99995)
    }
  })

  it('lifts a sunken hair shell out as well', () => {
    const shell = capShell(R - 0.006, R - 0.002, 4, (c) => c[2]! > 0.6)
    const out = conformAppendages(skin, [{ id: 'b', name: 'Eyebrow', mesh: shell }]).moved.get('b')!
    const r = radii(out)
    for (const x of r.slice(r.length / 2)) expect(Math.abs(x - (R - 0.0005))).toBeLessThan(TOL)
    for (const x of r.slice(0, r.length / 2)) expect(x).toBeGreaterThan(R + 0.003)
  })

  it('brings the outer face of a sunken nail just proud of the skin without sliding it', () => {
    // 陷在皮肤下 2 mm、厚 0.6 mm 的甲 / a nail 2 mm under the skin, 0.6 mm thick
    const nail = capShell(R - 0.0026, R - 0.002, 5, (c) => c[0]! > 0.985)
    const res = conformAppendages(skin, [{ id: 'n', name: 'Left nail plate', mesh: nail }])
    const out = res.moved.get('n')!
    const r = radii(out)
    for (const x of r.slice(0, r.length / 2)) expect(Math.abs(x - (R + 0.0002))).toBeLessThan(TOL)
    for (const x of r.slice(r.length / 2)) expect(Math.abs(x - (R - 0.0004))).toBeLessThan(0.0004)
    expect(res.report.parts[0]!.skinSide.face).toBe('outer')
    for (let i = 0; i < out.positions.length; i += 3) {
      const a = [nail.positions[i]!, nail.positions[i + 1]!, nail.positions[i + 2]!]
      const b = [out.positions[i]!, out.positions[i + 1]!, out.positions[i + 2]!]
      expect((a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (Math.hypot(...a) * Math.hypot(...b))).toBeGreaterThan(0.99995)
    }
  })

  it('leaves an auricle exactly as it is and lists it to be hidden while the skin is opaque', () => {
    // 一个半径 15 mm 的小球，球心在皮肤下 5 mm：一半露在外面 / a ball of 15 mm radius centred 5 mm under the skin: half of it sticks out
    const ear = sphere(0.015, 4, [R - 0.005, 0, 0])
    const res = conformAppendages(skin, [{ id: 'e', name: 'External ear', mesh: ear }])
    expect(res.moved.has('e')).toBe(false)
    expect(res.report.hideWithOpaqueSkin).toEqual(['e'])
    expect(res.report.auricle.shown).toBe('skin')
    const row = res.report.parts[0]!
    expect(row.supersededBySkin).toBe(true)
    expect(row.displacementMm.max).toBe(0)
    expect(row.after).toEqual(row.before)
    expect(row.before.outside).toBeGreaterThan(0.2)
  })

  it('conforms unconnected tufts of one shell together, by their neighbours', () => {
    // 两片互不相连的壳拼成一个部件，其中一小片浮得更高：它随旁边的大片一起落到皮肤上，不单独处理
    // two unconnected shells in one part, the small one floating higher: it comes down onto the skin with the large one beside it, not handled on its own
    const big = capShell(R + 0.003, R + 0.005, 4, (c) => c[1]! > 0.8)
    const small = capShell(R + 0.004, R + 0.006, 4, (c) => c[1]! > 0.6 && c[1]! <= 0.8 && c[0]! > 0.5)
    const nb = big.positions.length / 3
    const mesh: Mesh = { positions: Float32Array.from([...big.positions, ...small.positions]), indices: Uint32Array.from([...big.indices, ...Array.from(small.indices, (i) => i + nb)]) }
    const res = conformAppendages(skin, [{ id: 'b', name: 'Eyebrow', mesh }])
    expect(res.report.parts[0]!.components).toBe(2)
    const r = radii(res.moved.get('b')!)
    const ns = small.positions.length / 6
    // 小片的内面也在皮肤下 0.5 mm，外面仍在其上约 2 mm / the small piece's inner face is 0.5 mm under the skin as well, its outer face still about 2 mm above that
    for (const x of r.slice(nb + ns)) expect(Math.abs(x - (R - 0.0005))).toBeLessThan(TOL)
    for (const x of r.slice(nb, nb + ns)) expect(Math.abs(x - (R + 0.0015))).toBeLessThan(0.0006)
  })

  it('skips parts that are no appendage and says so', () => {
    const res = conformAppendages(skin, [{ id: 'x', name: 'Left nipple', mesh: sphere(0.004, 2, [R, 0, 0]) }])
    expect(res.moved.size).toBe(0)
    expect(res.report.notHandled).toEqual(['Left nipple'])
  })
})

const DIR = process.env.SOMA_MALE_DIR ?? join(import.meta.dirname, '../public/anatomy/male')
const present = existsSync(join(DIR, 'anatomy.json')) && existsSync(join(DIR, 'pipeline-report.json'))
const report = (present ? JSON.parse(readFileSync(join(DIR, 'pipeline-report.json'), 'utf8')) : {}) as { skinPackage?: { installed?: boolean; notFitted?: { surfaceParts: { worst: { name: string }[] } } }; appendages?: { applied: boolean; parts?: AppendageRow[]; conformedIds?: string[]; relabelledIds?: string[]; hideWithOpaqueSkin?: string[]; auricle?: { shown: string } } }
const installed = present && !!report.skinPackage?.installed

describe.skipIf(!present)('male appendages (public/anatomy/male)', () => {
  it('conforms the appendages exactly when a skin package is installed', () => {
    expect(report.appendages!.applied).toBe(installed)
  })
})

describe.skipIf(!installed)('male appendages on the installed skin (build with SOMA_ARM_ABDUCTION=0)', () => {
  const data = (installed ? JSON.parse(readFileSync(join(DIR, 'anatomy.json'), 'utf8')) : null) as AnatomyData
  const rows = () => report.appendages!.parts!
  const row = (name: string) => rows().find((r) => r.name === name)!

  it('handles hair, eyebrows, pubic hair, the auricles and every nail part', () => {
    expect(rows().map((r) => r.name).sort()).toEqual(['External ear', 'Eyebrow', 'Hair of head', 'Left nail plate', 'Left nail plate (foot)', 'Left perionyx', 'Left perionyx (foot)', 'Pubic hair', 'Right nail plate', 'Right nail plate (foot)', 'Right perionyx', 'Right perionyx (foot)'])
    for (const r of rows()) expect(r.verticesOutOfReach, r.name).toBe(0)
  })

  it('puts the skin side of each hair shell 0.5 mm under the skin', () => {
    // 眉：几百根互不相连的小毛按整个部件一起贴合，没有哪一根飞出去（贴合后离皮肤最远不超过 3 mm）
    // eyebrow: its hundreds of unconnected tufts are conformed together as one part and none flies off (nothing further than 3 mm from the skin afterwards)
    expect(row('Eyebrow').components).toBeGreaterThan(100)
    expect(row('Eyebrow').after.maxMm).toBeLessThan(3)
    for (const n of ['Hair of head', 'Eyebrow', 'Pubic hair']) {
      const r = row(n)
      expect(r.skinSide.face).toBe('inner')
      expect(r.skinSide.after.minMm, n).toBeGreaterThanOrEqual(-0.6)
      expect(r.skinSide.after.maxMm, n).toBeLessThanOrEqual(-0.4)
      // 壳还在：外面在皮肤之外，体积变化不大 / the shell is still there: its outer side outside the skin, its volume not much changed
      expect(r.after.maxMm, n).toBeGreaterThan(1)
      expect(Math.abs(r.volumeMl[1] / r.volumeMl[0] - 1), n).toBeLessThan(0.2)
    }
    // 贴合前眉大半浮在皮肤外，头发有一部分陷在皮肤里 / before, most of the eyebrows floated above the skin and part of the hair was sunk in it
    expect(row('Eyebrow').skinSide.before.medianMm).toBeGreaterThan(1.5)
    expect(row('Hair of head').skinSide.before.minMm).toBeLessThan(-10)
  })

  it('brings every nail to the surface, moved along the skin normal by millimetres only', () => {
    for (const r of rows().filter((x) => x.kind === 'nail')) {
      expect(r.components, r.name).toBe(5)
      expect(r.skinSide.face).toBe('outer')
      // 移植来的脚趾表面在趾蹼处弯得急，足部甲周有个别采样点偏差到 −0.1 / +0.4 mm（目标 +0.2）。
      // The grafted toes curve sharply at the webs, so a few samples of the foot perionyx sit at −0.1 / +0.4 mm (target +0.2).
      const foot = /foot|toe/i.test(r.name)
      expect(r.skinSide.after.minMm, r.name).toBeGreaterThanOrEqual(foot ? -0.2 : 0.1)
      expect(r.skinSide.after.maxMm, r.name).toBeLessThanOrEqual(foot ? 0.5 : 0.3)
      // 手指甲原先深埋在皮肤下；足趾甲在移植了分开的脚趾之后不一定如此（左足趾甲起点是 +1.3 mm）。
      // Finger nails start sunk under the skin; toe nails need not once separate toes are grafted (the left foot's start at +1.3 mm).
      if (!/foot|toe/i.test(r.name)) expect(r.skinSide.before.minMm, r.name).toBeLessThan(-3)
      // 趾甲部件是按旧皮肤摆放的，在移植来的脚趾外面浮着 4–8 mm，贴合时要移动约 9 mm；手指甲不超过 8 mm。
      // The toe nail plates were placed for the old skin and float 4–8 mm outside the grafted toes, so they move about 9 mm; finger nails stay under 8.
      expect(r.displacementMm.max, r.name).toBeLessThan(/foot|toe/i.test(r.name) ? 12 : 8)
    }
  })

  it('shows the ear of the skin only: the scanned auricle is untouched and listed to be hidden while the skin is opaque', () => {
    expect(report.appendages!.auricle!.shown).toBe('skin')
    const r = row('External ear')
    expect(r.supersededBySkin).toBe(true)
    expect(r.displacementMm.max).toBe(0)
    expect(r.volumeMl[1]).toBe(r.volumeMl[0])
    expect(r.after).toEqual(r.before)
    const ear = data.parts.find((p) => p.name === 'External ear')!
    // 皮肤带真实口裂时，深部的"唇"部件也在这个清单里 / with a real mouth opening the deep Lip part is on this list too
    expect(report.appendages!.hideWithOpaqueSkin).toContain(ear.id)
    expect(report.appendages!.conformedIds).not.toContain(ear.id)
    // 没有被形变，所以仍是 scanned / not deformed, so still scanned
    expect(ear.provenance).toBe('scanned')
  })

  it('relabels the deformed BodyParts3D appendages warped and no longer lists them as not fitted', () => {
    const ids = report.appendages!.relabelledIds!
    expect(ids.map((id) => data.parts.find((p) => p.id === id)!.name).sort()).toEqual(['Eyebrow', 'Hair of head', 'Pubic hair'])
    for (const id of ids) expect(data.parts.find((p) => p.id === id)!.provenance).toBe('warped')
    const left = report.skinPackage!.notFitted!.surfaceParts.worst.map((w) => w.name).join('; ')
    expect(left).not.toMatch(/hair|eyebrow|\bear\b|nail|perionyx/i)
    const c = data.cautions!.map((x) => x.en).join(' ')
    expect(c).toContain('The ears that show are the skin model')
    expect(c).not.toContain('do not sit on this one')
  })
})
