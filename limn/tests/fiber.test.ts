// 生成的 DNA 双螺旋 / generated DNA double helix
import { describe, expect, it } from 'vitest'
import bdna from '../data/bdna.json'
import { packScene } from '../src/landscape/build'
import { dnaAlong, DNA_RADIUS, RISE, TWIST, wander, type Strand } from '../src/landscape/fiber'
import { Occupied, rng } from '../src/landscape/pack'
import { IDENTITY, type Molecule } from '../src/mol/types'
import { buildItem } from '../src/scene/build'
import type { LandscapeSpec } from '../src/scene/spec'
import { defaultColoring } from '../src/style/assign'
import { TONE_LANDSCAPE } from '../src/style/palettes'

const everywhere = () => true

describe('base-pair templates', () => {
  it('are B-DNA: four kinds of pair, phosphates about 9 Å from the axis', () => {
    expect(bdna.pairs.map((p) => p.pair)).toEqual(['CG', 'GC', 'AT', 'TA'])
    for (const p of bdna.pairs) {
      const ps = (p.atoms as [string, number, number, number, number][]).filter((a) => a[4] === 1)
      expect(ps.length).toBe(2)
      for (const a of ps) {
        expect(Math.hypot(a[1], a[2])).toBeGreaterThan(8)
        expect(Math.hypot(a[1], a[2])).toBeLessThan(11)
      }
      // 一个碱基对很扁：沿轴方向不超过几 Å / a base pair is flat: a few Å along the axis at most
      expect(Math.max(...p.atoms.map((a) => Math.abs(a[3] as number)))).toBeLessThan(5)
    }
  })
})

describe('wander', () => {
  it('steps one rise at a time and stays nearly straight over a short stretch', () => {
    const s = wander([0, 0, 0], [1, 0, 0], 100, rng(3), everywhere)
    expect(s.points.length).toBe(100)
    for (let k = 1; k < 100; k++) expect(Math.hypot(...s.points[k]!.map((v, a) => v - s.points[k - 1]![a]!))).toBeCloseTo(RISE, 5)
    // 340 Å 小于持久长度：首尾距离接近伸直的长度 / 340 Å is under the persistence length: end-to-end is close to the contour length
    // 蠕虫链的理论值：<R²> = 2PL(1 - (P/L)(1 - e^(-L/P)))，P = 500 Å 时约为伸直长度的 0.9
    // the worm-like chain predicts <R²> = 2PL(1 - (P/L)(1 - e^(-L/P))), about 0.9 of the contour length for P = 500 Å
    let sum = 0
    for (let seed = 1; seed <= 40; seed++) sum += Math.hypot(...wander([0, 0, 0], [1, 0, 0], 100, rng(seed), everywhere).points[99]!) ** 2
    const L = 99 * RISE, P = 500
    const predicted = Math.sqrt(2 * P * L * (1 - (P / L) * (1 - Math.exp(-L / P))))
    expect(Math.sqrt(sum / 40) / predicted).toBeGreaterThan(0.95)
    expect(Math.sqrt(sum / 40) / predicted).toBeLessThan(1.05)
    expect(s.tangents.every((t) => Math.abs(Math.hypot(...t) - 1) < 1e-9)).toBe(true)
  })

  it('stops at the edge of the region and at an obstacle', () => {
    expect(wander([0, 0, 0], [1, 0, 0], 1000, rng(1), (p) => p[0] < 50).points.length).toBeLessThanOrEqual(Math.ceil(50 / RISE) + 1)
    const occ = new Occupied()
    occ.add(100, 0, 0, 30)
    const s = wander([0, 0, 0], [1, 0, 0], 1000, rng(1), everywhere, occ)
    expect(s.points[s.points.length - 1]![0]).toBeLessThan(100 - 30 + RISE * 4)
  })
})

