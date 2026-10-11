import type { Molecule } from '../mol/types'
import { El } from '../mol/types'
import { axisAngle, mul3 } from '../render/camera'
import { principalFrame } from '../refine/views'
import { assemblyCopies } from '../scene/build'
import type { LandscapeSpec } from '../scene/spec'
import { DNA_RADIUS, dnaAlong, occupyStrand, RISE, wander, type Strand } from './fiber'
import type { LipidShare } from './lipid'
import { membraneToScene, type MembraneFit } from './orient'
import { coarsen, collides, Occupied, placement, randomRotation, rng, scatter, type Coarse, type Region } from './pack'

/** 双层膜两个头基平面之间厚度的一半，Å / Half the thickness of the bilayer between its head-group planes, Å. */
const MEMBRANE_HALF = 20
/** 分子放到略超出画幅的位置，让画幅边缘被填满 / Molecules are placed a little beyond the frame so its edges are filled. */
const OVERHANG = 40

/** 分子组装体的原子中心，为了速度做了抽稀 / Atom centres of a molecule's assembly, thinned for speed. */
function assemblyPoints(mol: Molecule, assembly: string): Float32Array {
  const draws = assemblyCopies(mol, assembly)
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

/** 把分子长轴立到 y 方向的旋转（列主序 3x3） / Rotation (column-major 3x3) that stands the molecule's long axis along y. */
function upright(c: Coarse): Float32Array {
  return principalFrame({ center: [0, 0, 0], radius: c.radius, spheres: c.spheres, subunitSize: 30 })
}

export interface Packed {
  /** 每个面板：每个放置的拷贝一个列主序 4x4 / per panel: one column-major 4x4 per placed copy */
  places: Float32Array[][]
  /** 每种脂质和它的各个拷贝的位置 / each kind of lipid and where its copies go */
  lipids: { mol: Molecule; places: Float32Array[] }[]
  /** 每个面板：要求的拷贝数和放得下的拷贝数 / per panel: copies asked for and copies that fitted */
  wanted: number[]
  /** 每个面板：分子自身的中心，每次放置把它移进场景 / per panel: the molecule's own centre, which each placement moves into the scene */
  centers: [number, number, number][]
  /** 生成的 DNA（每条是一个组装体），没有则为 null / generated DNA, one assembly per strand, or null */
  dna: Molecule | null
}

/** 一次放置把分子的中心放到哪里 / Where a placement puts a molecule's centre. */
export function placedCenter(m: Float32Array, c: [number, number, number]): [number, number, number] {
  return [m[0]! * c[0] + m[4]! * c[1] + m[8]! * c[2] + m[12]!, m[1]! * c[0] + m[5]! * c[1] + m[9]! * c[2] + m[13]!, m[2]! * c[0] + m[6]! * c[1] + m[10]! * c[2] + m[14]!]
}

export interface PackInput {
  mol: Molecule
  assembly: string
  /** 实验确定的膜内取向（OPM），有的话 / the experimentally derived orientation in the membrane (OPM), when there is one */
  membrane?: MembraneFit | null
}

/**
 * 组装体里蛋白质链某一端的平均位置：每条链最前（N 端）或最后（C 端）的几个主链原子。
 * 对于各链并排走向的对称寡聚体，这标出了分子的一端。
 * Mean position of one end of the protein chains in an assembly: the first
 * (N) or last (C) few backbone atoms of every chain. For a symmetric
 * oligomer whose chains run side by side this marks one end of the molecule.
 */
export function terminusPoint(mol: Molecule, assembly: string, which: 'N' | 'C'): [number, number, number] | null {
  const draws = assemblyCopies(mol, assembly)
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
 * 排布场景。厚片的 x 在 ±width/2，y 在 ±height/2，z 从 -depth（远）到 0
 * （离观察者最近的切面）。如果有膜，它位于 y = 0 平面。
 * Lay out the scene. The slab spans x in ±width/2, y in ±height/2 and z from
 * -depth (far) to 0 (the cut face nearest the viewer). A membrane, if any,
 * lies in the y = 0 plane.
 */
export function packScene(inputs: PackInput[], spec: LandscapeSpec, lipid: Molecule | { outer: LipidShare[]; inner: LipidShare[] } | null, seed: number): Packed {
  const rand = rng(seed)
  const occ = new Occupied()
  const coarse = inputs.map((p) => coarsen(assemblyPoints(p.mol, p.assembly)))
  const places: Float32Array[][] = inputs.map(() => [])
  const wanted = inputs.map(() => 0)
  const W = spec.width / 2 + OVERHANG, H = spec.height / 2 + OVERHANG
  // 把整个分子都留在切面之后，这样没有东西被切开
  // keep whole molecules behind the cut face, so nothing is sliced
  const zRange = (c: Coarse): [number, number] => {
    const front = -Math.min(c.radius * 0.75, spec.depth * 0.5)
    return [Math.min(-spec.depth, front - 10), front]
  }
  const bySize = (a: number, b: number) => coarse[spec.ingredients[b]!.panel]!.radius - coarse[spec.ingredients[a]!.panel]!.radius
  const order = spec.ingredients.map((_, i) => i)

  // 1. 膜蛋白，立在膜平面上 / 1. membrane proteins, standing in the membrane plane
  const lipids: Packed['lipids'] = []
  // 每个膜蛋白拷贝在膜平面里的位置和大致半径：它正前方的脂质不画，让跨膜的部分露出来
  // where each membrane-protein copy sits in the membrane plane, and roughly how wide it is: lipids
  // straight in front of it are left out, so that the part spanning the membrane shows
  const windows: [number, number, number][] = []
  if (spec.membrane) {
    for (const i of order.filter((i) => spec.ingredients[i]!.compartment === 'membrane').sort(bySize)) {
      const ing = spec.ingredients[i]!, c = coarse[ing.panel]!
      let base = upright(c)
      let y = 0
      const fit = inputs[ing.panel]!.membrane
      if (fit) {
        // 有 OPM 的取向：照它摆。先到膜坐标系，再转到场景里（膜法线沿 y），高度由分子中心在膜坐标系里的 z 决定
        // an OPM orientation exists: follow it. Into the membrane frame, then into the scene (normal
        // along y); the height is where the molecule's centre lies along z in the membrane frame
        const m = fit.matrix, s = membraneToScene(spec.outer ?? 'above')
        base = mul3(s, new Float32Array([m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!]))
        const cz = m[2]! * c.center[0] + m[6]! * c.center[1] + m[10]! * c.center[2] + m[14]!
        y = (spec.outer ?? 'above') === 'above' ? cz : -cz
      } else if (ing.anchor === 'above' || ing.anchor === 'below') {
        const side = ing.anchor === 'above' ? 1 : -1
        // 把链上与膜相接的那一端转向膜
        // turn the end of the chain that joins the membrane towards it
        const end = ing.terminus ? terminusPoint(inputs[ing.panel]!.mol, inputs[ing.panel]!.assembly, ing.terminus) : null
        if (end) {
          const d = [end[0] - c.center[0], end[1] - c.center[1], end[2] - c.center[2]]
          const endY = base[1]! * d[0]! + base[4]! * d[1]! + base[7]! * d[2]!
          if (endY * side > 0) base = mul3(axisAngle(1, 0, 0, Math.PI), base)
        }
        // 把它立在膜面上：最低点（朝膜的方向）刚好接触
        // stand it on the membrane face: its lowest point (towards the membrane) just touching
        let reach = 0
        for (let k = 0; k < c.spheres.length; k += 4) {
          const sy = base[1]! * c.spheres[k]! + base[4]! * c.spheres[k + 1]! + base[7]! * c.spheres[k + 2]!
          reach = Math.max(reach, -sy * side + c.spheres[k + 3]! * 0.5)
        }
        y = side * (MEMBRANE_HALF + reach)
      }
      const stand = base
      const [zBack, z1] = zRange(c)
      // 膜蛋白尽量放在靠近切面的地方，这样跨膜的部分露在前排脂质之外；前排放不下再往后放
      // membrane proteins go near the cut face where they can, so the part that spans the membrane
      // is not hidden behind the front lipids; what does not fit there goes further back
      const z0 = Math.max(zBack, z1 - 50)
      wanted[ing.panel] = ing.copies
      const frontRow = scatter(occ, c, ing.copies, { min: [-W, y, z0], max: [W, y, z1] }, rand, (r) => mul3(axisAngle(0, 1, 0, r() * 2 * Math.PI), base), 120)
      places[ing.panel] = frontRow.length >= ing.copies ? frontRow : [...frontRow, ...scatter(occ, c, ing.copies - frontRow.length, { min: [-W, y, zBack], max: [W, y, z1] }, rand, (r) => mul3(axisAngle(0, 1, 0, r() * 2 * Math.PI), stand), 200)]
      for (const m of places[ing.panel]!) {
        const pc = placedCenter(m, c.center)
        // 只统计靠近膜平面的那部分小球，得到跨膜段的半径 / only the spheres near the membrane plane count, giving the radius of the spanning part
        let r = 0
        for (let k = 0; k < c.spheres.length; k += 4) {
          // 小球的坐标是相对分子中心的 / sphere coordinates are relative to the molecule's centre
          const dx = m[0]! * c.spheres[k]! + m[4]! * c.spheres[k + 1]! + m[8]! * c.spheres[k + 2]!
          const sy = m[1]! * c.spheres[k]! + m[5]! * c.spheres[k + 1]! + m[9]! * c.spheres[k + 2]! + pc[1]
          if (Math.abs(sy) < MEMBRANE_HALF) r = Math.max(r, Math.abs(dx) + c.spheres[k + 3]! * 0.5)
        }
        if (r > 0) windows.push([pc[0], pc[2], r])
      }
    }

    // 2. 双层膜：脂质放在带抖动的网格上，两个小叶各按自己的组成混排，跳过蛋白质
    // 2. the bilayer: lipids on a jittered grid, each leaflet mixed to its own composition, skipping protein
    if (lipid) {
      const set: { outer: LipidShare[]; inner: LipidShare[] } = 'outer' in lipid ? lipid : { outer: [{ cls: 'PC', mol: lipid, fraction: 1, tails: 2 }], inner: [{ cls: 'PC', mol: lipid, fraction: 1, tails: 2 }] }
      // 每种脂质：立起来、头朝上时的朝向，以及头顶和尾端离中心多远
      // per lipid: the orientation that stands it head up, and how far its head and its tail tip are from its centre
      const shapes = new Map<Molecule, { c: Coarse; headUp: Float32Array; headDown: Float32Array; top: number; bottom: number }>()
      for (const sh of [...set.outer, ...set.inner]) {
        const m = sh.mol
        if (shapes.has(m)) continue
        const c = coarsen(m.pos, 7)
        const stand = upright(c)
        // 头基朝哪边？非碳原子（磷、氧、氮）聚在那一端 / which end is the head group? the atoms that are not carbon (P, O, N) gather there
        let polar = 0, np = 0, lo = Infinity, hi = -Infinity
        for (let a = 0; a < m.atomCount; a++) {
          const dx = m.pos[a * 3]! - c.center[0], dy = m.pos[a * 3 + 1]! - c.center[1], dz = m.pos[a * 3 + 2]! - c.center[2]
          const y = stand[1]! * dx + stand[4]! * dy + stand[7]! * dz
          lo = Math.min(lo, y)
          hi = Math.max(hi, y)
          if (m.element[a] !== El.C) {
            polar += y
            np++
          }
        }
        const flip = np > 0 && polar / np < 0
        const headUp = flip ? mul3(axisAngle(1, 0, 0, Math.PI), stand) : stand
        shapes.set(m, { c, headUp, headDown: mul3(axisAngle(1, 0, 0, Math.PI), headUp), top: flip ? -lo : hi, bottom: flip ? -hi : lo })
      }
      const byMol = new Map<Molecule, Float32Array[]>()
      const pitch = 8.4 // 每个双链脂质约 70 Å² / about 70 Å² per two-chained lipid
      const outerUp = (spec.outer ?? 'above') === 'above'
      for (const up of [true, false]) {
        const leaflet = up === outerUp ? set.outer : set.inner
        if (leaflet.length === 0) continue
        const total = leaflet.reduce((s, x) => s + x.fraction, 0) || 1
        // 尾端在膜正中相接；胆固醇这样的短分子把头对齐到比磷脂头基低 6 Å 的地方
        // tail tips meet at mid-membrane; a short molecule such as cholesterol has its head lined up 6 Å below the phospholipid head groups
        const reach = Math.max(...leaflet.filter((x) => x.tails > 0).map((x) => 1 - shapes.get(x.mol)!.bottom + shapes.get(x.mol)!.top), 0) || 24
        for (let z = -spec.depth - 10; z <= -4; z += pitch) {
          for (let x = -W; x <= W; ) {
            let pick = rand() * total, sh = leaflet[0]!
            for (const cand of leaflet) {
              pick -= cand.fraction
              if (pick <= 0) {
                sh = cand
                break
              }
            }
            const g = shapes.get(sh.mol)!
            // 四条、六条尾链的脂质占两格、三格 / a lipid with four or six tails takes two or three sites
            const sites = Math.max(1, Math.round(sh.tails / 2))
            const cx = x + ((sites - 1) * pitch) / 2
            x += sites * pitch
            const centreY = sh.tails > 0 ? 1 - g.bottom : Math.max(1 - g.bottom, reach - 6 - g.top)
            const pos: [number, number, number] = [cx + (rand() - 0.5) * 3, (up ? 1 : -1) * (centreY + (rand() - 0.5) * 2.5), z + (rand() - 0.5) * 3]
            const rot = mul3(axisAngle(0, 1, 0, rand() * 2 * Math.PI), up ? g.headUp : g.headDown)
            if (collides(occ, g.c, rot, pos, 2.5)) continue
            if (windows.some(([wx, wz, wr]) => pos[2] > wz && Math.abs(pos[0] - wx) < wr)) continue
            if (!byMol.has(sh.mol)) byMol.set(sh.mol, [])
            byMol.get(sh.mol)!.push(placement(rot, pos, g.c.center))
          }
        }
      }
      for (const [mol, places] of byMol) lipids.push({ mol, places })
      // 脂质之间互不排斥（网格已经把它们隔开），
      // 但之后放置的一切都必须避开双层膜
      // lipids do not exclude one another (the grid already spaces them),
      // but everything placed later must stay out of the bilayer
      for (let x = -W; x <= W; x += 14) for (let z = -spec.depth - 10; z <= 0; z += 14) for (const y of [-14, 0, 14]) occ.add(x, y, z, 11)
    }
  }

  // 2.5 DNA：在放可溶分子之前铺好，让蛋白去填它周围的空隙。每条从画面一侧进来，大致横穿画面。
  // 2.5 DNA: laid before the soluble molecules, so that proteins fill in around it. Each strand
  // enters from one side of the frame and runs roughly across it.
  const strands: Strand[] = []
  if (spec.dna && spec.dna.length > 0) {
    const yLo = -H, yHi = spec.membrane ? -MEMBRANE_HALF - DNA_RADIUS - 6 : H
    const inside = (p: [number, number, number]) => Math.abs(p[0]) <= W + 20 && p[1] >= yLo - 20 && p[1] <= yHi && p[2] <= -DNA_RADIUS && p[2] >= -spec.depth
    let left = spec.dna.length
    for (let tries = 0; left > 200 && tries < 60; tries++) {
      const fromLeft = rand() < 0.5
      const start: [number, number, number] = [fromLeft ? -W - 10 : W + 10, yLo + rand() * (yHi - yLo), -DNA_RADIUS - 8 - rand() * Math.max(0, spec.depth - 2 * DNA_RADIUS - 16)]
      const dir: [number, number, number] = [fromLeft ? 1 : -1, (rand() - 0.5) * 0.9, (rand() - 0.5) * 0.25]
      const s = wander(start, dir, Math.ceil(left / RISE), rand, inside, occ)
      // 太短的（刚进来就撞上东西）不要 / drop one that is too short (it ran into something at once)
      if (s.points.length * RISE < 150) continue
      occupyStrand(occ, s)
      strands.push(s)
      left -= s.points.length * RISE
    }
  }

  // 3. 可溶性分子。主角先放，放在前景且远离边缘，让画面的主体完整可见；
  // 然后是其余的，从大到小，让小的去填空隙。
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
  return { places, lipids, wanted, centers: coarse.map((c) => c.center), dna: strands.length ? dnaAlong(strands, rand) : null }
}
