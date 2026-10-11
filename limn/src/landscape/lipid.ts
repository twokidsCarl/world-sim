import membranes from '../../data/membranes.json'
import { El, IDENTITY, type Molecule } from '../mol/types'
import { t, tIn, noteError } from '../i18n'

export interface Graph {
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
  if (!Number.isFinite(n) || n <= 0) throw noteError('error.lipid.parse', { id })
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
  if (element.length === 0) throw noteError('error.lipid.empty', { id })
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

/** 图上两个原子之间隔几根键（只算到 4，更远的记 4）/ how many bonds apart two atoms are in the graph, counted up to 4 and capped there */
function bondDistances(g: Graph): Uint8Array {
  const n = g.element.length
  const d = new Uint8Array(n * n).fill(4)
  for (let a = 0; a < n; a++) {
    d[a * n + a] = 0
    let frontier = [a]
    for (let step = 1; step <= 3; step++) {
      const next: number[] = []
      for (const x of frontier)
        for (const y of g.bonds[x]!)
          if (d[a * n + y]! > step) {
            d[a * n + y] = step
            next.push(y)
          }
      frontier = next
    }
  }
  return d
}

/** 不直接相连的原子至少隔这么远（Å）：隔三根键的允许近一些 / the least distance, in Å, between atoms not bonded to each other: those three bonds apart may come closer */
const CLEAR_14 = 2.6
const CLEAR = 3.1

/**
 * 几何松弛：把挤在一起的原子推开，同时保持每根键的长度和每个键角（用隔一个原子的两原子间距来约束），
 * 并让每个原子不要离转完尾链后的位置太远。这不是力场，也不是分子模拟：只是让示意构象里没有原子叠在一起。
 * `rest` 给出该保持的键长和键角（数据库里的原始坐标），`pos` 是要松弛的坐标。
 *
 * A geometric relaxation: atoms that crowd each other are pushed apart while every bond length and
 * bond angle is held (angles through the distance between atoms two bonds apart), and no atom is
 * let stray far from where turning the tails left it. This is neither a force field nor a
 * simulation; it only makes sure no atoms sit on top of one another in a schematic conformer.
 * `rest` gives the bond lengths and angles to keep (the database's own coordinates); `pos` is what is relaxed.
 */
export function relax(g: Graph, pos: number[], rest: number[] = g.pos, iterations = 400): number[] {
  const n = g.element.length
  const sep = bondDistances(g)
  const p = pos.slice(), home = pos.slice()
  const dist = (q: number[], a: number, b: number) => Math.hypot(q[a * 3]! - q[b * 3]!, q[a * 3 + 1]! - q[b * 3 + 1]!, q[a * 3 + 2]! - q[b * 3 + 2]!)
  const fixed: [number, number, number][] = [], apart: [number, number, number][] = []
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++) {
      const s = sep[a * n + b]!
      if (s === 1 || s === 2) fixed.push([a, b, dist(rest, a, b)])
      else apart.push([a, b, s === 3 ? CLEAR_14 : CLEAR])
    }
  /** 把 a、b 的距离向 target 拉近一个比例 / move a and b a share of the way towards being `target` apart */
  const pull = (a: number, b: number, target: number, share: number) => {
    const dx = p[b * 3]! - p[a * 3]!, dy = p[b * 3 + 1]! - p[a * 3 + 1]!, dz = p[b * 3 + 2]! - p[a * 3 + 2]!
    const d = Math.hypot(dx, dy, dz) || 1e-6
    const k = ((d - target) / d) * 0.5 * share
    p[a * 3] = p[a * 3]! + dx * k
    p[a * 3 + 1] = p[a * 3 + 1]! + dy * k
    p[a * 3 + 2] = p[a * 3 + 2]! + dz * k
    p[b * 3] = p[b * 3]! - dx * k
    p[b * 3 + 1] = p[b * 3 + 1]! - dy * k
    p[b * 3 + 2] = p[b * 3 + 2]! - dz * k
  }
  // 两个原子正好重合时，先错开一点，否则没有方向可推 / atoms that coincide exactly are first nudged apart, or there is no direction to push along
  for (let i = 0; i < n * 3; i++) p[i] = p[i]! + Math.sin(i * 12.9898) * 0.01
  for (let it = 0; it < iterations; it++) {
    for (const [a, b, min] of apart) if (dist(p, a, b) < min) pull(a, b, min, 0.5)
    // 向“家”的位置轻轻拉回，保住整体形状（越往后越松）/ a light pull towards home keeps the overall shape, weaker as the run goes on
    const back = 0.02 * (1 - it / iterations)
    for (let i = 0; i < n * 3; i++) p[i] = p[i]! + (home[i]! - p[i]!) * back
    for (let pass = 0; pass < 3; pass++) for (const [a, b, d0] of fixed) pull(a, b, d0, 1)
  }
  // 最后只做键长和键角，保证它们准确 / finish with bonds and angles alone, so that they come out exact
  for (let pass = 0; pass < 40; pass++) for (const [a, b, d0] of fixed) pull(a, b, d0, 1)
  return p
}

/** 一个构象里不直接相连（隔三根键以上）的原子之间的最小距离，和键长的最大偏差 / the least distance between atoms not bonded together (three or more bonds apart) in a conformer, and the greatest deviation of a bond length */
export function conformerQuality(g: Graph, pos: number[], rest: number[] = g.pos): { closest: number; bondError: number } {
  const n = g.element.length
  const sep = bondDistances(g)
  const dist = (q: number[], a: number, b: number) => Math.hypot(q[a * 3]! - q[b * 3]!, q[a * 3 + 1]! - q[b * 3 + 1]!, q[a * 3 + 2]! - q[b * 3 + 2]!)
  let closest = Infinity, bondError = 0
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++) {
      const s = sep[a * n + b]!
      if (s === 1) bondError = Math.max(bondError, Math.abs(dist(pos, a, b) - dist(rest, a, b)))
      else if (s >= 3) closest = Math.min(closest, dist(pos, a, b))
    }
  return { closest, bondError }
}

/** 读 SDF 成图（供检验用）/ read an SDF into a graph, for checks */
export const readLipidGraph = (text: string, id: string): Graph => readSdf(text, id)

/** 读一个脂质并把尾链摆到一侧 / read a lipid and turn its tails to one side */
export function parseLipid(text: string, id: string): { mol: Molecule; tails: number } {
  const g = readSdf(text, id)
  const r = reposeTails(g)
  // 有尾链的才需要松弛；胆固醇这样的刚性分子原样使用 / only a molecule with tails needs relaxing; a rigid one such as cholesterol is used as it is
  return { mol: molecule({ ...g, pos: r.tails ? relax(g, r.pos) : r.pos }, id), tails: r.tails }
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
  /** 名称和依据的英文 / the name and the basis in English */
  nameEn: string
  basisEn: string
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
  if (!res.ok) throw noteError('error.lipid.fetch', { id: ccd })
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
    return { id: 'generic', name: tIn('zh', 'lipid.generic.name'), nameEn: tIn('en', 'lipid.generic.name'), basis: tIn('zh', 'lipid.generic.basis'), basisEn: tIn('en', 'lipid.generic.basis'), citation: '', outer: pc, inner: pc }
  }
  return { id: entry.id, name: entry.name, nameEn: entry.nameEn, basis: entry.basis, basisEn: entry.basisEn, citation: entry.citation, outer: leaflet(entry.outer, entry.cholesterol), inner: leaflet(entry.inner, entry.cholesterol) }
}
