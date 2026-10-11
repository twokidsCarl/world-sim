import bdna from '../../data/bdna.json'
import { El, IDENTITY, type Chain, type Molecule } from '../mol/types'
import type { Occupied } from './pack'

/**
 * 程序生成的 DNA 双螺旋。每个碱基对的原子位置量自晶体结构 1BNA（data/bdna.json），
 * 沿一条曲线一对对摆出来。螺旋参数用溶液中 B 型 DNA 的通用值：每对上升 3.4 Å，每圈约 10.5 对。
 * 序列是随机的：画的是“一段 DNA 有多粗、多长、怎么弯”，不是某个基因。
 *
 * Generated DNA double helix. The atoms of each base pair were measured from the crystal
 * structure 1BNA (data/bdna.json) and are laid along a curve pair by pair. The helix follows
 * the usual figures for B-DNA in solution: a rise of 3.4 Å per pair and about 10.5 pairs per
 * turn. The sequence is random: what is drawn is how thick and long a stretch of DNA is and how
 * it bends, not any particular gene.
 */
export const RISE = 3.4
export const TWIST = (2 * Math.PI) / 10.5
/** 双螺旋的半径（到磷原子），用于碰撞检测 / radius of the duplex out to its phosphates, for collision checks */
export const DNA_RADIUS = 10
/** DNA 的持久长度约 50 nm：比这短的一段几乎是直的 / DNA's persistence length is about 50 nm: a stretch shorter than this is nearly straight */
const PERSISTENCE = 500

type V3 = [number, number, number]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** 一条 DNA 的走向：每个碱基对的位置和切向 / the course of one DNA: position and tangent of every base pair */
export interface Strand {
  points: V3[]
  tangents: V3[]
}

/**
 * 从 `start` 出发、朝 `dir` 走的一条随机弯曲的路径（蠕虫链），每步一个碱基对，
 * 走出 `inside` 或撞上已有的东西就停。
 * A randomly bending path (a worm-like chain) from `start` heading along `dir`, one base pair
 * per step, stopping when it leaves `inside` or runs into something already placed.
 */
export function wander(start: V3, dir: V3, maxPairs: number, rand: () => number, inside: (p: V3) => boolean, occ?: Occupied): Strand {
  const points: V3[] = [], tangents: V3[] = []
  let p = start, t = unit(dir)
  // 每步的偏转角方差是 2·步长/持久长度，分给两个垂直方向，各占一半
  // the deflection per step has variance 2 x step / persistence length, shared equally between the two perpendicular directions
  const sd = Math.sqrt(RISE / PERSISTENCE)
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())
  for (let k = 0; k < maxPairs; k++) {
    if (!inside(p)) break
    if (occ && k % 4 === 0 && occ.hits(p[0], p[1], p[2], DNA_RADIUS)) break
    points.push(p)
    tangents.push(t)
    const a: V3 = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const u = unit(cross(t, a)), v = cross(t, u)
    const du = gauss() * sd, dv = gauss() * sd
    t = unit([t[0] + u[0] * du + v[0] * dv, t[1] + u[1] * du + v[1] * dv, t[2] + u[2] * du + v[2] * dv])
    p = [p[0] + t[0] * RISE, p[1] + t[1] * RISE, p[2] + t[2] * RISE]
  }
  return { points, tangents }
}

/** 沿若干条路径的 DNA，作为一个分子：四种碱基对是四条“链”，每条路径是一个组装体 / DNA along several paths as one molecule: the four kinds of base pair are four "chains", and each path is an assembly */
export function dnaAlong(strands: Strand[], rand: () => number): Molecule {
  const pos: number[] = [], element: number[] = [], isTrace: number[] = [], residue: number[] = [], chainOf: number[] = []
  const chains: Chain[] = []
  bdna.pairs.forEach((pair, ci) => {
    const start = pos.length / 3
    for (const [el, x, y, z, p] of pair.atoms as [string, number, number, number, number][]) {
      pos.push(x, y, z)
      element.push(el === 'C' ? El.C : el === 'N' ? El.N : el === 'O' ? El.O : el === 'P' ? El.P : El.Other)
      isTrace.push(p)
      residue.push(1)
      chainOf.push(ci)
    }
    chains.push({ asymId: pair.pair, authAsymId: pair.pair, entity: 0, start, count: pos.length / 3 - start, model: 1 })
  })
  const assemblies = strands.map((s, si) => {
    const ops: Float32Array[][] = chains.map(() => [])
    // 法向沿路径平行移动，再叠加每对一步的扭转 / the normal is carried along the path by parallel transport, with one step of twist added per pair
    let n: V3 = unit(cross(s.tangents[0] ?? [0, 0, 1], Math.abs((s.tangents[0] ?? [0, 0, 1])[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]))
    s.points.forEach((p, k) => {
      const t = s.tangents[k]!
      const d = dot(n, t)
      n = unit([n[0] - t[0] * d, n[1] - t[1] * d, n[2] - t[2] * d])
      const b = cross(t, n)
      const c = Math.cos(k * TWIST), sn = Math.sin(k * TWIST)
      const x: V3 = [n[0] * c + b[0] * sn, n[1] * c + b[1] * sn, n[2] * c + b[2] * sn]
      const y = cross(t, x)
      ops[Math.floor(rand() * chains.length) % chains.length]!.push(new Float32Array([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, t[0], t[1], t[2], 0, p[0], p[1], p[2], 1]))
    })
    return { id: 's' + si, groups: ops.map((operators, ci) => ({ chains: [ci], operators })).filter((g) => g.operators.length > 0) }
  })
  const n = pos.length / 3
  return {
    id: 'DNA',
    title: 'B-DNA (generated)',
    atomCount: n,
    pos: new Float32Array(pos),
    element: new Uint8Array(element),
    chainOf: new Uint32Array(chainOf),
    isTrace: new Uint8Array(isTrace),
    residue: new Int32Array(residue),
    chains,
    entities: [{ id: '1', description: 'DNA', kind: 'dna' }],
    assemblies: [{ id: 'asym', groups: [{ chains: chains.map((_, i) => i), operators: [IDENTITY] }] }, ...assemblies],
  }
}

/** 把一条路径记进占位网格，之后放的分子会避开它 / record a path in the occupancy grid so that molecules placed later keep clear of it */
export function occupyStrand(occ: Occupied, s: Strand): void {
  for (let k = 0; k < s.points.length; k += 4) occ.add(s.points[k]![0], s.points[k]![1], s.points[k]![2], DNA_RADIUS)
}
