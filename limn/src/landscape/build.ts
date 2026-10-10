import type { Molecule } from '../mol/types'
import { El } from '../mol/types'
import { axisAngle, mul3 } from '../render/camera'
import { principalFrame } from '../refine/views'
import { assemblyDraws } from '../scene/build'
import type { LandscapeSpec } from '../scene/spec'
import { coarsen, collides, Occupied, placement, randomRotation, rng, scatter, type Coarse, type Region } from './pack'

/** Half the thickness of the bilayer between its head-group planes, Å. */
const MEMBRANE_HALF = 20
/** Molecules are placed a little beyond the frame so its edges are filled. */
const OVERHANG = 40

/** Atom centres of a molecule's assembly, thinned for speed. */
function assemblyPoints(mol: Molecule, assembly: string): Float32Array {
  const draws = assemblyDraws(mol, { assembly, molecule: 0 })
  const total = draws.reduce((s, d) => s + d.count, 0)
  const step = Math.max(1, Math.floor(total / 60_000))
  const out: number[] = []
  for (const d of draws) {
    const m = d.matrix
    for (let i = d.start; i < d.start + d.count; i += step) {
      const x = mol.pos[i * 3]!, y = mol.pos[i * 3 + 1]!, z = mol.pos[i * 3 + 2]!
      out.push(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!)
    }
  }
  return new Float32Array(out)
}

/** Rotation (column-major 3x3) that stands the molecule's long axis along y. */
function upright(c: Coarse): Float32Array {
  return principalFrame({ center: [0, 0, 0], radius: c.radius, spheres: c.spheres, subunitSize: 30 })
}

export interface Packed {
  /** per panel: one column-major 4x4 per placed copy */
  places: Float32Array[][]
  lipids: Float32Array[]
  /** per panel: copies asked for and copies that fitted */
  wanted: number[]
  /** per panel: the molecule's own centre, which each placement moves into the scene */
  centers: [number, number, number][]
}

/** Where a placement puts a molecule's centre. */
export function placedCenter(m: Float32Array, c: [number, number, number]): [number, number, number] {
  return [m[0]! * c[0] + m[4]! * c[1] + m[8]! * c[2] + m[12]!, m[1]! * c[0] + m[5]! * c[1] + m[9]! * c[2] + m[13]!, m[2]! * c[0] + m[6]! * c[1] + m[10]! * c[2] + m[14]!]
}

export interface PackInput {
  mol: Molecule
  assembly: string
}

/**
 * Mean position of one end of the protein chains in an assembly: the first
 * (N) or last (C) few backbone atoms of every chain. For a symmetric
 * oligomer whose chains run side by side this marks one end of the molecule.
 */
export function terminusPoint(mol: Molecule, assembly: string, which: 'N' | 'C'): [number, number, number] | null {
  const draws = assemblyDraws(mol, { assembly, molecule: 0 })
  const sum = [0, 0, 0]
  let n = 0
  for (const d of draws) {
    const m = d.matrix
    for (const ch of mol.chains) {
      if (mol.entities[ch.entity]!.kind !== 'protein' || ch.start < d.start || ch.start >= d.start + d.count) continue
      const trace: number[] = []
      for (let i = ch.start; i < ch.start + ch.count; i++) if (mol.isTrace[i]) trace.push(i)
      if (trace.length < 30) continue
      for (const i of which === 'N' ? trace.slice(0, 6) : trace.slice(-6)) {
        const x = mol.pos[i * 3]!, y = mol.pos[i * 3 + 1]!, z = mol.pos[i * 3 + 2]!
        sum[0]! += m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
        sum[1]! += m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
        sum[2]! += m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
        n++
      }
    }
  }
  return n ? [sum[0]! / n, sum[1]! / n, sum[2]! / n] : null
}

/**
 * Lay out the scene. The slab spans x in ±width/2, y in ±height/2 and z from
 * -depth (far) to 0 (the cut face nearest the viewer). A membrane, if any,
 * lies in the y = 0 plane.
 */
