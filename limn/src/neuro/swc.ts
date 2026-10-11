import { El, IDENTITY, type Chain, type Entity, type Molecule } from '../mol/types'

/**
 * SWC：神经元形态重建的通用格式。每行一个节点：编号、类型、x、y、z、半径、父节点编号；坐标单位是微米。
 * SWC, the common format for neuron reconstructions. One node per line: id, type, x, y, z, radius,
 * parent id; coordinates are in microns.
 */
export interface SwcNode {
  id: number
  /** 1 胞体，2 轴突，3 基树突，4 顶树突，其余按“其他”/ 1 soma, 2 axon, 3 basal dendrite, 4 apical dendrite, anything else "other" */
  type: number
  x: number
  y: number
  z: number
  r: number
  parent: number
}

export function parseSwc(text: string): SwcNode[] {
  const out: SwcNode[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const f = t.split(/\s+/).map(Number)
    if (f.length < 7 || !f.slice(0, 7).every(Number.isFinite)) continue
    out.push({ id: f[0]!, type: f[1]!, x: f[2]!, y: f[3]!, z: f[4]!, r: f[5]!, parent: f[6]! })
  }
  return out
}

const KINDS: { type: number; name: string; nameEn: string }[] = [
  { type: 1, name: '胞体', nameEn: 'soma' },
  { type: 2, name: '轴突', nameEn: 'axon' },
  { type: 3, name: '树突（基树突）', nameEn: 'dendrite (basal)' },
  { type: 4, name: '顶树突', nameEn: 'apical dendrite' },
  { type: 0, name: '其他', nameEn: 'other' },
]

/** 分支再细，也按这个半径画（微米）；重建里常有半径为 0 的节点 / however thin a branch, it is drawn at least this wide (microns); reconstructions often carry nodes of radius 0 */
const MIN_RADIUS = 0.08

/**
 * 把重建变成一串串紧挨着的球：每一段（节点到它的父节点）按半径线性过渡，球心间距是半径的三分之一，
 * 所以轮廓上的起伏不到半径的 2%。每种类型（胞体、轴突、树突…）是一条“链”。坐标单位仍是微米。
 * 三点式胞体（一个中心点加两个偏开一个半径的点，是 SWC 里表示球形胞体的约定）只画中心那一个球。
 *
 * Turn a reconstruction into runs of closely spaced spheres: each segment (a node to its parent)
 * tapers linearly, with centres a third of a radius apart, so the outline ripples by less than 2%
 * of the radius. Each type (soma, axon, dendrite...) is one "chain". Coordinates stay in microns.
 * A three-point soma (a centre plus two points one radius away, the SWC convention for a round
 * soma) is drawn as the centre sphere alone.
 */
export function neuronMolecule(nodes: SwcNode[], id: string, title: string, maxSpheres = 2_000_000): Molecule {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const soma = nodes.filter((n) => n.type === 1)
  const threePoint = soma.length === 3 && soma[1]!.parent === soma[0]!.id && soma[2]!.parent === soma[0]!.id
  const kindOf = (t: number) => (KINDS.some((k) => k.type === t) ? t : 0)

  // 先数一遍要多少个球，太多就把间距放大 / count the spheres first, and widen the spacing if there are too many
  const segments: { a: SwcNode; b: SwcNode; len: number }[] = []
  let wanted = 0
  for (const n of nodes) {
    const p = byId.get(n.parent)
    if (!p || (threePoint && n.type === 1)) continue
    const len = Math.hypot(n.x - p.x, n.y - p.y, n.z - p.z)
    segments.push({ a: p, b: n, len })
    wanted += len / (Math.max(MIN_RADIUS, Math.min(n.r, p.r)) / 3)
  }
  const stretch = Math.max(1, wanted / maxSpheres)

  const per = new Map<number, number[]>() // type -> x, y, z, r ...
  const push = (t: number, x: number, y: number, z: number, r: number) => {
    const k = kindOf(t)
    if (!per.has(k)) per.set(k, [])
    per.get(k)!.push(x, y, z, Math.max(MIN_RADIUS, r))
  }
  for (const n of nodes) {
    if (threePoint && n.type === 1 && n !== soma[0]) continue
    push(n.type, n.x, n.y, n.z, n.r)
  }
  for (const { a, b, len } of segments) {
    // 一段的类型取子节点的；从胞体伸出的第一段因此算作树突或轴突 / a segment takes its child's type, so the first stretch out of the soma counts as dendrite or axon
    const ra = Math.max(MIN_RADIUS, a.type === 1 && b.type !== 1 ? b.r : a.r), rb = Math.max(MIN_RADIUS, b.r)
    const step = (Math.min(ra, rb) / 3) * stretch
    const steps = Math.floor(len / step)
    for (let k = 1; k < steps; k++) {
      const t = k / steps
      push(b.type, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t, ra + (rb - ra) * t)
    }
  }

  const pos: number[] = [], radius: number[] = []
  const chains: Chain[] = [], entities: Entity[] = []
  for (const k of KINDS) {
    const d = per.get(k.type)
    if (!d || d.length === 0) continue
    const start = pos.length / 3
    for (let i = 0; i < d.length; i += 4) {
      pos.push(d[i]!, d[i + 1]!, d[i + 2]!)
      radius.push(d[i + 3]!)
    }
    entities.push({ id: String(k.type), description: `${k.name} / ${k.nameEn}`, kind: 'protein' })
    chains.push({ asymId: k.nameEn, authAsymId: k.nameEn, entity: entities.length - 1, start, count: pos.length / 3 - start, model: 1 })
  }
  const n = pos.length / 3
  if (n === 0) throw new Error(`${id} 里没有读到节点`)
  const chainOf = new Uint32Array(n)
  chains.forEach((c, i) => chainOf.fill(i, c.start, c.start + c.count))
  return {
    id,
    title,
    atomCount: n,
    pos: new Float32Array(pos),
    // 球没有元素；按“非碳”处理，一种类型一个颜色 / spheres have no element; treated as non-carbon so each type is one colour
    element: new Uint8Array(n).fill(El.N),
    radius: new Float32Array(radius),
    chainOf,
    isTrace: new Uint8Array(n),
    residue: new Int32Array(n).fill(1),
    chains,
    entities,
    assemblies: [{ id: 'asym', groups: [{ chains: chains.map((_, i) => i), operators: [IDENTITY] }] }],
  }
}

/** NeuroMorpho.Org 上一个重建的 SWC 地址 / where NeuroMorpho.Org keeps a reconstruction's SWC file */
export function neuromorphoUrl(archive: string, name: string): string {
  return `https://neuromorpho.org/dableFiles/${encodeURIComponent(archive.toLowerCase())}/CNG%20version/${encodeURIComponent(name)}.CNG.swc`
}
