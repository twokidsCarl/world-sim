/**
 * 把膜上的蛋白排成 Goodsell 画里那样：均匀分布、垂直于膜。
 *
 * 模拟数据里的刺是歪斜、聚堆的（那是真实的样子）；他的画里它们一圈一圈排得很整齐。
 * 这里保留数据里的种类、数量和每个复合体的结构，只把位置和朝向理想化：
 * - 从数据里挑一个最直立的复合体（三聚体或四聚体，连同它身上的糖链）当样板；
 * - 位置排在绕观察方向的一圈圈纬线上，每圈等间隔，相邻两圈错开半步。这样从正面剖开时，
 *   切面上那一圈是等间隔的，后面一圈正好露在前一圈的空隙里，和他的画一样。
 *
 * Arrange the proteins of a membrane as in Goodsell's paintings: evenly spread and standing
 * straight up from the membrane.
 *
 * In the simulation data the spikes lean and cluster (which is how they really are); in his
 * paintings they stand in orderly rings. The kinds, the numbers and the structure of each complex
 * are kept from the data here, and only position and orientation are idealised:
 * - one complex (a trimer or tetramer, with the glycans on it), the most upright in the data, is
 *   taken as the template;
 * - sites lie on rings of latitude about the viewing direction, evenly spaced within a ring, with
 *   neighbouring rings offset by half a step. Cut from the front, the ring in the cut plane is then
 *   evenly spaced, and the ring behind shows in the gaps of the one in front, as in his paintings.
 */
import type { Molecule } from '../mol/types'
import { frameToFrame, principalAxis } from './influenza'

type V3 = [number, number, number]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** 一条链的质心 / the centroid of a chain */
export function chainCentre(mol: Molecule, ci: number): V3 {
  const c = mol.chains[ci]!
  const out: V3 = [0, 0, 0]
  const step = Math.max(1, Math.floor(c.count / 400))
  let n = 0
  for (let i = c.start; i < c.start + c.count; i += step) {
    out[0] += mol.pos[i * 3]!
    out[1] += mol.pos[i * 3 + 1]!
    out[2] += mol.pos[i * 3 + 2]!
    n++
  }
  return [out[0] / n, out[1] / n, out[2] / n]
}

/**
 * 把链按质心的远近分成每组 `size` 条的复合体：每次取一条还没分组的链，和离它最近的 size − 1 条成一组。
 * 最远的那条超过 `maxDist` 的组不要（落单的链）。
 * Group chains into complexes of `size` by how close their centroids are: take a chain not yet
 * grouped and join it with its size − 1 nearest. A group whose farthest member is beyond `maxDist`
 * is dropped (stray chains).
 */
