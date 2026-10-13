// 由发布的 GLB 建一副身体（或其中一个区域）的四面体笼子。
// Builds the tetrahedral cage of a body (or of one region of it) from the shipped GLBs.
//
// 做法 / Method
//   1. 外边界：发布的皮肤。它在眼和口处有真实开口，所以"体内"用三个轴向的射线奇偶性表决（三取二）：
//      开口只让穿过它的那一条射线出错。不需要数据目录之外的闭合皮肤。
//      Outer boundary: the shipped skin. It has real openings at eyes and mouth, so "inside the body" is a vote of
//      ray parity along the three axes (two of three): an opening spoils only the ray that passes through it. No
//      closed skin from outside the data directory is needed.
//   2. 四面体：体心立方格子（src/softbody/lattice.ts），保留与身体有交的四面体。不做边界吸附：
//      笼子略大于身体，每个四面体记下落在体内的体积比例，刚度和质量按它折减（嵌入式/虚拟域做法）。
//      四面体因此全部全等、质量最好；代价是表面的力学分辨率就是格子的分辨率。
//      Tetrahedra: the body-centred cubic lattice, keeping those that meet the body. No boundary snapping: the cage
//      is slightly larger than the body, every tetrahedron records its share inside the body and stiffness and mass
//      are scaled by it (the embedded / fictitious-domain way). All tetrahedra are thus congruent and of the best
//      quality; the price is that the mechanical resolution of the surface is that of the lattice.
//   3. 材料：每个四面体取 9 个采样点（4 个结点 + 5 个内部点），逐点判断落在哪类部件里，多数表决。
//      Materials: nine sample points per tetrahedron (its 4 nodes + 5 interior points), each classified by the kind
//      of part it lies in; the majority wins.
//   4. 骨：落在刚性部件（绑定里带 joint 的骨、软骨、牙）内的结点钉在该关节上；骨穿过而没有结点落入的四面体，
//      在骨的位置放一个嵌入式锚点。
//      Bone: nodes inside rigid parts (bone, cartilage, teeth whose binding has a joint) are pinned to that joint;
//      a tetrahedron crossed by bone without a node inside gets an embedded anchor where the bone is.
//   5. 结点的蒙皮权重取自附近软部件顶点的权重；肌肉纤维方向取绑定里的作用线。
//      Node skinning weights come from nearby vertices of soft parts; muscle fibre directions from the rig's lines of action.

import type { Rig } from '../../src/anatomy/types.ts'
import { type SoftArrays, encodeSoft } from '../../src/softbody/body.ts'
import { type Lattice, barycentric, latticeNodePosition, locateSlot, meshFromSlots, slotCount, slotNodes } from '../../src/softbody/lattice.ts'
import type { PointSet } from '../../src/softbody/solver.ts'
import { NO_MUSCLE, type SoftData, type SoftMaterial } from '../../src/softbody/types.ts'
import { InsideTester, PointIndex, thinPoints } from '../pipeline/register.ts'
import type { Body, RawMesh } from '../rig/io.ts'
import { eigSym } from '../rig/math.ts'

export interface CageOptions {
  /** 格子单元边长，米 / lattice cell edge, metres */
  cell: number
  /** 只建这个盒子里的部分（区域笼子）：[minX, minY, minZ, maxX, maxY, maxZ] / build only what is inside this box (a regional cage) */
  region?: [number, number, number, number, number, number]
  /** 区域笼子：盒子边界上这么厚的一层结点钉住（代替被切掉的身体）/ regional cage: nodes within this distance of the box faces are pinned (standing in for the body cut away) */
  regionPin?: number
  gravity: [number, number, number]
  materials: SoftMaterial[]
  skinThickness: number
}

export interface CageStats {
  cell: number
  nodes: number
  tets: number
  pinnedNodes: number
  rigidTets: number
  /** 没有任何约束、因而整块钉住的四面体数 / tetrahedra held by nothing and therefore pinned as a whole */
  islandTets: number
  anchors: number
  /** Σ V·fill 与皮肤包住的体积之比的近似（采样）/ Σ V·fill, litres */
  filledLitres: number
  cageLitres: number
  byMaterial: Record<string, { tets: number; litres: number }>
  muscles: number
  musclesWithFibre: number
  capsules: number
  skinVerticesEmbedded: number
  skinVertices: number
  seconds: number
}

