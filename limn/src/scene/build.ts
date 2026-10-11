import type { Molecule } from '../mol/types'
import type { Draw, RenderItem } from '../render/Renderer'
import { atomColors, atomRadii, type Coloring } from '../style/assign'
import type { Tone } from '../style/palettes'

/** 残基编号可以为负；而 id 缓冲是无符号的 / Residue numbers can be negative; the id buffer is unsigned. */
const RESIDUE_OFFSET = 100_000

export interface Placement {
  /** 画该分子的哪个组装体 / which assembly of the molecule to draw */
  assembly: string
  /** 在组装体算符之后额外施加的变换（列主序 4x4） / extra transform applied after the assembly operators (column-major 4x4) */
  matrix?: Float32Array
  molecule: number
  /** 分子中心的世界坐标，用于景深层 / world position of the molecule's centre, for depth layers */
  center?: [number, number, number]
  /**
   * 介观模型：组装体里的每个拷贝本身就是一个分子，各自描边、各自归入景深层。
   * 脂质例外，整张膜共用一个编号，画成一片。
   * Mesoscale models: every copy in the assembly is a molecule of its own, outlined and
   * depth-layered separately. Lipids are the exception: the whole membrane shares one id
   * and reads as one sheet.
   */
  perCopy?: boolean
  /**
   * 名字匹配的实体不逐个描边（例如小泡里的几千个谷氨酸）。
   * Entities whose name matches are not outlined one by one (the thousands of glutamates in a vesicle, say).
   */
  merge?: RegExp
}

/** 一段原子在一个算符下的一份拷贝 / one run of atoms under one operator */
export interface Copy {
  start: number
  count: number
  /** 列主序 4x4 / column-major 4x4 */
  matrix: Float32Array
}

interface Group {
  runs: { start: number; count: number }[]
  operators: Float32Array[]
  lipid: boolean
  /**
   * 介观模型里不单独描边的东西：纤维的一节节片段、小分子。同一组的所有拷贝共用一个分子编号。
   * Things a mesoscale picture does not outline one by one: the segments of a fibre, small
   * molecules. All copies of such a group share one molecule id.
   */
  merged: boolean
}

/**
 * 组装体按“画哪几段原子”归并：链相同的行合在一起，算符接起来。
 * An assembly grouped by which atoms are drawn: rows listing the same chains are merged
 * and their operators concatenated.
 */
function assemblyGroups(mol: Molecule, assembly: string, merge?: RegExp): Group[] {
  const asm = mol.assemblies.find((a) => a.id === assembly) ?? mol.assemblies[0]!
  const byKey = new Map<string, Group>()
  const isLipid = (ci: number) => mol.entities[mol.chains[ci]!.entity]!.kind === 'lipid'
  // 脂质和其余的链分开成组：膜要画成一整片 / lipids are grouped apart from other chains: a membrane is drawn as one sheet
  const split = asm.groups.flatMap((g) => {
    const lipids = g.chains.filter(isLipid)
    if (lipids.length === 0) return [g]
    // 膜的每一小块常常挑不同的几种脂质；按单条链拆开，相同的链才能合并成一次绘制
    // each patch of a membrane often picks a different handful of lipids; splitting by single
    // chain lets identical chains merge into one draw
    const each = lipids.map((ci) => ({ ...g, chains: [ci] }))
    return lipids.length === g.chains.length ? each : [{ ...g, chains: g.chains.filter((ci) => !isLipid(ci)) }, ...each]
  })
  for (const g of split) {
    // 在缓冲里相邻的链共用一次绘制调用。
    // Chains that sit next to each other in the buffer share a draw call.
    const sorted = g.chains.slice().sort((a, b) => mol.chains[a]!.start - mol.chains[b]!.start)
    const runs: { start: number; count: number }[] = []
    for (const ci of sorted) {
      const c = mol.chains[ci]!
      const last = runs[runs.length - 1]
      if (last && last.start + last.count === c.start) last.count += c.count
      else runs.push({ start: c.start, count: c.count })
    }
    const key = runs.map((r) => r.start + ':' + r.count).join(',')
    const have = byKey.get(key)
    if (have) have.operators.push(...g.operators)
    else
      byKey.set(key, {
        runs, operators: g.operators.slice(), lipid: g.chains.every(isLipid),
        merged: g.chains.every((ci) => mol.chains[ci]!.count < 40) || g.chains.some((ci) => /\.fibers?\./i.test(mol.entities[mol.chains[ci]!.entity]!.description) || !!merge?.test(mol.entities[mol.chains[ci]!.entity]!.description)),
      })
  }
  return [...byKey.values()]
}

