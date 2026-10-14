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
//   4b. 骨穿过的四面体里的锚点带一个权重 = 骨占四面体的体积比例（9 个采样点里落在骨内的个数）；求解器据此给锚点
//      一个有限的刚度，骨只擦过一角的四面体不再被整个拴死（刚度公式在 src/softbody/body.ts 的 anchorStiffness）。
//      The anchor of a tetrahedron crossed by bone carries a weight = the share of the tetrahedron taken by bone (the
//      number of its nine samples inside bone); the solver gives the anchor a finite stiffness from it, so a
//      tetrahedron merely grazed by bone is no longer tied down as a whole (formula: anchorStiffness in src/softbody/body.ts).
//   4c. 不跨气隙粘连：两个相邻四面体共用的面如果整个在体外（三个角点和面上的采样点都不在体内），它们在这个面上
//      不相连；一个格点周围的四面体按"经由体内的面相连"分成几组，每组各用自己的一份结点（结点分裂）。
//      手指之间、上臂与胸壁、两大腿之间、乳房下皱襞因此不再共用结点。一个四面体自己同时含有两侧组织时仍然粘着
//      （气隙比单元窄的地方），这只能靠更细的单元解决。
//      No gluing across an air gap: when the face shared by two tetrahedra lies wholly outside the body (its three
//      corners and the samples on it are all outside), the two are not connected through it; the tetrahedra around a
//      lattice node fall into groups "connected through faces inside the body" and each group gets its own copy of
//      the node (node splitting). Fingers, arm and chest wall, the two thighs and the fold under the breast thus stop
//      sharing nodes. A single tetrahedron holding tissue of both sides (a gap narrower than a cell) still glues
//      them; only finer cells cure that.
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
  /** 皮肤层的体积怎么分到四面体：'area'（缺省，第四阶段，按三角形面积细分）或 'vertex'（第三阶段，按顶点，只为对照）/ how the skin layer's volume is shared out: 'area' (default, phase 4, by subdivided triangle area) or 'vertex' (phase 3, by vertex; for comparison only) */
  skinShare?: 'area' | 'vertex'
  /** 已经建好的"是否在体内"判断（bodyInside 的结果），按需建区域笼子时复用，省掉大半时间 / a ready inside-the-body test (the result of bodyInside), reused when regional cages are built on demand: most of the time is saved */
  inBody?: (x: number, y: number, z: number) => boolean
}

