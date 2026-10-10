import type { Molecule } from '../mol/types'
import type { Draw, RenderItem } from '../render/Renderer'
import { atomColors, atomRadii, type Coloring } from '../style/assign'
import type { Tone } from '../style/palettes'

/** Residue numbers can be negative; the id buffer is unsigned. */
const RESIDUE_OFFSET = 100_000

export interface Placement {
  /** which assembly of the molecule to draw */
  assembly: string
  /** extra transform applied after the assembly operators (column-major 4x4) */
  matrix?: Float32Array
  molecule: number
}

/** Turn a parsed structure into GPU-ready buffers and its draw list. */
export function buildItem(mol: Molecule, coloring: Coloring, tone: Tone, place: Placement): RenderItem {
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
  return { posr, color: atomColors(mol, coloring, tone), ids, draws: assemblyDraws(mol, place), subunitSize: subunitSize(mol) }
}

export function assemblyDraws(mol: Molecule, place: Placement): Draw[] {
  const asm = mol.assemblies.find((a) => a.id === place.assembly) ?? mol.assemblies[0]!
  const draws: Draw[] = []
  let copy = 0
  for (const g of asm.groups) {
    // Chains that sit next to each other in the buffer share a draw call.
    const sorted = g.chains.slice().sort((a, b) => mol.chains[a]!.start - mol.chains[b]!.start)
    const runs: { start: number; count: number }[] = []
    for (const ci of sorted) {
      const c = mol.chains[ci]!
      const last = runs[runs.length - 1]
      if (last && last.start + last.count === c.start) last.count += c.count
      else runs.push({ start: c.start, count: c.count })
    }
    for (const op of g.operators) {
      const matrix = place.matrix ? mul(place.matrix, op) : op
      for (const r of runs) draws.push({ ...r, matrix, subunitBase: copy * mol.chains.length, molecule: place.molecule })
      copy++
    }
  }
  return draws
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

/** Atoms actually drawn once every operator is applied. */
export function placedAtomCount(mol: Molecule, assembly: string): number {
  return assemblyDraws(mol, { assembly, molecule: 0 }).reduce((s, d) => s + d.count, 0)
}

/** The assembly to show by default: the first biological one, if it is not enormous. */
export function defaultAssembly(mol: Molecule): string {
  return (mol.assemblies[1] ?? mol.assemblies[0]!).id
}

/**
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