const permuted = (m: RawMesh, a: number, b: number, c: number): RawMesh => {
  const p = new Float32Array(m.positions.length)
  for (let i = 0; i < p.length; i += 3) {
    p[i] = m.positions[i + a]!
    p[i + 1] = m.positions[i + b]!
    p[i + 2] = m.positions[i + c]!
  }
  return { positions: p, indices: m.indices }
}

/** 三个轴向射线奇偶性的表决 / the vote of ray parity along three axes */
export function bodyInside(skin: RawMesh): (x: number, y: number, z: number) => boolean {
  const ty = new InsideTester(skin, 256), tx = new InsideTester(permuted(skin, 1, 0, 2), 256), tz = new InsideTester(permuted(skin, 0, 2, 1), 256)
  return (x, y, z) => (ty.contains(x, y, z) ? 1 : 0) + (tx.contains(y, x, z) ? 1 : 0) + (tz.contains(x, z, y) ? 1 : 0) >= 2
}

const CLS = { void: 0, bone: 1, muscle: 2, fat: 3, gland: 4, breastFat: 5, abdomen: 6, thorax: 7, other: 8 } as const
const CLS_MATERIAL = ['', 'bone', 'muscle', 'fat', 'breast_gland', 'breast_fat', 'abdomen', 'thorax', 'other']

interface Tester {
  cls: number
  /** 骨：关节下标；肌肉：部件下标 / bone: joint index; muscle: part index */
  tag: number
  t: InsideTester
}