export function packScene(inputs: PackInput[], spec: LandscapeSpec, lipid: Molecule | null, seed: number): Packed {
  const rand = rng(seed)
  const occ = new Occupied()
  const coarse = inputs.map((p) => coarsen(assemblyPoints(p.mol, p.assembly)))
  const places: Float32Array[][] = inputs.map(() => [])
  const wanted = inputs.map(() => 0)
  const W = spec.width / 2 + OVERHANG, H = spec.height / 2 + OVERHANG
  // keep whole molecules behind the cut face, so nothing is sliced
  const zRange = (c: Coarse): [number, number] => {
    const front = -Math.min(c.radius * 0.75, spec.depth * 0.5)
    return [Math.min(-spec.depth, front - 10), front]
  }
  const bySize = (a: number, b: number) => coarse[spec.ingredients[b]!.panel]!.radius - coarse[spec.ingredients[a]!.panel]!.radius
  const order = spec.ingredients.map((_, i) => i)

  // 1. membrane proteins, standing in the membrane plane
  const lipids: Float32Array[] = []
  if (spec.membrane) {
    for (const i of order.filter((i) => spec.ingredients[i]!.compartment === 'membrane').sort(bySize)) {
      const ing = spec.ingredients[i]!, c = coarse[ing.panel]!
      let base = upright(c)
      let y = 0
      if (ing.anchor === 'above' || ing.anchor === 'below') {
        const side = ing.anchor === 'above' ? 1 : -1
        // turn the end of the chain that joins the membrane towards it
        const end = ing.terminus ? terminusPoint(inputs[ing.panel]!.mol, inputs[ing.panel]!.assembly, ing.terminus) : null
        if (end) {
          const d = [end[0] - c.center[0], end[1] - c.center[1], end[2] - c.center[2]]
          const endY = base[1]! * d[0]! + base[4]! * d[1]! + base[7]! * d[2]!
          if (endY * side > 0) base = mul3(axisAngle(1, 0, 0, Math.PI), base)
        }
        // stand it on the membrane face: its lowest point (towards the membrane) just touching
        let reach = 0
        for (let k = 0; k < c.spheres.length; k += 4) {
          const sy = base[1]! * c.spheres[k]! + base[4]! * c.spheres[k + 1]! + base[7]! * c.spheres[k + 2]!
          reach = Math.max(reach, -sy * side + c.spheres[k + 3]! * 0.5)
        }
        y = side * (MEMBRANE_HALF + reach)
      }
      const stand = base
      const [z0, z1] = zRange(c)
      wanted[ing.panel] = ing.copies
      places[ing.panel] = scatter(occ, c, ing.copies, { min: [-W, y, z0], max: [W, y, z1] }, rand, (r) => mul3(axisAngle(0, 1, 0, r() * 2 * Math.PI), stand), 200)
    }

    // 2. the bilayer: lipids on a jittered grid in two leaflets, skipping protein
    if (lipid) {
      const lc = coarsen(lipid.pos, 7)
      const stand = upright(lc)
      // which way is the head group? the phosphorus atom marks it
      let headY = 0, lo = Infinity, hi = -Infinity
      for (let a = 0; a < lipid.atomCount; a++) {
        const dx = lipid.pos[a * 3]! - lc.center[0], dy = lipid.pos[a * 3 + 1]! - lc.center[1], dz = lipid.pos[a * 3 + 2]! - lc.center[2]
        const y = stand[1]! * dx + stand[4]! * dy + stand[7]! * dz
        lo = Math.min(lo, y)
        hi = Math.max(hi, y)
        if (lipid.element[a] === El.P) headY = y
      }
      const headUp = headY >= 0 ? stand : mul3(axisAngle(1, 0, 0, Math.PI), stand)
      const headDown = mul3(axisAngle(1, 0, 0, Math.PI), headUp)
      const half = (hi - lo) / 2
      // tails meet at the middle of the membrane
      const offset = Math.min(half, MEMBRANE_HALF) * 0.92
      const pitch = 8.4 // about 70 Å² per lipid
      for (const [dir, y] of [[headUp, offset], [headDown, -offset]] as const) {
        for (let x = -W; x <= W; x += pitch) {
          for (let z = -spec.depth - 10; z <= -4; z += pitch) {
            const pos: [number, number, number] = [x + (rand() - 0.5) * 3, y + (rand() - 0.5) * 2.5, z + (rand() - 0.5) * 3]
            const rot = mul3(axisAngle(0, 1, 0, rand() * 2 * Math.PI), dir)
            if (collides(occ, lc, rot, pos, 2.5)) continue
            lipids.push(placement(rot, pos, lc.center))
          }
        }
      }
      // lipids do not exclude one another (the grid already spaces them),
      // but everything placed later must stay out of the bilayer
      for (let x = -W; x <= W; x += 14) for (let z = -spec.depth - 10; z <= 0; z += 14) for (const y of [-14, 0, 14]) occ.add(x, y, z, 11)
    }
  }

  // 3. soluble molecules. The featured ones go first, in the foreground and
  // away from the edges, so that the subject of the picture is whole and in
  // view; then the rest, largest first, so the small ones fill the gaps.
  const soluble = order.filter((i) => !spec.membrane || spec.ingredients[i]!.compartment !== 'membrane')
  const sideOf = (ing: LandscapeSpec['ingredients'][number], c: Coarse, x: number, y: number, z0: number, z1: number): Region => {
    if (!spec.membrane) return { min: [-x, -y, z0], max: [x, y, z1] }
    const clear = MEMBRANE_HALF + Math.min(c.radius, 30) * 0.5
    return ing.compartment === 'above' ? { min: [-x, clear, z0], max: [x, Math.max(clear, y), z1] } : { min: [-x, -Math.max(clear, y), z0], max: [x, -clear, z1] }
  }
  for (const i of soluble.filter((i) => spec.ingredients[i]!.feature).sort(bySize)) {
    const ing = spec.ingredients[i]!, c = coarse[ing.panel]!
    const [, z1] = zRange(c)
    const inX = Math.max(0, spec.width / 2 - c.radius - 10) * 0.8, inY = Math.max(0, spec.height / 2 - c.radius - 10) * 0.8
    wanted[ing.panel] = ing.copies
    const front = scatter(occ, c, Math.min(ing.copies, 2), sideOf(ing, c, inX, inY, z1 - 30, z1), rand, randomRotation, 200)
    const [z0] = zRange(c)
    places[ing.panel] = [...front, ...scatter(occ, c, ing.copies - front.length, sideOf(ing, c, W, H, z0, z1), rand, randomRotation, 80)]
  }
  for (const i of soluble.filter((i) => !spec.ingredients[i]!.feature).sort(bySize)) {
    const ing = spec.ingredients[i]!, c = coarse[ing.panel]!
    const [z0, z1] = zRange(c)
    wanted[ing.panel] = ing.copies
    places[ing.panel] = scatter(occ, c, ing.copies, sideOf(ing, c, W, H, z0, z1), rand, randomRotation, 80)
  }
  return { places, lipids, wanted, centers: coarse.map((c) => c.center) }
}