export interface CageStats {
  cell: number
  nodes: number
  tets: number
  pinnedNodes: number
  rigidTets: number
  /** 为了不跨气隙粘连而分裂出来的结点数 / nodes created by splitting so that nothing is glued across an air gap */
  splitNodes: number
  /** 被体内组织包住、因而改判为体内的"体外"格点数 / lattice nodes judged outside but enclosed by tissue, and therefore reclassified as inside */
  filledVoids: number
  /** 被判为"在体外"的共用面数 / shared faces judged to lie outside the body */
  openFaces: number
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
  const inBody = opts.inBody ?? bodyInside(skin)
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
  // 区域笼子：格子要盖住整个区域盒子（与全身皮肤包围盒的交），而不只是盒内皮肤顶点的包围盒——否则小区域的笼子
  // 只有表面那片皮肤那么深，底下是空的、也没有钉住，压上去偏软。
  // A regional cage: the lattice must cover the whole region box (cut to the bounds of the whole skin), not just the
  // bounds of the skin vertices inside it; otherwise the cage of a small region is only as deep as its patch of skin,
  // with nothing below and nothing pinned, and it presses too soft.
  if (opts.region) for (let k = 0; k < 3; k++) {
    sb[k] = Math.min(sb[k]!, Math.max(opts.region[k]!, sbAll[k]!))
    sb[k + 3] = Math.max(sb[k + 3]!, Math.min(opts.region[k + 3]!, sbAll[k + 3]!))
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
  // 封闭的空洞填上：皮肤网格上有自相交的小褶子，射线奇偶性在那里判错，细笼子里会出现体内的"体外"口袋（前臂掌侧
  // 6 mm 深处就有一个，1.9 mm 的笼子在那里断开）。从格子边界出发沿 BCC 邻接把真正的体外结点走一遍，走不到的"体外"
  // 结点其实在体内，改归"其余软组织"。
  // Enclosed voids are filled: the skin mesh has small self-intersecting folds where ray parity goes wrong, leaving
  // pockets of "outside" inside the body in a fine cage (one lies 6 mm under the volar forearm, where a 1.9 mm cage
  // came apart). The true outside is walked from the lattice boundary along BCC adjacency; "outside" nodes it does
  // not reach are inside the body and are reclassified as "other soft tissue".
  let filledVoids = 0
  {
    const [nx, ny, nz] = lattice.dims
    const nc = (nx + 1) * (ny + 1) * (nz + 1), total = nc + nx * ny * nz
    const cls = new Uint32Array(total)
    for (let id = 0; id < total; id++) cls[id] = classOfNode(id)
    // 先做一次"闭运算"：8 个 BCC 邻居里至少 6 个在体内的"体外"结点改判为体内。皮肤自相交处的假空隙是通到体外的薄片，
    // 泛洪填不掉它，但它只有一个结点厚；真正的气隙（指缝、腋下）比这宽。
    // First a "closing": an "outside" node with at least 6 of its 8 BCC neighbours inside becomes inside. The false gap
    // at a self-intersection of the skin is a thin sheet open to the outside, which the flood fill cannot remove, but
    // it is one node thick; true air gaps (between fingers, the armpit) are wider.
    const flip: number[] = []
    for (let id = 0; id < total; id++) {
      if (cls[id] !== 0) continue
      let inside = 0
      if (id < nc) {
        const i = id % (nx + 1), j = Math.floor(id / (nx + 1)) % (ny + 1), k = Math.floor(id / ((nx + 1) * (ny + 1)))
        for (let c = 0; c < 8; c++) {
          const ci = i - (c & 1), cj = j - ((c >> 1) & 1), ck = k - (c >> 2)
          if (ci >= 0 && cj >= 0 && ck >= 0 && ci < nx && cj < ny && ck < nz && cls[nc + ci + nx * (cj + ny * ck)] !== 0) inside++
        }
      } else {
        const c = id - nc, i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / (nx * ny))
        for (let q = 0; q < 8; q++) if (cls[i + (q & 1) + (nx + 1) * (j + ((q >> 1) & 1) + (ny + 1) * (k + (q >> 2)))] !== 0) inside++
      }
      if (inside >= 6) flip.push(id)
    }
    for (const id of flip) {
      cls[id] = CLS.other
      nodeClass.set(id, CLS.other)
      filledVoids++
    }
    const seen = new Uint8Array(total)
    const stack: number[] = []
    const visit = (id: number): void => {
      if (seen[id] || cls[id] !== 0) return
      seen[id] = 1
      stack.push(id)
    }
    // 种子：格子最外一层的角点 / seeds: the corners of the outermost layer of the lattice
    for (let k = 0; k <= nz; k++) for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) if (i === 0 || j === 0 || k === 0 || i === nx || j === ny || k === nz) visit(i + (nx + 1) * (j + (ny + 1) * k))
    while (stack.length) {
      const id = stack.pop()!
      if (id < nc) {
        const i = id % (nx + 1), j = Math.floor(id / (nx + 1)) % (ny + 1), k = Math.floor(id / ((nx + 1) * (ny + 1)))
        // 角点的邻居：周围 8 个单元的中心，以及 6 个轴向的角点 / neighbours of a corner: the centres of the 8 cells round it and the 6 axial corners
        for (let c = 0; c < 8; c++) {
          const ci = i - (c & 1), cj = j - ((c >> 1) & 1), ck = k - (c >> 2)
          if (ci >= 0 && cj >= 0 && ck >= 0 && ci < nx && cj < ny && ck < nz) visit(nc + ci + nx * (cj + ny * ck))
        }
        if (i > 0) visit(id - 1)
        if (i < nx) visit(id + 1)
        if (j > 0) visit(id - (nx + 1))
        if (j < ny) visit(id + (nx + 1))
        if (k > 0) visit(id - (nx + 1) * (ny + 1))
        if (k < nz) visit(id + (nx + 1) * (ny + 1))
      } else {
        const c = id - nc, i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / (nx * ny))
        for (let q = 0; q < 8; q++) visit(i + (q & 1) + (nx + 1) * (j + ((q >> 1) & 1) + (ny + 1) * (k + (q >> 2))))
      }
    }
    for (let id = 0; id < total; id++) if (cls[id] === 0 && !seen[id]) {
      nodeClass.set(id, CLS.other)
      filledVoids++
    }
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
  const T = slots.length
  // ── 结点分裂（见文件头 4c）/ node splitting (header 4c) ──
  let splitNodes = 0, openFaces = 0
  {
    const N0 = mesh.nodes.length / 3
    const inside = new Uint8Array(N0)
    for (let i = 0; i < N0; i++) inside[i] = (nodeClass.get(mesh.latticeId[i]!) ?? 0) !== 0 ? 1 : 0
    // 每个四面体四个面对面的邻居；−1 = 没有，−2 = 有但面在体外 / the neighbour across each of the four faces; −1 = none, −2 = present but the face is outside the body
    const adj = new Int32Array(T * 4).fill(-1)
    const faceOwner = new Map<number, number>()
    const M = N0 + 1
    const nd = mesh.nodes
    for (let e = 0; e < T; e++) for (let k = 0; k < 4; k++) {
      const f = [0, 1, 2, 3].filter((c) => c !== k).map((c) => mesh.tets[e * 4 + c]!).sort((x, y) => x - y)
      const key = (f[0]! * M + f[1]!) * M + f[2]!
      const o = faceOwner.get(key)
      if (o === undefined) {
        faceOwner.set(key, e * 4 + k)
        continue
      }
      let open = inside[f[0]!]! + inside[f[1]!]! + inside[f[2]!]! > 0
      if (!open) {
        // 面上的 10 个采样点：重心、靠三个角、三条边的中点、边中点与重心之间 / ten samples on the face: centroid, near the corners, edge midpoints, between midpoints and centroid
        const a = f[0]! * 3, b = f[1]! * 3, c = f[2]! * 3
        const W = [[1, 1, 1], [4, 1, 1], [1, 4, 1], [1, 1, 4], [1, 1, 0], [1, 0, 1], [0, 1, 1], [2, 2, 1], [2, 1, 2], [1, 2, 2]]
        for (const w of W) {
          const t = w[0]! + w[1]! + w[2]!
          if (inBody((nd[a]! * w[0]! + nd[b]! * w[1]! + nd[c]! * w[2]!) / t, (nd[a + 1]! * w[0]! + nd[b + 1]! * w[1]! + nd[c + 1]! * w[2]!) / t, (nd[a + 2]! * w[0]! + nd[b + 2]! * w[1]! + nd[c + 2]! * w[2]!) / t)) {
            open = true
            break
          }
        }
      }
      if (!open) openFaces++
      adj[e * 4 + k] = open ? o >> 2 : -2
      adj[o] = open ? e : -2
    }
    const tetsOf: number[][] = Array.from({ length: N0 }, () => [])
    for (let e = 0; e < T; e++) for (let k = 0; k < 4; k++) tetsOf[mesh.tets[e * 4 + k]!]!.push(e * 4 + k)
    const extraPos: number[] = [], extraId: number[] = []
    const group = new Map<number, number>()
    for (let i = 0; i < N0; i++) {
      const inc = tetsOf[i]!
      if (inc.length < 2) continue
      group.clear()
      let groups = 0
      for (const start of inc) {
        if (group.has(start >> 2)) continue
        const gi = groups++
        const stack = [start]
        group.set(start >> 2, gi)
        while (stack.length) {
          const ec = stack.pop()!, e = ec >> 2, c = ec & 3
          // 含结点 i 的三个面 = 对着另外三个角的面 / the three faces containing node i = those opposite the other three corners
          for (let k = 0; k < 4; k++) {
            if (k === c) continue
            const o = adj[e * 4 + k]!
            if (o < 0 || group.has(o)) continue
            group.set(o, gi)
            let oc = 0
            for (let q = 0; q < 4; q++) if (mesh.tets[o * 4 + q] === i) oc = q
            stack.push(o * 4 + oc)
          }
        }
      }
      if (groups < 2) continue
      // 第 0 组留用原结点，其余各组各得一份 / group 0 keeps the node, every other group gets a copy
      const copy = new Int32Array(groups).fill(-1)
      for (const ec of inc) {
        const gi = group.get(ec >> 2)!
        if (gi === 0) continue
        if (copy[gi]! < 0) {
          copy[gi] = N0 + extraId.length
          extraPos.push(nd[i * 3]!, nd[i * 3 + 1]!, nd[i * 3 + 2]!)
          extraId.push(mesh.latticeId[i]!)
        }
        mesh.tets[ec] = copy[gi]!
      }
    }
    splitNodes = extraId.length
    if (splitNodes) {
      const nodes = new Float32Array((N0 + splitNodes) * 3)
      nodes.set(mesh.nodes)
      nodes.set(extraPos, N0 * 3)
      const ids = new Uint32Array(N0 + splitNodes)
      ids.set(mesh.latticeId)
      ids.set(extraId, N0)
      mesh.nodes = nodes
      mesh.latticeId = ids
    }
  }
  const N = mesh.nodes.length / 3
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
  const emb: PointSet = { tet: new Uint32Array(nv), bary: new Float32Array(nv * 4) }
  const b4 = [0, 0, 0, 0]
  const skinVol = new Float32Array(T)
  const embOk = new Uint8Array(nv)
  let embedded = 0
  // 落在被丢弃的四面体里的皮肤顶点：外推到共用格点的相邻四面体里（取最负的重心坐标最接近零的那个）
  // skin vertices inside a dropped tetrahedron: extrapolated from a kept neighbour sharing a lattice node (the one whose most negative barycentric coordinate is closest to zero)
  const nodeOfLattice = new Map<number, number[]>()
  mesh.latticeId.forEach((id, i) => {
    const l = nodeOfLattice.get(id)
    if (l) l.push(i)
    else nodeOfLattice.set(id, [i])
  })
  const tetsOfNode: number[][] = Array.from({ length: N }, () => [])
  for (let e = 0; e < T; e++) for (let k = 0; k < 4; k++) tetsOfNode[mesh.tets[e * 4 + k]!]!.push(e)
  const neighbour = (slot: number, x: number, y: number, z: number): number | undefined => {
    let best: number | undefined, bw = -Infinity
    for (const id of slotNodes(lattice, slot) ?? []) {
      for (const n of nodeOfLattice.get(id) ?? []) for (const e of tetsOfNode[n]!) {
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
    embOk[i] = 1
    embedded++
  }
  if (opts.skinShare === 'vertex') {
    // 第三阶段的做法，只为前后对照保留 / the phase-3 way, kept only for before/after comparison
    const p = skin.positions, idx = skin.indices
    for (let t = 0; t < idx.length; t += 3) {
      const i0 = idx[t]! * 3, i1 = idx[t + 1]! * 3, i2 = idx[t + 2]! * 3
      const ux = p[i1]! - p[i0]!, uy = p[i1 + 1]! - p[i0 + 1]!, uz = p[i1 + 2]! - p[i0 + 2]!, vx = p[i2]! - p[i0]!, vy = p[i2 + 1]! - p[i0 + 1]!, vz = p[i2 + 2]! - p[i0 + 2]!
      const ar = (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 6) * opts.skinThickness
      for (const v of [i0 / 3, i1 / 3, i2 / 3]) if (embOk[v]) skinVol[emb.tet[v]!] = skinVol[emb.tet[v]!]! + ar
    }
  } else {
    // 皮肤层的体积按三角形的面积分到四面体里：每个三角形切成边长不超过三分之一个单元的小块，每块的面积 × 厚度
    // 放进块中心沿内法线向里、皮肤厚度之内那些点所在的四面体。第三阶段以前按顶点分（顶点的面积 × 厚度全放进顶点
    // 所在的那一个四面体，再截到 1）：皮肤网格在前臂上边长中位数 26 mm，单元 2 mm 时压头下 1 cm 内只有两个四面体
    // 有皮肤，皮肤的 E·V 只剩应有的 0.1 %（4.3 mm 时 1 %），细笼子上等于没有皮肤。
    // The volume of the skin layer is shared out to tetrahedra by triangle area: every triangle is cut into pieces no
    // longer than a third of a cell, and the area × thickness of a piece goes to the tetrahedra holding the points
    // inward of its centre within the skin thickness. Up to phase 3 it went by vertex (a vertex's area × thickness all into the
    // one tetrahedron holding the vertex, then clipped at 1): the skin mesh has a median edge of 26 mm on the forearm, so
    // with 2 mm cells only two tetrahedra within 1 cm of a probe had skin and the skin's E·V was 0.1 % of what it should
    // be (1 % at 4.3 mm): the fine cages had no skin to speak of.
    shareSkinByArea(lattice, slotTet, skin, opts.skinThickness, skinVol, inRegion, [0, 1, 2].map((k) => Math.max(sb[k]!, opts.region ? opts.region[k]! : -Infinity) - a).concat([0, 1, 2].map((k) => Math.min(sb[k + 3]!, opts.region ? opts.region[k + 3]! : Infinity) + a)) as [number, number, number, number, number, number])
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
  const anchorWeight = new Float32Array(anchorTets.length)
  anchorTets.forEach((e, i) => {
    let bone = 0
    for (let k = 0; k < 9; k++) if ((votes[e]![k]! & 15) === CLS.bone) bone++
    // 九个采样点都没落在骨内（骨比采样间距细）：按半个采样点算 / none of the nine samples inside bone (bone thinner than the sampling): counted as half a sample
    anchorWeight[i] = Math.max(0.5, bone) / 9
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
    const eig = eigSym(cov, 3)
    const ax = eig.vectors[2]!
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
    // 还要是直的：弯的骨（肋骨、锁骨）表面有一部分贴着甚至穿过主轴，绕弦线的"胶囊"会把整片胸壁的组织挡住
    // （第一阶段乳房几乎不动，原因之一就是肋骨的胶囊）。直骨的表面离轴线都有一段距离：第 5 百分位 ≥ 中位数的 35%。
    // and straight: the surface of a curved bone (rib, clavicle) partly touches or crosses the principal axis, and a
    // "capsule" about its chord would block the tissue of the whole chest wall (rib capsules were one reason the
    // breast hardly moved in phase 1). The surface of a straight bone keeps its distance from the axis: 5th
    // percentile ≥ 35 % of the median.
    if (rad[Math.floor(rad.length * 0.05)]! < 0.35 * r) continue
    // 肋骨的主轴从弧的内侧经过，上面的判据拦不住它；再要求横截面两个方向的散布相近（中间特征值 ≤ 4 × 最小特征值）
    // the principal axis of a rib passes inside its arc, which the test above does not catch; the spread across the axis must also be similar in both directions (middle eigenvalue ≤ 4 × the smallest)
    if (eig.values[1]! > 4 * eig.values[0]!) continue
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
  const arrays: SoftArrays = { nodes: mesh.nodes, tets: mesh.tets, tetSlot: mesh.slots, tetMaterial, tetFill, tetSkin, tetMuscle, nodePin, nodeInfluence, anchors, anchorWeight, embedded: [{ part: skinPart.id, points: emb }] }
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
      { zh: '隔着气隙的两处体表（手指之间、上臂与胸壁、两大腿根部）不再共用结点；但气隙比一个四面体还窄的地方，同一个四面体里含有两侧的组织，仍然粘着。分开的表面之间没有碰撞：它们可以互相穿过。', en: 'Two skin surfaces across an air gap (between fingers, arm and chest wall, the roots of the thighs) no longer share nodes; where the gap is narrower than a tetrahedron, one tetrahedron still holds tissue of both sides and glues them. There is no contact between the separated surfaces: they can pass through each other.' },
      { zh: '材料按部件归类，脏器之间和肌间隙的空间按所在区域归类；数值的出处和假设见 data/curated/softbody/materials.json。', en: 'Materials follow the parts, and space between viscera or muscles is classified by where it is; for sources and assumptions of the numbers see data/curated/softbody/materials.json.' },
    ],
  }, arrays)
  let pinned = 0
  for (let i = 0; i < N; i++) if (nodePin[i]! >= 0) pinned++
  const stats: CageStats = {
    cell: a, nodes: N, tets: T, pinnedNodes: pinned, rigidTets, splitNodes, openFaces, filledVoids, islandTets, anchors: anchorTets.length,
    filledLitres: Math.round(filled * 1e5) / 100, cageLitres: Math.round(T * tetVol * 1e5) / 100, byMaterial,
    muscles: muscles.length, musclesWithFibre: muscles.filter((m) => m.fibre).length, capsules: capsules.length,
    skinVerticesEmbedded: embedded, skinVertices: nv, seconds: Math.round((performance.now() - t0) / 100) / 10,
  }
  return { json, bin, stats }
}

/**
 * 皮肤层的体积按三角形面积分到四面体（第四阶段）：每个三角形切成边长不超过三分之一个单元的小块，沿厚度再分几层
 * （层厚不超过四分之一个单元，细单元时皮肤不会全挤进同一层四面体），每份的面积 × 层厚放进"块中心沿内法线向里该层
 * 深度处"那一点所在的四面体。结果累加到 skinVol（m³，按四面体）。`box` 之外的三角形跳过。
 * The skin layer's volume shared out to tetrahedra by triangle area (phase 4): every triangle is cut into pieces no
 * longer than a third of a cell and into layers through the thickness (each at most a quarter of a cell, so with fine
 * cells the skin is not crammed into one layer of tetrahedra); each piece's area × layer thickness goes to the
 * tetrahedron holding the point that far inward of the piece's centre. Results are added to skinVol (m³, by
 * tetrahedron). Triangles outside `box` are skipped.
 */
export function shareSkinByArea(lattice: Lattice, slotTet: Map<number, number>, skin: { positions: ArrayLike<number>; indices: ArrayLike<number> }, thickness: number, skinVol: Float32Array | Float64Array, inRegion: (x: number, y: number, z: number) => boolean = () => true, box: [number, number, number, number, number, number] = [-Infinity, -Infinity, -Infinity, Infinity, Infinity, Infinity]): void {
  const a = lattice.cell
  const p = skin.positions, idx = skin.indices, spacing = a / 3, layers = Math.max(1, Math.ceil(thickness / (a / 4)))
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t]! * 3, i1 = idx[t + 1]! * 3, i2 = idx[t + 2]! * 3
    let out = false
    for (let k = 0; k < 3 && !out; k++) {
      const m0 = Math.min(p[i0 + k]!, p[i1 + k]!, p[i2 + k]!), m1 = Math.max(p[i0 + k]!, p[i1 + k]!, p[i2 + k]!)
      if (m1 < box[k]! || m0 > box[k + 3]!) out = true
    }
    if (out) continue
    const ux = p[i1]! - p[i0]!, uy = p[i1 + 1]! - p[i0 + 1]!, uz = p[i1 + 2]! - p[i0 + 2]!, vx = p[i2]! - p[i0]!, vy = p[i2 + 1]! - p[i0 + 1]!, vz = p[i2 + 2]! - p[i0 + 2]!
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx, cl = Math.hypot(cx, cy, cz)
    if (!(cl > 0)) continue
    // (b − a) × (c − a) 指向体外（与 computeNormals 同向），内法线取它的反向 / (b − a) × (c − a) points outward (as in computeNormals); the inward normal is its opposite
    const nx = -cx / cl, ny = -cy / cl, nz = -cz / cl
    const e = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(vx - ux, vy - uy, vz - uz))
    const k = Math.max(1, Math.ceil(e / spacing))
    const piece = ((cl / 2) * thickness) / (k * k * layers)
    for (let i = 0; i < k; i++) for (let j = 0; j < k - i; j++) for (let up = 0; up < 2; up++) {
      if (up && j >= k - i - 1) continue
      const s = (i + (up ? 2 : 1) / 3) / k, r = (j + (up ? 2 : 1) / 3) / k
      for (let l = 0; l < layers; l++) {
        const dz = ((l + 0.5) / layers) * thickness
        const x = p[i0]! + ux * s + vx * r + nx * dz, y = p[i0 + 1]! + uy * s + vy * r + ny * dz, z = p[i0 + 2]! + uz * s + vz * r + nz * dz
        if (!inRegion(x, y, z)) continue
        const te = slotTet.get(locateSlot(lattice, x, y, z))
        if (te !== undefined) skinVol[te] = skinVol[te]! + piece
      }
    }
  }
}
