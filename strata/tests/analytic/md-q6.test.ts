import { describe, expect, it } from 'vitest'
import { LJ, analyticPair } from '../../src/substrates/md/potential'
import { initFcc } from '../../src/substrates/md/ref/init'
import { Q6_COMPONENTS, addQ6, q6Summary, steinhardt } from '../../src/substrates/md/ref/reducers'
import { createState, step, type MdState } from '../../src/substrates/md/ref/step'

const pair = analyticPair(LJ)

/** 由晶胞基矢与基元生成周期晶格。 / A periodic lattice from cell edge lengths and a basis. */
function lattice(cells: number, edge: [number, number, number], basis: number[][]): MdState {
  const s = createState(3, cells ** 3 * basis.length, [cells * edge[0], cells * edge[1], cells * edge[2]])
  let i = 0
  for (let z = 0; z < cells; z++) {
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        for (const b of basis) {
          s.pos[3 * i] = (x + b[0]!) * edge[0]
          s.pos[3 * i + 1] = (y + b[1]!) * edge[1]
          s.pos[3 * i + 2] = (z + b[2]!) * edge[2]
          i++
        }
      }
    }
  }
  return s
}

// 理想结构的 q₆（Steinhardt, Nelson & Ronchetti 1983 及后来文献中的表）：
// 面心立方 0.575，六方密堆 0.485，体心立方（取 14 个近邻）0.511，简单立方 0.354，二十面体 0.663。
// q₆ of ideal structures (tables in Steinhardt, Nelson & Ronchetti 1983 and later papers):
// fcc 0.575, hcp 0.485, bcc (with 14 neighbours) 0.511, simple cubic 0.354, icosahedral 0.663.
describe('Steinhardt q6 of ideal structures', () => {
  it('face-centred cubic: 0.575', () => {
    const s = initFcc({ cells: 4, density: 1.0, temperature: 0, seed: 1 }, pair)
    const { local, averaged } = steinhardt(s)
    for (let i = 0; i < s.n; i++) {
      expect(local[i]).toBeCloseTo(0.5745, 3)
      expect(averaged[i]).toBeCloseTo(0.5745, 3)
    }
  })

  it('simple cubic: 0.354', () => {
    const s = lattice(4, [1.1, 1.1, 1.1], [[0, 0, 0]])
    for (const q of steinhardt(s).local) expect(q).toBeCloseTo(0.3536, 3)
  })

  it('body-centred cubic with 14 neighbours: 0.511', () => {
    // 最近邻 a√3/2 = 1.1，次近邻 a = 1.27，都在 1.35 之内；第三壳层在 1.80。
    // Nearest neighbours at a√3/2 = 1.1 and second neighbours at a = 1.27 are both within 1.35; the third shell is at 1.80.
    const a = 1.1 / (Math.sqrt(3) / 2)
    const s = lattice(4, [a, a, a], [
      [0, 0, 0],
      [0.5, 0.5, 0.5],
    ])
    for (const q of steinhardt(s).local) expect(q).toBeCloseTo(0.5107, 3)
  })

  it('hexagonal close-packed: 0.485', () => {
    // 正交晶胞，4 个原子：a × a√3 × a√(8/3)。
    // Orthorhombic cell with 4 atoms: a × a√3 × a√(8/3).
    const a = 1.1
    const s = lattice(4, [a, a * Math.sqrt(3), a * Math.sqrt(8 / 3)], [
      [0, 0, 0],
      [0.5, 0.5, 0],
      [0.5, 1 / 6, 0.5],
      [0, 2 / 3, 0.5],
    ])
    for (const q of steinhardt(s).local) expect(q).toBeCloseTo(0.4848, 3)
  })

  it('icosahedron: 0.663 for the central particle', () => {
    const phi = (1 + Math.sqrt(5)) / 2
    const out = new Float64Array(Q6_COMPONENTS)
    const norm = Math.hypot(1, phi)
    for (const [a, b] of [
      [1, phi],
      [1, -phi],
      [-1, phi],
      [-1, -phi],
    ]) {
      // 十二个顶点：(0, ±1, ±φ) 的三种循环排列。 / The twelve vertices: cyclic permutations of (0, ±1, ±φ).
      addQ6(out, 0, 0, a! / norm, b! / norm)
      addQ6(out, 0, a! / norm, b! / norm, 0)
      addQ6(out, 0, b! / norm, 0, a! / norm)
    }
    expect(Math.hypot(...Array.from(out, (v) => v / 12))).toBeCloseTo(0.6633, 3)
  })

  it('does not depend on how the crystal is oriented', () => {
    // 把一个键矢量集合整体旋转，q₆ 不变。 / Rotating a set of bond vectors as a whole leaves q₆ unchanged.
    const bonds = [
      [1, 0, 0],
      [0, 1, 0],
      [0.6, 0, 0.8],
      [-0.3, 0.5, Math.sqrt(1 - 0.34)],
    ]
    const q = (rotate: (v: number[]) => number[]) => {
      const out = new Float64Array(Q6_COMPONENTS)
      for (const b of bonds) {
        const [x, y, z] = rotate(b)
        addQ6(out, 0, x!, y!, z!)
      }
      return Math.hypot(...out)
    }
    const c = Math.cos(0.7)
    const sn = Math.sin(0.7)
    const about = (v: number[]) => [v[0]!, c * v[1]! - sn * v[2]!, sn * v[1]! + c * v[2]!]
    const aboutZ = (v: number[]) => [c * v[0]! - sn * v[1]!, sn * v[0]! + c * v[1]!, v[2]!]
    expect(q(about)).toBeCloseTo(q((v) => v), 10)
    expect(q((v) => aboutZ(about(v)))).toBeCloseTo(q((v) => v), 10)
  })
})

describe('q6 separates liquid from crystal', () => {
  it('a melted crystal loses its averaged order', () => {
    const s = initFcc({ cells: 5, density: 0.85, temperature: 2.5, seed: 3 }, pair)
    const cold = q6Summary(initFcc({ cells: 5, density: 0.85, temperature: 0, seed: 3 }, pair))
    expect(cold.crystalFraction).toBe(1)
    step(s, pair, 0.004, 2000)
    const hot = q6Summary(s)
    console.log(`melted: mean q6 ${hot.local.toFixed(3)}, mean averaged q6 ${hot.averaged.toFixed(3)}, crystalline fraction ${hot.crystalFraction.toFixed(3)}`)
    expect(hot.averaged).toBeLessThan(0.25)
    expect(hot.crystalFraction).toBeLessThan(0.1)
    // 局域的 q₆ 在液体里并不小，这正是需要近邻平均的原因。
    // The local q₆ is not small in the liquid, which is exactly why the neighbour average is needed.
    expect(hot.local).toBeGreaterThan(hot.averaged + 0.1)
  })
})
