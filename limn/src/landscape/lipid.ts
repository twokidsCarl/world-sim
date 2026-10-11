import membranes from '../../data/membranes.json'
import { El, IDENTITY, type Molecule } from '../mol/types'

interface Graph {
  pos: number[]
  element: number[]
  /** 重原子之间的键，邻接表 / bonds between heavy atoms, as adjacency lists */
  bonds: number[][]
}

/** 从 MDL molfile/SDF（V2000）读重原子和它们之间的键 / read heavy atoms and the bonds between them from an MDL molfile/SDF (V2000) */
function readSdf(text: string, id: string): Graph {
  const lines = text.split(/\r?\n/)
  const counts = lines[3] ?? ''
  const n = Number(counts.slice(0, 3)), nb = Number(counts.slice(3, 6))
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${id} 的坐标文件无法解析`)
  const pos: number[] = [], element: number[] = []
  const index = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const l = lines[4 + i] ?? ''
    const sym = l.slice(31, 34).trim()
    if (sym === 'H' || sym === 'D' || !sym) continue
    index.set(i + 1, element.length)
    pos.push(Number(l.slice(0, 10)), Number(l.slice(10, 20)), Number(l.slice(20, 30)))
    element.push(sym === 'C' ? El.C : sym === 'N' ? El.N : sym === 'O' ? El.O : sym === 'S' ? El.S : sym === 'P' ? El.P : El.Other)
  }
  if (element.length === 0) throw new Error(`${id} 没有原子`)
  const bonds: number[][] = element.map(() => [])
  for (let i = 0; i < (Number.isFinite(nb) ? nb : 0); i++) {
    const l = lines[4 + n + i] ?? ''
    const a = index.get(Number(l.slice(0, 3))), b = index.get(Number(l.slice(3, 6)))
    if (a === undefined || b === undefined) continue
    bonds[a]!.push(b)
    bonds[b]!.push(a)
  }
  return { pos, element, bonds }
}

function molecule(g: Graph, id: string): Molecule {
  const count = g.element.length
  return {
    id,
    title: id,
    atomCount: count,
    pos: new Float32Array(g.pos),
    element: new Uint8Array(g.element),
    chainOf: new Uint32Array(count),
    isTrace: new Uint8Array(count),
    residue: new Int32Array(count).fill(1),
    chains: [{ asymId: 'A', authAsymId: 'A', entity: 0, start: 0, count, model: 1 }],
    entities: [{ id: '1', description: 'lipid ' + id, kind: 'lipid' }],
    assemblies: [{ id: 'asym', groups: [{ chains: [0], operators: [IDENTITY] }] }],
  }
}

/** 从 MDL molfile/SDF（V2000）读重原子，作为单链分子 / Read heavy atoms from an MDL molfile/SDF (V2000) as a one-chain molecule. */
export function parseSdf(text: string, id: string): Molecule {
  return molecule(readSdf(text, id), id)
}

type V3 = [number, number, number]
const at = (p: number[], i: number): V3 => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: V3) => Math.hypot(a[0], a[1], a[2])
const unit = (a: V3): V3 => {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** 脂肪链：从末端碳往回走到第一个连着杂原子的碳为止 / an acyl chain: from its terminal carbon back to the first carbon that carries a heteroatom */
interface Tail {
  /** 链的根（连着杂原子的那个碳）/ the root of the chain, the carbon that carries a heteroatom */
  root: number
  tip: number
  /** 根连向分子其余部分的那个原子，转动时以它为支点 / the atom joining the root to the rest of the molecule; the chain turns about it */
  pivot: number
  /** 随链一起转动的全部原子 / every atom that turns with the chain */
  atoms: number[]
}

function findTails(g: Graph): Tail[] {
  const isC = (i: number) => g.element[i] === El.C
  const tails: Tail[] = []
  for (let tip = 0; tip < g.element.length; tip++) {
    if (!isC(tip) || g.bonds[tip]!.length !== 1) continue
    // 沿着碳链往回走 / walk back along the carbon chain
    const path = [tip]
    let prev = -1, cur = tip
    for (;;) {
      if (g.bonds[cur]!.some((n) => !isC(n))) break
      const next = g.bonds[cur]!.filter((n) => n !== prev && isC(n))
      // 遇到分叉（环或支链）就停：这不是一条简单的链 / stop at a branch (a ring or a side chain): this is no simple chain
      if (next.length !== 1) break
      prev = cur
      cur = next[0]!
      path.push(cur)
    }
    if (path.length < 8 || !g.bonds[cur]!.some((n) => !isC(n))) continue
    const root = cur, before = path[path.length - 2]!
    // 支点：根的邻居里不在链上、而且还连着别的原子的那个（酯键的氧，或鞘氨醇骨架的碳）
    // the pivot: the neighbour of the root that is off the chain and leads on to more atoms (the ester oxygen, or a carbon of the sphingoid backbone)
    const pivot = g.bonds[root]!.filter((n) => n !== before && g.bonds[n]!.length > 1).sort((a, b) => g.bonds[b]!.length - g.bonds[a]!.length)[0]
    if (pivot === undefined) continue
    const atoms: number[] = []
    const seen = new Set([pivot])
    const stack = [root]
    while (stack.length) {
      const a = stack.pop()!
      if (seen.has(a)) continue
      seen.add(a)
      atoms.push(a)
      stack.push(...g.bonds[a]!)
    }
    // 如果“随链转动”的部分比分子的一半还大，说明支点选在了环上或走反了 / if what would turn with the chain is more than half the molecule, the pivot sits in a ring or the walk went the wrong way
    if (atoms.length > g.element.length / 2) continue
    tails.push({ root, tip, pivot, atoms })
  }
  return tails
}

/**
 * 把脂质的尾链都转到同一侧。数据库里的“理想构象”是在真空中各自伸直的，两条尾链常常朝相反方向；
 * 膜里的脂质则是头基在一端、尾链并排在另一端。这里把每条尾链连同它的羰基整体绕支点原子转动，
 * 使它指向头基的反方向。所有键长不变，只有支点处的一个键角改变。没有尾链的分子（胆固醇）原样返回。
 *
 * Turn all of a lipid's tails to one side. A database "ideal conformer" is stretched out in a
 * vacuum, often with its two tails pointing opposite ways; in a membrane the head group is at
 * one end and the tails lie side by side at the other. Each tail, carbonyl and all, is rotated
 * rigidly about its pivot atom so that it points away from the head group. Every bond length is
 * unchanged; only one bond angle, at the pivot, changes. A molecule with no tails (cholesterol)
 * is returned as it is.
 */
export function reposeTails(g: Graph): { pos: number[]; tails: number } {
  const tails = findTails(g)
  if (tails.length === 0) return { pos: g.pos, tails: 0 }
  const inTail = new Set(tails.flatMap((t) => t.atoms))
  // 头基：不在任何尾链上的杂原子；支点们的质心是甘油骨架的位置 / the head group: heteroatoms on no tail; the centroid of the pivots marks the glycerol backbone
  const centroid = (ids: number[]): V3 => {
    const c: V3 = [0, 0, 0]
    for (const i of ids) for (let k = 0; k < 3; k++) c[k]! += g.pos[i * 3 + k]! / ids.length
    return c
  }
  const headAtoms = g.element.map((e, i) => (e !== El.C && !inTail.has(i) ? i : -1)).filter((i) => i >= 0)
  const hinge = centroid(tails.map((t) => t.pivot))
  let axis = headAtoms.length ? sub(centroid(headAtoms), hinge) : ([0, 0, 0] as V3)
  // 头基的质心离支点太近时（磷脂酰甘油一类），改用离支点最远的头基原子
  // when the head group's centroid is too close to the pivots (as in phosphatidylglycerol), use its atom farthest from them instead
  if (len(axis) < 1.5 && headAtoms.length) {
    const far = headAtoms.slice().sort((a, b) => len(sub(at(g.pos, b), hinge)) - len(sub(at(g.pos, a), hinge)))[0]!
    axis = sub(at(g.pos, far), hinge)
  }
  if (len(axis) < 0.5) return { pos: g.pos, tails: tails.length }
  const down = unit([-axis[0], -axis[1], -axis[2]])
  const pos = g.pos.slice()
  for (const t of tails) {
    const p = at(pos, t.pivot)
    const from = unit(sub(at(pos, t.tip), p))
    // 每条尾链略微向外张开一点（离开各支点的中心），免得并排的两条挤在一起
    // each tail leans outward a little, away from the middle of the pivots, so that tails side by side do not crowd into one another
    const out = sub(p, hinge), along = dot(out, down)
    const lean: V3 = [out[0] - down[0] * along, out[1] - down[1] * along, out[2] - down[2] * along]
    const target = len(lean) > 0.3 ? unit([down[0] + (lean[0] / len(lean)) * SPLAY, down[1] + (lean[1] / len(lean)) * SPLAY, down[2] + (lean[2] / len(lean)) * SPLAY]) : down
    const c = Math.max(-1, Math.min(1, dot(from, target)))
    if (c > 0.9999) continue
    let k = cross(from, target)
    if (len(k) < 1e-6) k = cross(from, Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])
    k = unit(k)
    const s = Math.sqrt(1 - c * c)
    for (const a of t.atoms) {
      // 罗德里格斯旋转公式 / Rodrigues' rotation formula
      const v = sub(at(pos, a), p), kv = cross(k, v), kd = dot(k, v) * (1 - c)
      for (let i = 0; i < 3; i++) pos[a * 3 + i] = p[i]! + v[i]! * c + kv[i]! * s + k[i]! * kd
    }
  }
  return { pos, tails: tails.length }
}

/** 尾链向外张开的程度（正切值，约 9 度）/ how far tails lean outward, as a tangent (about 9 degrees) */
const SPLAY = 0.16

/** 读一个脂质并把尾链摆到一侧 / read a lipid and turn its tails to one side */
export function parseLipid(text: string, id: string): { mol: Molecule; tails: number } {
  const g = readSdf(text, id)
  const r = reposeTails(g)
  return { mol: molecule({ ...g, pos: r.pos }, id), tails: r.tails }
}

/** 一个小叶里的一种脂质和它所占的份额 / one kind of lipid in a leaflet and its share */
export interface LipidShare {
  /** 脂质类别，如 PC、CHOL / the lipid class, e.g. PC, CHOL */
  cls: string
  mol: Molecule
  /** 这个小叶里它占的比例（0-1，同一小叶合计为 1）/ its share of the leaflet, 0-1, summing to 1 within a leaflet */
  fraction: number
  tails: number
}

/** 一张膜两个小叶的脂质 / the lipids of the two leaflets of a membrane */
export interface LipidSet {
  id: string
  name: string
  basis: string
  citation: string
  outer: LipidShare[]
  inner: LipidShare[]
}

interface MembraneEntry { id: string; name: string; nameEn: string; outer: Record<string, number>; inner: Record<string, number>; cholesterol: number; basis: string; basisEn: string; kind: string; citation: string }
export const MEMBRANES = membranes.membranes as unknown as MembraneEntry[]
const CCD = membranes.lipids as Record<string, { ccd: string; name: string; nameEn: string }>

/** 取某个化学组分的理想坐标（经本地服务）/ fetch a chemical component's ideal coordinates through the local service */
async function fetchLipid(ccd: string): Promise<{ mol: Molecule; tails: number }> {
  const res = await fetch(`/api/ligand/${ccd}`)
  if (!res.ok) throw new Error(`下载脂质 ${ccd} 的坐标失败`)
  return parseLipid(await res.text(), ccd)
}

/**
 * 某类膜的脂质组成，连同每种脂质的坐标。胆固醇按它占全部脂质的比例掺进两个小叶。
 * 不认识的膜类型用一张只有 POPC 的膜，并说明。
 * The lipids of a kind of membrane with the coordinates of each. Cholesterol is mixed into both
 * leaflets at its share of all lipid. An unknown kind of membrane gives a membrane of POPC alone,
 * and says so.
 */
export async function loadLipids(membraneId?: string): Promise<LipidSet> {
  const entry = MEMBRANES.find((m) => m.id === membraneId)
  const classes = entry ? [...new Set([...Object.keys(entry.outer), ...Object.keys(entry.inner), ...(entry.cholesterol > 0 ? ['CHOL'] : [])])] : ['PC']
  const loaded = new Map<string, { mol: Molecule; tails: number }>()
  await Promise.all(classes.map(async (c) => loaded.set(c, await fetchLipid(CCD[c]!.ccd))))
  const leaflet = (mix: Record<string, number>, chol: number): LipidShare[] => {
    const total = Object.values(mix).reduce((s, v) => s + v, 0) || 1
    const rest = 1 - chol / 100
    const out = Object.entries(mix).map(([cls, v]) => ({ cls, ...loaded.get(cls)!, fraction: (v / total) * rest }))
    if (chol > 0) out.push({ cls: 'CHOL', ...loaded.get('CHOL')!, fraction: chol / 100 })
    return out
  }
  if (!entry) {
    const pc = [{ cls: 'PC', ...loaded.get('PC')!, fraction: 1 }]
    return { id: 'generic', name: '只有 POPC 的膜', basis: '没有这类膜的组成数据，用同一种磷脂（POPC）铺成。', citation: '', outer: pc, inner: pc }
  }
  return { id: entry.id, name: entry.name, basis: entry.basis, citation: entry.citation, outer: leaflet(entry.outer, entry.cholesterol), inner: leaflet(entry.inner, entry.cholesterol) }
}