describe('dnaAlong', () => {
  const straight = (n: number): Strand => ({ points: Array.from({ length: n }, (_, k) => [0, 0, k * RISE] as [number, number, number]), tangents: Array.from({ length: n }, () => [0, 0, 1] as [number, number, number]) })

  it('places one base pair per step and turns once every 10.5 pairs', () => {
    const mol = dnaAlong([straight(21)], rng(5))
    const asm = mol.assemblies[1]!
    const ops = asm.groups.flatMap((g) => g.operators).sort((a, b) => a[14]! - b[14]!)
    expect(ops.length).toBe(21)
    // 第 k 对绕轴转了 k·TWIST：x 轴方向的夹角 / pair k has turned k x TWIST about the axis: the angle of its x axis
    const angle = (m: Float32Array) => Math.atan2(m[1]!, m[0]!)
    const turn = (((angle(ops[1]!) - angle(ops[0]!)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    expect(turn).toBeCloseTo(TWIST, 4)
    // 21 对正好两圈：最后一对与第一对同向 / 21 pairs are exactly two turns: the last faces the same way as the first
    const full = dnaAlong([straight(22)], rng(5)).assemblies[1]!.groups.flatMap((g) => g.operators).sort((a, b) => a[14]! - b[14]!)
    expect(Math.cos(angle(full[21]!) - angle(full[0]!))).toBeCloseTo(1, 4)
    expect(ops.every((m) => m[10] === 1 && m[12] === 0 && m[13] === 0)).toBe(true)
  })

  it('draws each strand as one continuous molecule with a depth layer per pair', () => {
    const mol = dnaAlong([straight(30), straight(12)], rng(2))
    expect(mol.assemblies.map((a) => a.id)).toEqual(['asym', 's0', 's1'])
    const item = buildItem(mol, defaultColoring(mol), TONE_LANDSCAPE, [{ assembly: 's0', molecule: 7, strand: true }, { assembly: 's1', molecule: 8, strand: true }])
    expect(item.instances.count).toBe(42)
    const ids = new Set<number>()
    for (let o = 0; o < 42; o++) {
      ids.add(item.instances.ids[o * 2 + 1]!)
      expect(item.instances.data[o * 16 + 15]).toBe(2)
    }
    expect([...ids].sort()).toEqual([7, 8])
  })
})

describe('DNA in a packed scene', () => {
  const blob = (n: number, size: number): Molecule => {
    const r = rng(9)
    const pos = new Float32Array(n * 3)
    for (let i = 0; i < n * 3; i++) pos[i] = (r() - 0.5) * size
    return {
      id: 'b', title: 'b', atomCount: n, pos, element: new Uint8Array(n), chainOf: new Uint32Array(n), isTrace: new Uint8Array(n), residue: new Int32Array(n),
      chains: [{ asymId: 'A', authAsymId: 'A', entity: 0, start: 0, count: n, model: 1 }],
      entities: [{ id: '1', description: 'b', kind: 'protein' }],
      assemblies: [{ id: 'asym', groups: [{ chains: [0], operators: [IDENTITY] }] }],
    }
  }
  const spec: LandscapeSpec = { width: 500, height: 400, depth: 200, membrane: false, above: '', below: 'cytoplasm', ingredients: [{ panel: 0, compartment: 'below', copies: 30, abundance: '', feature: false }], dna: { length: 1500, basis: 'test' } }

  it('lays about the length asked for, and proteins keep clear of it', () => {
    const mol = blob(400, 40)
    const packed = packScene([{ mol, assembly: 'asym' }], spec, null, 4)
    const dna = packed.dna!
    const ops = dna.assemblies.slice(1).flatMap((a) => a.groups.flatMap((g) => g.operators))
    expect(ops.length * RISE).toBeGreaterThan(1000)
    expect(ops.length * RISE).toBeLessThan(1500 + 700)
    // 每个蛋白的中心离任何一个碱基对的轴心都不小于双螺旋半径 / every protein's centre is at least a duplex radius from the axis at any base pair
    for (const m of packed.places[0]!) {
      for (const o of ops) expect(Math.hypot(m[12]! - o[12]!, m[13]! - o[13]!, m[14]! - o[14]!)).toBeGreaterThan(DNA_RADIUS)
    }
    expect(packScene([{ mol, assembly: 'asym' }], { ...spec, dna: undefined }, null, 4).dna).toBeNull()
  })
})