/** 把解析后的结构变成可直接上 GPU 的缓冲和它的绘制列表 / Turn a parsed structure into GPU-ready buffers and its draw list. */
export function buildItem(mol: Molecule, coloring: Coloring, tone: Tone, place: Placement | Placement[]): RenderItem {
  const radii = atomRadii(mol)
  const posr = new Float32Array(mol.atomCount * 4)
  const ids = new Uint32Array(mol.atomCount * 2)
  for (let i = 0; i < mol.atomCount; i++) {
    posr[i * 4] = mol.pos[i * 3]!
    posr[i * 4 + 1] = mol.pos[i * 3 + 1]!
    posr[i * 4 + 2] = mol.pos[i * 3 + 2]!
    posr[i * 4 + 3] = radii[i]!
    ids[i * 2] = mol.chainOf[i]!
    ids[i * 2 + 1] = mol.residue[i]! + RESIDUE_OFFSET
  }
  const places = Array.isArray(place) ? place : [place]
  const draws: Draw[] = []
  const byAssembly = new Map<string, Placement[]>()
  for (const p of places) byAssembly.set(p.assembly, [...(byAssembly.get(p.assembly) ?? []), p])
  let total = 0
  const plan: { g: Group; ps: Placement[] }[] = []
  for (const [assembly, ps] of byAssembly)
    for (const g of assemblyGroups(mol, assembly, ps[0]!.merge)) {
      plan.push({ g, ps })
      total += g.operators.length * ps.length
    }
  const data = new Float32Array(total * 16), iids = new Uint32Array(total * 2)
  let o = 0, copy = 0
  for (const { g, ps } of plan) {
    const first = o
    const groupCopy = copy
    // 这一组原子的质心，用来给每个拷贝一个中心 / centroid of the group's atoms, giving each copy a centre
    const c = [0, 0, 0]
    if (ps.some((p) => p.perCopy)) {
      let n = 0
      for (const r of g.runs) {
        const step = Math.max(1, Math.floor(r.count / 200))
        for (let i = r.start; i < r.start + r.count; i += step) {
          c[0]! += mol.pos[i * 3]!
          c[1]! += mol.pos[i * 3 + 1]!
          c[2]! += mol.pos[i * 3 + 2]!
          n++
        }
      }
      for (let k = 0; k < 3; k++) c[k]! /= Math.max(1, n)
    }
    for (const p of ps)
      for (const op of g.operators) {
        const m = p.matrix ? mul(p.matrix, op) : op
        const k = o * 16
        for (let r = 0; r < 3; r++) for (let col = 0; col < 4; col++) data[k + r * 4 + col] = m[col * 4 + r]!
        const centre = p.center ?? (p.perCopy ? ([m[0]! * c[0]! + m[4]! * c[1]! + m[8]! * c[2]! + m[12]!, m[1]! * c[0]! + m[5]! * c[1]! + m[9]! * c[2]! + m[13]!, m[2]! * c[0]! + m[6]! * c[1]! + m[10]! * c[2]! + m[14]!] as const) : null)
        if (centre) {
          data[k + 12] = centre[0]
          data[k + 13] = centre[1]
          data[k + 14] = centre[2]
          // 2 = 纤维的片段：细，需要画得更粗才看得见 / 2 = a fibre segment: thin, drawn fatter to stay visible
          data[k + 15] = p.perCopy && g.merged && !g.lipid ? 2 : 1
        }
        iids[o * 2] = copy * mol.chains.length
        iids[o * 2 + 1] = !p.perCopy || g.lipid ? p.molecule : p.molecule + 1 + (g.merged ? groupCopy : copy)
        o++
        copy++
      }
    for (const r of g.runs) draws.push({ ...r, opStart: first, opCount: o - first })
  }
  return { posr, color: atomColors(mol, coloring, tone), ids, draws, instances: { count: total, data, ids: iids }, subunitSize: subunitSize(mol) }
}

/**
 * 组装体展开后的每一份拷贝（做几何计算用；渲染不走这里）。
 * Every copy of an expanded assembly, for geometry; rendering does not go through this.
 */
export function assemblyCopies(mol: Molecule, assembly: string): Copy[] {
  const out: Copy[] = []
  for (const g of assemblyGroups(mol, assembly)) for (const matrix of g.operators) for (const r of g.runs) out.push({ ...r, matrix })
  return out
}

function mul(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!
      o[c * 4 + r] = s
    }
  return o
}

/** 所有算符都施加之后实际画出的原子数 / Atoms actually drawn once every operator is applied. */
export function placedAtomCount(mol: Molecule, assembly: string): number {
  let n = 0
  for (const g of assemblyGroups(mol, assembly)) for (const r of g.runs) n += r.count * g.operators.length
  return n
}

/** 默认显示的组装体：第一个生物学组装体，只要它不是特别大 / The assembly to show by default: the first biological one, if it is not enormous. */
export function defaultAssembly(mol: Molecule): string {
  return (mol.assemblies[1] ?? mol.assemblies[0]!).id
}

/**
 * 链的典型直径（Å），取自中位原子所属的那条链。含 n 个重原子的紧凑链直径约为
 * 3.3 n^(1/3) Å（1,100 个原子的珠蛋白约 34 Å）。
 * Typical chain diameter in Å, from the chain that the median atom belongs
 * to. A compact chain of n heavy atoms is about 3.3 n^(1/3) Å across
 * (a 1,100-atom globin is about 34 Å).
 */
export function subunitSize(mol: Molecule): number {
  const counts = mol.chains.map((c) => c.count).sort((a, b) => a - b)
  let seen = 0
  for (const n of counts) {
    seen += n
    if (seen * 2 >= mol.atomCount) return 3.3 * Math.cbrt(n)
  }
  return 30
}
