/**
 * 把一批“显式”的分子（每个分子自己的坐标，不是实例化的）粗化成球并打包。
 * .gro 和大的 PDB 都走这里；PetWorld 的实例化模型有自己的一套（petworld.ts）。
 *
 * Coarsen a set of "explicit" molecules (each with coordinates of its own, not instanced) into
 * spheres and pack them. Both .gro files and large PDB files come through here; PetWorld's
 * instanced models have their own code (petworld.ts).
 */
import type { PreparedHeader, PreparedObject } from '../../src/mol/prepared'

/** 一个部分：画出来是一个对象。蛋白的一条链是一个部分；一种脂质的全部分子是一个部分。/ A part, drawn as one object. A protein chain is a part; all the molecules of one lipid are a part. */
export interface Part {
  name: string
  /** 图例里的种类 / its kind in the legend */
  kind: string
  lipid: boolean
  /** 各个分子的粒子坐标（Å）；合并不跨分子 / particle coordinates of each molecule in Å; merging never crosses molecules */
  molecules: { xyz: number[] }[]
}

/**
 * 脂质的球合并之后至少这么大（Å）。膜里相邻的脂质相距约 8 Å，球再小就连不成一张膜，会从缝里看到对面。
 * Merged lipid spheres are at least this large (Å). Neighbouring lipids in a membrane are about
 * 8 Å apart, and smaller spheres would not join into a sheet: the far side would show through.
 */
const LIPID_MIN_RADIUS = 5

/**
 * g 取使球数不超过预算的最小整数；每个分子里相邻的 g 个粒子并成一个球，球心是质心。
 * `weight` 是一个粒子相当于几个重原子（原子是 1，Martini 珠子约 4）；一个重原子的球半径 1.7 Å，
 * 合并后按重原子数的立方根放大，和 src/mol/coarse.ts 里“一个残基（约 8 个重原子）3.4 Å”一致。
 *
 * g is the smallest whole number that keeps the spheres within the budget; every g neighbouring
 * particles within a molecule are merged into one sphere at their centroid. `weight` is how many
 * heavy atoms a particle stands for (1 for an atom, about 4 for a Martini bead); a single heavy
 * atom gets 1.7 Å, growing as the cube root of the heavy-atom count, in line with the 3.4 Å per
 * residue (about 8 heavy atoms) of src/mol/coarse.ts.
 */
export function packParts(parts: Part[], source: string, budget: number, unit: 'atoms' | 'beads', weight: number, particles: number): { header: PreparedHeader; spheres: Float32Array; ops: Float32Array } {
  const count = (g: number) => parts.reduce((s, p) => s + p.molecules.reduce((t, m) => t + Math.ceil(m.xyz.length / 3 / g), 0), 0)
  let g = 1
  while (count(g) > budget && g < 1e6) g++
  const spheres = new Float32Array(count(g) * 4)
  let at = 0
  const objects: PreparedObject[] = []
  for (const part of parts) {
    const start = at
    let n = 0
    for (const m of part.molecules) {
      const k = m.xyz.length / 3, pieces = Math.ceil(k / g)
      n += k
      for (let p = 0; p < pieces; p++) {
        const a = Math.floor((p * k) / pieces), b = Math.floor(((p + 1) * k) / pieces)
        let x = 0, y = 0, z = 0
        for (let i = a; i < b; i++) {
          x += m.xyz[i * 3]!
          y += m.xyz[i * 3 + 1]!
          z += m.xyz[i * 3 + 2]!
        }
        const heavy = (b - a) * weight
        const r = 3.4 * Math.cbrt(heavy / 8)
        spheres[at * 4] = x / (b - a)
        spheres[at * 4 + 1] = y / (b - a)
        spheres[at * 4 + 2] = z / (b - a)
        spheres[at * 4 + 3] = part.lipid && heavy > 1 ? Math.max(LIPID_MIN_RADIUS, r) : r
        at++
      }
    }
    objects.push({ name: part.name, kind: part.kind, instances: 1, opStart: 0, atoms: n, heavy: n, chains: [{ id: part.lipid ? part.name : 'A', lipid: part.lipid, start, count: at - start }] })
  }
  const header: PreparedHeader = { source, unit, atomsPlaced: particles, heavyPlaced: objects.reduce((s, o) => s + o.heavy, 0), atomsPerSphere: g, spheres: at, spheresPlaced: at, ops: 1, objects }
  // 都只有一份，共用一个单位变换 / each is a single copy, sharing one identity transform
  return { header, spheres, ops: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]) }
}