export function complexes(mol: Molecule, chains: number[], size: number, maxDist: number): number[][] {
  const centres = chains.map((ci) => chainCentre(mol, ci))
  const used = new Uint8Array(chains.length)
  const out: number[][] = []
  for (let i = 0; i < chains.length; i++) {
    if (used[i]) continue
    const near = chains
      .map((_, j) => ({ j, d: used[j] || j === i ? Infinity : Math.hypot(...sub(centres[j]!, centres[i]!)) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, size - 1)
    used[i] = 1
    if (near.length < size - 1 || near[near.length - 1]!.d > maxDist) continue
    for (const n of near) used[n.j] = 1
    out.push([chains[i]!, ...near.map((n) => chains[n.j]!)])
  }
  return out
}

/** 只含指定几条链的一个新结构 / a new structure holding just the given chains */
export function subMolecule(mol: Molecule, chains: number[], id: string, title: string): Molecule {
  const n = chains.reduce((s, ci) => s + mol.chains[ci]!.count, 0)
  const pos = new Float32Array(n * 3), radius = mol.radius ? new Float32Array(n) : undefined
  const element = new Uint8Array(n), chainOf = new Uint32Array(n), isTrace = new Uint8Array(n), residue = new Int32Array(n)
  const entityOf = new Map<number, number>()
  const entities: Molecule['entities'] = [], out: Molecule['chains'] = []
  let at = 0
  chains.forEach((ci, k) => {
    const c = mol.chains[ci]!
    if (!entityOf.has(c.entity)) {
      entityOf.set(c.entity, entities.length)
      entities.push({ ...mol.entities[c.entity]! })
    }
    pos.set(mol.pos.subarray(c.start * 3, (c.start + c.count) * 3), at * 3)
    radius?.set(mol.radius!.subarray(c.start, c.start + c.count), at)
    element.set(mol.element.subarray(c.start, c.start + c.count), at)
    isTrace.set(mol.isTrace.subarray(c.start, c.start + c.count), at)
    residue.set(mol.residue.subarray(c.start, c.start + c.count), at)
    chainOf.fill(k, at, at + c.count)
    out.push({ ...c, entity: entityOf.get(c.entity)!, start: at })
    at += c.count
  })
  return { id, title, atomCount: n, pos, element, ...(radius ? { radius } : {}), chainOf, isTrace, residue, chains: out, entities, assemblies: [] }
}

/**
 * 单位球面上绕 `axis` 的一圈圈位置，一共 n 个。相邻位置的间距处处相近；每圈等间隔，相邻两圈错开半步。
 * 中间那一圈在赤道稍靠后一点（`behind`，弧度），这样从正面沿赤道剖开时它整圈留在切片里。
 * Sites on rings about `axis` on the unit sphere, n in all. Spacing between neighbours is about
 * the same everywhere; sites are even within a ring and neighbouring rings are offset by half a
 * step. The middle ring lies a little behind the equator (`behind`, in radians), so that a cut
 * from the front along the equator keeps the whole ring in the slab.
 */
export function ringSites(n: number, axis: V3, behind = 0.02): V3[] {
  const a = norm(axis)
  const e1 = norm(cross(Math.abs(a[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], a)), e2 = cross(a, e1)
  // 圈数：圈与圈的间距和圈上的间距相近；取奇数，中间一圈在赤道
  // the number of rings: spacing between rings about equal to spacing along them; odd, so that the middle one is on the equator
  let K = Math.max(1, Math.round(Math.PI / Math.sqrt((4 * Math.PI) / n)))
  if (K % 2 === 0) K++
  const step = Math.PI / K
  // θ 从观察方向量起；大于 π/2 是在赤道后面 / θ is measured from the viewing direction; beyond π/2 lies behind the equator
  const thetas = Array.from({ length: K }, (_, k) => Math.PI / 2 + behind + (k - (K - 1) / 2) * step).filter((t) => t > 0.05 && t < Math.PI - 0.05)
  // n 个位置按各圈的周长分下去，零头给小数部分最大的几圈，总数正好是 n
  // the n sites are shared out by each ring's circumference, the remainder going to the rings with the largest fractions, so the total is exactly n
  const weight = thetas.map((t) => Math.sin(t)), total = weight.reduce((s, w) => s + w, 0)
  const share = weight.map((w) => (n * w) / total)
  const count = share.map((v) => Math.floor(v))
  const order = share.map((v, k) => ({ k, f: v - Math.floor(v) })).sort((x, y) => y.f - x.f)
  for (let i = 0, left = n - count.reduce((s, c) => s + c, 0); i < left; i++) count[order[i % order.length]!.k]!++
  // 赤道那一圈和它前后各一圈取同样的数目：这样错开的半步处处一致，后一圈的每个位置正好在前一圈的空隙里。
  // （数目不同的话，错位绕一圈会慢慢漂移，有的地方对齐、有的地方重叠，看上去就乱。）多出或少掉的几个摊给其余各圈。
  // The equatorial ring and the one either side of it take the same count, so that the half-step
  // offset holds all the way round and every site of the ring behind sits in a gap of the ring in
  // front. (With different counts the offset drifts round the ring, aligned here and overlapping
  // there, which reads as disorder.) The few gained or lost are spread over the other rings.
  const mid = thetas.reduce((best, t, k) => (Math.abs(t - Math.PI / 2 - behind) < Math.abs(thetas[best]! - Math.PI / 2 - behind) ? k : best), 0)
  let spare = 0
  for (const k of [mid - 1, mid + 1]) if (k >= 0 && k < count.length) {
    spare += count[k]! - count[mid]!
    count[k] = count[mid]!
  }
  const others = count.map((_, k) => k).filter((k) => Math.abs(k - mid) > 1)
  for (let i = 0; spare !== 0 && others.length > 0 && i < 10_000; i++) {
    const k = others[i % others.length]!
    if (spare > 0) {
      count[k]!++
      spare--
    } else if (count[k]! > 1) {
      count[k]!--
      spare++
    }
  }
  const out: V3[] = []
  thetas.forEach((theta, k) => {
    const m = count[k]!, r = Math.sin(theta)
    for (let j = 0; j < m; j++) {
      const phi = ((j + (k % 2) * 0.5) / m) * 2 * Math.PI
      out.push([a[0] * Math.cos(theta) + (e1[0] * Math.cos(phi) + e2[0] * Math.sin(phi)) * r, a[1] * Math.cos(theta) + (e1[1] * Math.cos(phi) + e2[1] * Math.sin(phi)) * r, a[2] * Math.cos(theta) + (e1[2] * Math.cos(phi) + e2[2] * Math.sin(phi)) * r])
    }
  })
  return out
}

export interface Template {
  /** 样板复合体的质心、它“朝外”的轴，以及质心到膜中心的距离 / the template complex's centroid, its "outward" axis, and the distance of the centroid from the membrane's centre */
  origin: V3
  up: V3
  distance: number
  /** 它偏离膜法线的角度（度）/ how far it leans from the membrane's normal, in degrees */
  tilt: number
}

/** 一个复合体的朝向：主轴，取指向膜外的那一头 / the orientation of a complex: its principal axis, taken pointing away from the membrane */
export function templateOf(mol: Molecule, chains: number[], centre: V3): Template {
  const pts: number[] = []
  for (const ci of chains) {
    const c = mol.chains[ci]!
    const step = Math.max(1, Math.floor(c.count / 600))
    for (let i = c.start; i < c.start + c.count; i += step) pts.push(mol.pos[i * 3]!, mol.pos[i * 3 + 1]!, mol.pos[i * 3 + 2]!)
  }
  const p = principalAxis(pts)
  const out = norm(sub(p.centre, centre))
  const up: V3 = dot(p.axis, out) >= 0 ? p.axis : [-p.axis[0], -p.axis[1], -p.axis[2]]
  return { origin: p.centre, up, distance: Math.hypot(...sub(p.centre, centre)), tilt: (Math.acos(Math.min(1, Math.abs(dot(p.axis, out)))) * 180) / Math.PI }
}

/** 把样板放到球面的各个位置上：样板的轴对着那里的法线，质心离膜中心的距离不变 / put the template at each site of a sphere: its axis along the normal there, its centroid as far from the membrane's centre as before */
export function placeTemplate(t: Template, centre: V3, sites: V3[]): Float32Array[] {
  const x = norm(cross(Math.abs(t.up[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], t.up)), y = cross(t.up, x)
  return sites.map((d) => {
    const X = norm(cross(Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], d)), Y = cross(d, X)
    return frameToFrame(t.origin, x, y, t.up, [centre[0] + d[0] * t.distance, centre[1] + d[1] * t.distance, centre[2] + d[2] * t.distance], X, Y, d)
  })
}

/**
 * 一层理想的球形膜：在内外半径之间一层层地铺小球，够密，画出来是一条光滑的带子。
 * 模拟里的膜是起伏的，切开后边缘参差；Goodsell 画的膜是一条边缘光滑、宽度均匀的带子。厚度取自数据。
 * An ideal spherical membrane: small spheres laid layer upon layer between the inner and outer
 * radius, dense enough to draw as a smooth band. A simulated membrane undulates and its cut edge
 * is ragged; the membrane Goodsell paints is a band of smooth edges and even width. The thickness
 * is taken from the data.
 */
export function shellMembrane(centre: V3, inner: number, outer: number, id: string, spacing = 8): Molecule {
  const pos: number[] = []
  const layers = Math.max(2, Math.round((outer - inner) / spacing) + 1)
  for (let l = 0; l < layers; l++) {
    const r = inner + ((outer - inner) * l) / (layers - 1)
    const n = Math.round((4 * Math.PI * r * r) / (spacing * spacing))
    const g = Math.PI * (3 - Math.sqrt(5))
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n, q = Math.sqrt(1 - y * y)
      pos.push(centre[0] + Math.cos(g * i) * q * r, centre[1] + y * r, centre[2] + Math.sin(g * i) * q * r)
    }
  }
  const n = pos.length / 3
  return {
    id, title: 'membrane', atomCount: n, pos: new Float32Array(pos), element: new Uint8Array(n).fill(1), radius: new Float32Array(n).fill(spacing * 0.8),
    chainOf: new Uint32Array(n), isTrace: new Uint8Array(n), residue: new Int32Array(n).fill(1),
    chains: [{ asymId: 'MEM', authAsymId: 'MEM', entity: 0, start: 0, count: n, model: 1 }], entities: [{ id: 'membrane', description: 'membrane', kind: 'lipid' }], assemblies: [],
  }
}

/**
 * “夸张”：把一个刺沿它的轴拉长，柄收细、头放宽，像 Goodsell 画的那样。这不是真实的形状：
 * 量他的《Influenza Virus》，刺长约为膜厚的 4.2 倍，有细柄和蘑菇状的头；真实的血凝素约 3 倍，上下差不多粗。
 * 就地改 `mol` 的坐标，返回新的样板（轴不变，质心和它到膜中心的距离跟着变，刺的根部留在原处）。
 * `split` 是柄和头的分界在刺上的位置（0 = 根，1 = 顶）。
 *
 * "Exaggeration": a spike is stretched along its axis, its stalk narrowed and its head widened, the
 * way Goodsell paints it. This is not the real shape: on his "Influenza Virus" a spike is about 4.2
 * membrane thicknesses long with a thin stalk and a mushroom head, where a real hemagglutinin is
 * about 3 and much the same width throughout. Coordinates of `mol` are changed in place and the new
 * template returned (same axis; the centroid and its distance from the membrane's centre follow,
 * and the foot of the spike stays where it was). `split` is where stalk gives way to head along the
 * spike (0 = foot, 1 = tip).
 */
export function exaggerate(mol: Molecule, t: Template, shape: { stretch: number; stalk: number; head: number; split: number }): Template {
  const n = mol.atomCount
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < n; i++) {
    const h = (mol.pos[i * 3]! - t.origin[0]) * t.up[0] + (mol.pos[i * 3 + 1]! - t.origin[1]) * t.up[1] + (mol.pos[i * 3 + 2]! - t.origin[2]) * t.up[2]
    if (h < lo) lo = h
    if (h > hi) hi = h
  }
  const c: V3 = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const d: V3 = [mol.pos[i * 3]! - t.origin[0], mol.pos[i * 3 + 1]! - t.origin[1], mol.pos[i * 3 + 2]! - t.origin[2]]
    const h = dot(d, t.up)
    const s = (h - lo) / Math.max(1e-6, hi - lo)
    // 柄到头之间平滑过渡 / a smooth passage from stalk to head
    const u = Math.min(1, Math.max(0, (s - (shape.split - 0.1)) / 0.2))
    const w = shape.stalk + (shape.head - shape.stalk) * u * u * (3 - 2 * u)
    const h2 = lo + (h - lo) * shape.stretch
    for (let k = 0; k < 3; k++) {
      const v = t.origin[k]! + t.up[k]! * h2 + (d[k]! - t.up[k]! * h) * w
      mol.pos[i * 3 + k] = v
      c[k]! += v / n
    }
  }
  return { ...t, origin: c, distance: t.distance + dot(sub(c, t.origin), t.up) }
}