export function buildCage(body: Body, rig: Rig, rigBin: Uint8Array, opts: CageOptions): { json: SoftData; bin: Uint8Array; stats: CageStats } {
  const t0 = performance.now()
  const parts = body.data.parts
  const skinPart = parts.filter((p) => p.tissue === 'skin').sort((a, b) => b.triangles - a.triangles)[0]
  if (!skinPart) throw new Error('softbody: the body has no skin part')
  const skin = body.meshes.get(skinPart.id)!
  const inBody = bodyInside(skin)
  const jointIndex = new Map(rig.joints.map((j, i) => [j.id, i]))
  const bindingOf = new Map(rig.bindings.map((b) => [b.part, b]))
  const partIndex = new Map(parts.map((p, i) => [p.id, i]))
  const inRegion = (x: number, y: number, z: number): boolean => !opts.region || (x >= opts.region[0] && y >= opts.region[1] && z >= opts.region[2] && x <= opts.region[3] && y <= opts.region[4] && z <= opts.region[5])

  // ── 部件的内外判断器 / inside testers of the parts ──
  const testers: Tester[] = []
  const box = (ids: string[], pad: number): number[] | null => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (const id of ids) {
      const p = body.byId.get(id)
      if (!p) continue
      for (let k = 0; k < 3; k++) {
        b[k] = Math.min(b[k]!, p.bbox[k]! - pad)
        b[k + 3] = Math.max(b[k + 3]!, p.bbox[k + 3]! + pad)
      }
    }
    return Number.isFinite(b[0]!) ? b : null
  }
  const lungs = parts.filter((p) => p.system === 'respiratory' && /lung|lobe/i.test(p.name) && p.tissue === 'organ')
  const heart = parts.filter((p) => p.tissue === 'heart')
  const thoraxBox = box([...lungs, ...heart].map((p) => p.id), 0.005)
  const diaphragmY = thoraxBox ? thoraxBox[1]! : Infinity
  // 腹腔脏器：消化、泌尿、生殖系统里中心在膈以下的器官和腺体 / abdominal viscera: organs and glands of the digestive, urinary and reproductive systems centred below the diaphragm
  const viscera = parts.filter((p) => ['digestive', 'urinary', 'reproductive'].includes(p.system) && (p.tissue === 'organ' || p.tissue === 'gland') && p.centroid[1] < diaphragmY && p.triangles >= 200 && bindingOf.get(p.id)?.joint === undefined)
  const abdomenBox = box(viscera.map((p) => p.id), 0.01)
  const glands = parts.filter((p) => /mammary lobe/i.test(p.name))
  const breastFat = parts.filter((p) => /adipose tissue of .* mammary gland/i.test(p.name))
  const breastBoxes = (['L', 'R'] as const).map((s) => box([...glands, ...breastFat].filter((p) => p.side === s).map((p) => p.id), 0.015)).filter((b): b is number[] => !!b)
  const add = (ids: { id: string }[], cls: number, tag: (id: string) => number): void => {
    for (const { id } of ids) {
      const m = body.meshes.get(id)
      if (!m || m.indices.length < 12) continue
      if (opts.region) {
        const b = body.byId.get(id)!.bbox
        if (b[0] > opts.region[3] || b[3] < opts.region[0] || b[1] > opts.region[4] || b[4] < opts.region[1] || b[2] > opts.region[5] || b[5] < opts.region[2]) continue
      }
      testers.push({ cls, tag: tag(id), t: new InsideTester(m, 32) })
    }
  }
  const rigid = parts.filter((p) => (p.tissue === 'bone' || p.tissue === 'cartilage' || p.tissue === 'tooth') && bindingOf.get(p.id)?.joint !== undefined)
  // 判断的先后就是优先级 / the order of the tests is the priority
  add(rigid, CLS.bone, (id) => jointIndex.get(bindingOf.get(id)!.joint!) ?? 0)
  add(parts.filter((p) => p.tissue === 'muscle' && bindingOf.get(p.id)?.joint === undefined), CLS.muscle, (id) => partIndex.get(id)!)
  add(glands, CLS.gland, () => 0)
  add(breastFat, CLS.breastFat, () => 0)
  add(parts.filter((p) => p.tissue === 'fat' && !breastFat.includes(p)), CLS.fat, () => 0)
  add(viscera, CLS.abdomen, () => 0)
  add([...lungs, ...heart], CLS.thorax, () => 0)
  const inBox = (b: number[] | null, x: number, y: number, z: number): boolean => !!b && x >= b[0]! && y >= b[1]! && z >= b[2]! && x <= b[3]! && y <= b[4]! && z <= b[5]!
  /** 采样点的类别和标记，打包成 cls + tag·16 / class and tag of a sample point, packed as cls + tag·16 */
  const classify = (x: number, y: number, z: number): number => {
    if (!inBody(x, y, z)) return CLS.void
    for (const s of testers) {
      const b = s.t.bbox
      if (x < b[0] || x > b[3] || y < b[1] || y > b[4] || z < b[2] || z > b[5]) continue
      if (s.t.contains(x, y, z)) return s.cls + s.tag * 16
    }
    // 不在任何部件里的体内空间：按所在区域归类（脏器之间、肌间隙）
    // interior space inside no part: classified by where it is (between viscera, between muscles)
    if (breastBoxes.some((b) => inBox(b, x, y, z))) return CLS.breastFat
    if (inBox(thoraxBox, x, y, z)) return CLS.thorax
    if (inBox(abdomenBox, x, y, z) && y < diaphragmY) return CLS.abdomen
    return CLS.other
  }

  // ── 格子 / the lattice ──
  const sb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < skin.positions.length; i += 3) {
    if (!inRegion(skin.positions[i]!, skin.positions[i + 1]!, skin.positions[i + 2]!)) continue
    for (let k = 0; k < 3; k++) {
      sb[k] = Math.min(sb[k]!, skin.positions[i + k]!)
      sb[k + 3] = Math.max(sb[k + 3]!, skin.positions[i + k]!)
    }
  }
  // 皮肤的整体包围盒：用来判断区域盒子的哪些面切开了身体 / whole-skin bounds: tell which faces of a region box cut the body
  const sbAll = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < skin.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    sbAll[k] = Math.min(sbAll[k]!, skin.positions[i + k]!)
    sbAll[k + 3] = Math.max(sbAll[k + 3]!, skin.positions[i + k]!)
  }
  const a = opts.cell
  const lattice: Lattice = {
    origin: [Math.floor(sb[0]! / a - 1.5) * a, Math.floor(sb[1]! / a - 1.5) * a, Math.floor(sb[2]! / a - 1.5) * a],
    cell: a,
    dims: [0, 0, 0],
  }
  for (let k = 0; k < 3; k++) lattice.dims[k] = Math.ceil((sb[k + 3]! - lattice.origin[k]!) / a + 1.5)

  // 结点类别按格点缓存 / node classes cached per lattice node
  const nodeClass = new Map<number, number>()
  const q = [0, 0, 0]
  const classOfNode = (id: number): number => {
    let c = nodeClass.get(id)
    if (c === undefined) {
      latticeNodePosition(lattice, id, q)
      c = classify(q[0]!, q[1]!, q[2]!)
      nodeClass.set(id, c)
    }
    return c
  }
  // 皮肤顶点所在的槽位一定保留（嵌入要用）/ slots holding skin vertices are always kept (the embedding needs them)
  const skinSlot = new Int32Array(skin.positions.length / 3).fill(-1)
  const forced = new Set<number>()
  for (let i = 0; i < skinSlot.length; i++) {
    const x = skin.positions[i * 3]!, y = skin.positions[i * 3 + 1]!, z = skin.positions[i * 3 + 2]!
    if (!inRegion(x, y, z)) continue
    const s = locateSlot(lattice, x, y, z)
    skinSlot[i] = s
    if (s >= 0) forced.add(s)
  }
  const slots: number[] = [], votes: Uint32Array[] = []
  const P = new Float64Array(12)
  const total = slotCount(lattice)
  for (let s = 0; s < total; s++) {
    const nd = slotNodes(lattice, s)
    if (!nd) continue
    let cx = 0, cy = 0, cz = 0
    for (let k = 0; k < 4; k++) {
      latticeNodePosition(lattice, nd[k]!, P, k * 3)
      cx += P[k * 3]! / 4
      cy += P[k * 3 + 1]! / 4
      cz += P[k * 3 + 2]! / 4
    }
    if (!inRegion(cx, cy, cz)) continue
    const v = new Uint32Array(9)
    let inside = 0
    for (let k = 0; k < 4; k++) {
      v[k] = classOfNode(nd[k]!)
      if (v[k]) inside++
    }
    if (!inside && !forced.has(s)) continue
    // 内部采样点：重心，以及重心与四个结点连线上靠结点 40% 处 / interior samples: the centroid and the points 40 % of the way from each node to it
    v[4] = classify(cx, cy, cz)
    for (let k = 0; k < 4; k++) v[5 + k] = classify(0.6 * P[k * 3]! + 0.4 * cx, 0.6 * P[k * 3 + 1]! + 0.4 * cy, 0.6 * P[k * 3 + 2]! + 0.4 * cz)
    // 九个采样点都在体外的四面体不要：它只是擦到皮肤，留下来会成为不受约束的碎片
    // a tetrahedron with all nine samples outside the body is dropped: it merely grazes the skin and would be an unconstrained scrap
    if (!v.some((c) => c !== 0)) continue
    slots.push(s)
    votes.push(v)
  }
  const mesh = meshFromSlots(lattice, slots)
  const N = mesh.nodes.length / 3, T = slots.length
  const matIndex = new Map(opts.materials.map((m, i) => [m.id, i]))
  const mat = (id: string): number => {
    const i = matIndex.get(id)
    if (i === undefined) throw new Error(`softbody: materials.json has no material "${id}"`)
    return i
  }

  // ── 结点：钉住与否 / nodes: pinned or free ──
  const nodePin = new Int16Array(N).fill(-1)
  for (let i = 0; i < N; i++) {
    const c = nodeClass.get(mesh.latticeId[i]!) ?? 0
    if ((c & 15) === CLS.bone) nodePin[i] = c >> 4
  }
  const regionPinned = new Uint8Array(N)
  if (opts.region && opts.regionPin) {
    const r = opts.region, d = opts.regionPin
    for (let i = 0; i < N; i++) {
      const x = mesh.nodes[i * 3]!, y = mesh.nodes[i * 3 + 1]!, z = mesh.nodes[i * 3 + 2]!
      // 只钉盒子切开身体的那些面（盒面在皮肤包围盒之内的）/ only faces where the box cuts the body (those inside the skin's bounds)
      const cut = (lo: number, hi: number, v: number, k: number): boolean => (lo > sbAll[k]! + 1e-6 && v < lo + d) || (hi < sbAll[k + 3]! - 1e-6 && v > hi - d)
      if (cut(r[0], r[3], x, 0) || cut(r[1], r[4], y, 1) || cut(r[2], r[5], z, 2)) regionPinned[i] = 1
    }
  }

  // ── 四面体：材料、体内比例、肌肉 / tetrahedra: material, fill, muscle ──
  const tetMaterial = new Uint8Array(T), tetFill = new Uint8Array(T), tetSkin = new Uint8Array(T), tetMuscle = new Uint16Array(T).fill(NO_MUSCLE)
  const muscleIds: number[] = [], muscleSlot = new Map<number, number>()
  const count = new Map<number, number>()
  for (let e = 0; e < T; e++) {
    const v = votes[e]!
    let inside = 0
    count.clear()
    for (let k = 0; k < 9; k++) {
      if (!v[k]) continue
      inside++
      count.set(v[k]!, (count.get(v[k]!) ?? 0) + 1)
    }
    tetFill[e] = Math.round((inside / 9) * 255)
    // 按类别计票；骨只有在没有别的类别时才当选（骨与软组织共占的四面体按软组织算，由钉住的结点和锚点约束）
    // votes per class; bone wins only when nothing else is present (a tetrahedron shared by bone and soft tissue counts as soft and is held by pins and anchors)
    const byCls = new Array<number>(9).fill(0)
    for (const [c, n] of count) byCls[c & 15] = byCls[c & 15]! + n
    let best: number = CLS.bone
    for (let c = 2; c < 9; c++) if (byCls[c]! > (best === CLS.bone ? 0 : byCls[best]!)) best = c
    if (inside === 0) best = CLS.other
    tetMaterial[e] = mat(CLS_MATERIAL[best]!)
    if (best === CLS.muscle) {
      let top = -1, topN = 0
      for (const [c, n] of count) if ((c & 15) === CLS.muscle && n > topN) (top = c >> 4), (topN = n)
      let mi = muscleSlot.get(top)
      if (mi === undefined) {
        mi = muscleIds.length
        muscleIds.push(top)
        muscleSlot.set(top, mi)
      }
      tetMuscle[e] = mi
    }
  }

  // ── 皮肤：嵌入，以及皮肤层占各四面体的体积比例 / the skin: embedding, and the share of each tetrahedron taken by the skin layer ──
  const slotTet = new Map<number, number>()
  mesh.slots.forEach((s, i) => slotTet.set(s, i))
  const nv = skin.positions.length / 3
  const area = new Float32Array(nv)
  for (let t = 0; t < skin.indices.length; t += 3) {
    const i0 = skin.indices[t]! * 3, i1 = skin.indices[t + 1]! * 3, i2 = skin.indices[t + 2]! * 3
    const p = skin.positions
    const ux = p[i1]! - p[i0]!, uy = p[i1 + 1]! - p[i0 + 1]!, uz = p[i1 + 2]! - p[i0 + 2]!, vx = p[i2]! - p[i0]!, vy = p[i2 + 1]! - p[i0 + 1]!, vz = p[i2 + 2]! - p[i0 + 2]!
    const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 6
    area[i0 / 3] = area[i0 / 3]! + ar
    area[i1 / 3] = area[i1 / 3]! + ar
    area[i2 / 3] = area[i2 / 3]! + ar
  }
  const emb: PointSet = { tet: new Uint32Array(nv), bary: new Float32Array(nv * 4) }
  const b4 = [0, 0, 0, 0]
  const skinVol = new Float32Array(T)
  let embedded = 0
  // 落在被丢弃的四面体里的皮肤顶点：外推到共用格点的相邻四面体里（取最负的重心坐标最接近零的那个）
  // skin vertices inside a dropped tetrahedron: extrapolated from a kept neighbour sharing a lattice node (the one whose most negative barycentric coordinate is closest to zero)
  const nodeOfLattice = new Map<number, number>()
  mesh.latticeId.forEach((id, i) => nodeOfLattice.set(id, i))
  const tetsOfNode: number[][] = Array.from({ length: N }, () => [])
  for (let e = 0; e < T; e++) for (let k = 0; k < 4; k++) tetsOfNode[mesh.tets[e * 4 + k]!]!.push(e)
  const neighbour = (slot: number, x: number, y: number, z: number): number | undefined => {
    let best: number | undefined, bw = -Infinity
    for (const id of slotNodes(lattice, slot) ?? []) {
      const n = nodeOfLattice.get(id)
      if (n === undefined) continue
      for (const e of tetsOfNode[n]!) {
        barycentric(mesh.nodes, mesh.tets[e * 4]!, mesh.tets[e * 4 + 1]!, mesh.tets[e * 4 + 2]!, mesh.tets[e * 4 + 3]!, x, y, z, b4)
        const w = Math.min(b4[0]!, b4[1]!, b4[2]!, b4[3]!)
        if (w > bw) (bw = w), (best = e)
      }
    }
    return best
  }
  for (let i = 0; i < nv; i++) {
    if (skinSlot[i]! < 0) continue
    const e = slotTet.get(skinSlot[i]!) ?? neighbour(skinSlot[i]!, skin.positions[i * 3]!, skin.positions[i * 3 + 1]!, skin.positions[i * 3 + 2]!)
    if (e === undefined) continue
    barycentric(mesh.nodes, mesh.tets[e * 4]!, mesh.tets[e * 4 + 1]!, mesh.tets[e * 4 + 2]!, mesh.tets[e * 4 + 3]!, skin.positions[i * 3]!, skin.positions[i * 3 + 1]!, skin.positions[i * 3 + 2]!, b4)
    emb.tet[i] = e
    emb.bary.set(b4, i * 4)
    skinVol[e] = skinVol[e]! + area[i]! * opts.skinThickness
    embedded++
  }
  const tetVol = a ** 3 / 12
  for (let e = 0; e < T; e++) tetSkin[e] = Math.round(Math.min(1, skinVol[e]! / tetVol) * 255)

  // ── 锚点：骨穿过、但没有结点被钉住的四面体 / anchors: tetrahedra crossed by bone with no pinned node ──
  const anchorSum = new Map<number, number[]>()
  for (const p of rigid) {
    const m = body.meshes.get(p.id)
    if (!m) continue
    const pts = thinPoints(m.positions, a / 3)
    for (let i = 0; i < pts.length; i += 3) {
      const e = slotTet.get(locateSlot(lattice, pts[i]!, pts[i + 1]!, pts[i + 2]!))
      if (e === undefined) continue
      let pinned = false
      for (let k = 0; k < 4; k++) if (nodePin[mesh.tets[e * 4 + k]!]! >= 0) pinned = true
      if (pinned) continue
      const s = anchorSum.get(e) ?? [0, 0, 0, 0]
      s[0] = s[0]! + pts[i]!
      s[1] = s[1]! + pts[i + 1]!
      s[2] = s[2]! + pts[i + 2]!
      s[3] = s[3]! + 1
      anchorSum.set(e, s)
    }
  }
  const anchorTets = [...anchorSum.keys()].sort((x, y) => x - y)
  const anchors: PointSet = { tet: Uint32Array.from(anchorTets), bary: new Float32Array(anchorTets.length * 4) }
  anchorTets.forEach((e, i) => {
    const s = anchorSum.get(e)!
    barycentric(mesh.nodes, mesh.tets[e * 4]!, mesh.tets[e * 4 + 1]!, mesh.tets[e * 4 + 2]!, mesh.tets[e * 4 + 3]!, s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!, b4)
    anchors.bary.set(b4, i * 4)
  })

  // ── 结点的蒙皮权重：附近软部件顶点权重的反距离平均 / node skinning weights: inverse-distance mean of nearby soft-part vertices ──
  const src: number[] = [], srcAt: number[] = []
  for (const p of parts) {
    const bnd = bindingOf.get(p.id)
    if (bnd?.offset === undefined || !['skin', 'fat', 'muscle'].includes(p.tissue)) continue
    const m = body.meshes.get(p.id)
    if (!m) continue
    // 每隔几个顶点取一个，够密即可 / every few vertices is dense enough
    const step = Math.max(1, Math.round(m.positions.length / 3 / Math.max(200, (p.triangles / 2) * 0.15)))
    for (let i = 0; i < m.positions.length / 3; i += step) {
      if (!inRegion(m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!) && opts.region) continue
      src.push(m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!)
      srcAt.push(bnd.offset + i * 12)
    }
  }
  const index = new PointIndex(Float32Array.from(src), 0.02)
  const nodeInfluence = new Uint8Array(N * 12)
  const dvI = new DataView(nodeInfluence.buffer), dvR = new DataView(rigBin.buffer, rigBin.byteOffset, rigBin.byteLength)
  const I = new Int32Array(4), D = new Float64Array(4)
  const acc = new Map<number, number>()
  for (let i = 0; i < N; i++) {
    acc.clear()
    if (nodePin[i]! >= 0) acc.set(nodePin[i]!, 1)
    else {
      const k = index.nearest(mesh.nodes[i * 3]!, mesh.nodes[i * 3 + 1]!, mesh.nodes[i * 3 + 2]!, 4, I, D)
      for (let n = 0; n < k; n++) {
        const o = srcAt[I[n]!]!, w = 1 / (Math.sqrt(D[n]!) + 0.002)
        for (let c = 0; c < 4; c++) {
          const wt = rigBin[o + 8 + c]!
          if (wt) acc.set(dvR.getUint16(o + c * 2, true), (acc.get(dvR.getUint16(o + c * 2, true)) ?? 0) + (w * wt) / 255)
        }
      }
      if (!acc.size) acc.set(0, 1)
    }
    const top = [...acc.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, 4)
    const sum = top.reduce((s, e) => s + e[1], 0)
    let used = 0
    top.forEach(([j, w], c) => {
      const b = c === top.length - 1 ? 255 - used : Math.round((w / sum) * 255)
      used += b
      dvI.setUint16(i * 12 + c * 2, j, true)
      nodeInfluence[i * 12 + 8 + c] = b
    })
  }
  // 区域笼子切口上的结点：钉在权重最大的关节上 / nodes at the cuts of a regional cage: pinned to their joint of largest weight
  for (let i = 0; i < N; i++) if (regionPinned[i] && nodePin[i]! < 0) nodePin[i] = dvI.getUint16(i * 12, true)

  // 孤岛：按共用面连通的一块四面体里如果没有钉住的结点、也没有锚点，就没有东西拉住它（耳廓、发梢处的碎片）；
  // 把它的结点都钉在各自权重最大的关节上，随蒙皮运动。
  // Islands: a face-connected set of tetrahedra without a pinned node or an anchor is held by nothing (scraps at the
  // auricle or the hair); all its nodes are pinned to their joint of largest weight and move with the skinning.
  const parent = Int32Array.from({ length: T }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!
    return i
  }
  const faceOwner = new Map<string, number>()
  for (let e = 0; e < T; e++) for (let k = 0; k < 4; k++) {
    const f = [0, 1, 2, 3].filter((c) => c !== k).map((c) => mesh.tets[e * 4 + c]!).sort((x, y) => x - y).join(',')
    const o = faceOwner.get(f)
    if (o === undefined) faceOwner.set(f, e)
    else parent[find(e)] = find(o)
  }
  const held = new Uint8Array(T)
  for (let e = 0; e < T; e++) for (let k = 0; k < 4; k++) if (nodePin[mesh.tets[e * 4 + k]!]! >= 0) held[find(e)] = 1
  for (const e of anchorTets) held[find(e)] = 1
  let islandTets = 0
  for (let e = 0; e < T; e++) {
    if (held[find(e)]) continue
    islandTets++
    for (let k = 0; k < 4; k++) {
      const n = mesh.tets[e * 4 + k]!
      if (nodePin[n]! < 0) nodePin[n] = dvI.getUint16(n * 12, true)
    }
  }

  // 只属于刚性（骨）四面体的自由结点同样没有东西拉住：钉住 / free nodes that belong to rigid (bone) tetrahedra only are held by nothing either: pinned
  const soft = new Uint8Array(N)
  for (let e = 0; e < T; e++) if (!opts.materials[tetMaterial[e]!]!.rigid) for (let k = 0; k < 4; k++) soft[mesh.tets[e * 4 + k]!] = 1
  for (let i = 0; i < N; i++) if (!soft[i] && nodePin[i]! < 0) nodePin[i] = dvI.getUint16(i * 12, true)

  // ── 肌肉的纤维方向、长骨的胶囊 / fibre directions of muscles, capsules of long bones ──
  const lineOf = new Map(rig.muscles.map((m) => [m.part, m]))
  const muscles = muscleIds.map((pi) => {
    const id = parts[pi]!.id, l = lineOf.get(id)
    if (!l) return { part: id, fibre: null }
    const d = [l.insertion.point[0] - l.origin.point[0], l.insertion.point[1] - l.origin.point[1], l.insertion.point[2] - l.origin.point[2]]
    const n = Math.hypot(d[0]!, d[1]!, d[2]!)
    return { part: id, fibre: n > 1e-6 ? ([d[0]! / n, d[1]! / n, d[2]! / n] as [number, number, number]) : null }
  })
  const capsules: SoftData['capsules'] = []
  for (const p of rigid) {
    if (p.tissue !== 'bone') continue
    const m = body.meshes.get(p.id)
    if (!m || (opts.region && !inRegion(p.centroid[0], p.centroid[1], p.centroid[2]))) continue
    const n = m.positions.length / 3
    const c = [0, 0, 0]
    for (let i = 0; i < n * 3; i++) c[i % 3] = c[i % 3]! + m.positions[i]! / n
    const cov = new Float64Array(9)
    for (let i = 0; i < n; i++) for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) cov[r * 3 + s] = cov[r * 3 + s]! + ((m.positions[i * 3 + r]! - c[r]!) * (m.positions[i * 3 + s]! - c[s]!)) / n
    const ax = eigSym(cov, 3).vectors[2]!
    let lo = Infinity, hi = -Infinity
    const rad: number[] = []
    for (let i = 0; i < n; i++) {
      const dx = m.positions[i * 3]! - c[0]!, dy = m.positions[i * 3 + 1]! - c[1]!, dz = m.positions[i * 3 + 2]! - c[2]!
      const t = dx * ax[0]! + dy * ax[1]! + dz * ax[2]!
      lo = Math.min(lo, t)
      hi = Math.max(hi, t)
      rad.push(Math.hypot(dx - t * ax[0]!, dy - t * ax[1]!, dz - t * ax[2]!))
    }
    rad.sort((x, y) => x - y)
    const r = rad[Math.floor(rad.length * 0.5)]!
    // 只给细长的骨（长度 ≥ 8 cm，长径比 ≥ 6）：扁骨和不规则骨用胶囊代表不了，靠钉住的结点和锚点
    // long bones only (length ≥ 8 cm, aspect ≥ 6): flat and irregular bones cannot be stood for by a capsule and rely on pins and anchors
    if (hi - lo < 0.08 || hi - lo < 6 * r) continue
    const pt = (t: number): [number, number, number] => [c[0]! + ax[0]! * t, c[1]! + ax[1]! * t, c[2]! + ax[2]! * t]
    capsules.push({ part: p.id, joint: bindingOf.get(p.id)!.joint!, a: pt(lo + r), b: pt(hi - r), radius: r })
  }

  // ── 统计与输出 / statistics and output ──
  const byMaterial: CageStats['byMaterial'] = {}
  let filled = 0, rigidTets = 0
  for (let e = 0; e < T; e++) {
    const id = opts.materials[tetMaterial[e]!]!.id
    const m = (byMaterial[id] ??= { tets: 0, litres: 0 })
    m.tets++
    m.litres += (tetVol * tetFill[e]!) / 255 * 1000
    filled += (tetVol * tetFill[e]!) / 255
    let all = true
    for (let k = 0; k < 4; k++) if (nodePin[mesh.tets[e * 4 + k]!]! < 0) all = false
    if (all) rigidTets++
  }
  for (const m of Object.values(byMaterial)) m.litres = Math.round(m.litres * 100) / 100
  const arrays: SoftArrays = { nodes: mesh.nodes, tets: mesh.tets, tetSlot: mesh.slots, tetMaterial, tetFill, tetSkin, tetMuscle, nodePin, nodeInfluence, anchors, embedded: [{ part: skinPart.id, points: emb }] }
  const { json, bin } = encodeSoft({
    schema: 1,
    body: body.data.body,
    inputs: body.inputs,
    lattice,
    gravity: opts.gravity,
    joints: rig.joints.map((j) => j.id),
    materials: opts.materials,
    skin: { part: skinPart.id, thickness: opts.skinThickness, material: mat('skin') },
    muscles,
    capsules,
    cautions: [
      { zh: '笼子的单元比皮肤、皮下脂肪和细小的骨都粗：表面的力学分辨率就是单元大小，比单元小的压头得到的刚度不可靠。', en: 'A cage cell is coarser than skin, subcutaneous fat and slender bones: the mechanical resolution of the surface is the cell size, and stiffness under an indenter smaller than a cell is not reliable.' },
      { zh: '相距不到一个单元的两处体表（手指之间、上臂与胸壁、两大腿根部）共用四面体，力学上是连在一起的；没有自碰撞。', en: 'Two skin surfaces closer than one cell (between fingers, arm and chest wall, the roots of the thighs) share tetrahedra and are mechanically joined; there is no self-collision.' },
      { zh: '材料按部件归类，脏器之间和肌间隙的空间按所在区域归类；数值的出处和假设见 data/curated/softbody/materials.json。', en: 'Materials follow the parts, and space between viscera or muscles is classified by where it is; for sources and assumptions of the numbers see data/curated/softbody/materials.json.' },
    ],
  }, arrays)
  let pinned = 0
  for (let i = 0; i < N; i++) if (nodePin[i]! >= 0) pinned++
  const stats: CageStats = {
    cell: a, nodes: N, tets: T, pinnedNodes: pinned, rigidTets, islandTets, anchors: anchorTets.length,
    filledLitres: Math.round(filled * 1e5) / 100, cageLitres: Math.round(T * tetVol * 1e5) / 100, byMaterial,
    muscles: muscles.length, musclesWithFibre: muscles.filter((m) => m.fibre).length, capsules: capsules.length,
    skinVerticesEmbedded: embedded, skinVertices: nv, seconds: Math.round((performance.now() - t0) / 100) / 10,
  }
  return { json, bin, stats }
}
