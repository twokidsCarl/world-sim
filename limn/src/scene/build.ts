import type { Molecule } from '../mol/types'
import type { Draw, RenderItem } from '../render/Renderer'
import { atomColors, atomRadii, type Coloring } from '../style/assign'
import type { Annotation } from '../style/annotate'
import type { Tone } from '../style/palettes'

/** 残基编号可以为负；而 id 缓冲是无符号的 / Residue numbers can be negative; the id buffer is unsigned. */
const RESIDUE_OFFSET = 100_000

/**
 * 网格的各部分（细胞器）之间的线从不淡出：剖面上它们在同一个平面里，没有深度差，只能靠这条线分开。
 * Lines between the parts of a mesh (organelles) never fade: on a cut they lie in one plane with
 * no step in depth between them, and this line is all that separates them.
 */
const MESH_PART_SIZE = 1e9
/**
 * 拷贝总数不超过这个数的模型（一个病毒颗粒），膜才衬在后面；整个突触、整个细胞里有几百个小泡，
 * 都留在后面的话画面上到处是碎片。
 * Only in a model with no more copies than this (a single virion) does the membrane line the back;
 * a whole synapse or cell has hundreds of vesicles, and keeping them all behind litters the picture.
 */
const LINING_MAX = 20_000
/** 球数超过这个数的单份脂质当作一整张膜 / lipids in a single copy with more spheres than this count as a membrane in one piece */
const SHEET_MIN = 20_000

export interface Placement {
  /** 画该分子的哪个组装体 / which assembly of the molecule to draw */
  assembly: string
  /** 在组装体算符之后额外施加的变换（列主序 4x4） / extra transform applied after the assembly operators (column-major 4x4) */
  matrix?: Float32Array
  molecule: number
  /** 分子中心的世界坐标，用于景深层 / world position of the molecule's centre, for depth layers */
  center?: [number, number, number]
  /**
   * 介观模型：组装体里的每个拷贝本身就是一个分子，各自描边、各自归入景深层。
   * 脂质例外，整张膜共用一个编号，画成一片。
   * Mesoscale models: every copy in the assembly is a molecule of its own, outlined and
   * depth-layered separately. Lipids are the exception: the whole membrane shares one id
   * and reads as one sheet.
   */
  perCopy?: boolean
  /**
   * 名字匹配的实体不逐个描边（例如小泡里的几千个谷氨酸）。
   * Entities whose name matches are not outlined one by one (the thousands of glutamates in a vesicle, say).
   */
  merge?: RegExp
  /**
   * 一条纤维（如生成的 DNA）：所有拷贝共用分子编号、连成一条，但各自归入自己位置的景深层。
   * One fibre (generated DNA, say): every copy shares the molecule id and joins into one strand,
   * but each takes the depth layer of its own position.
   */
  strand?: boolean
  /** 切片的背面不切它：衬在里面的一层，空隙里露出的是它而不是白纸 / not cut at the back of a slab: a layer lining the inside, so that gaps show it and not paper */
  keepBack?: boolean
  /** 所有拷贝共用一个编号，彼此之间不画线（一整层蛋白读成一条带子）/ every copy shares one id, with no lines between them (a whole layer of protein reads as a band) */
  oneId?: boolean
  /** 名字匹配的实体衬在后面（同 keepBack，但只对这些实体）/ entities whose name matches line the back (as keepBack, for those entities only) */
  lining?: RegExp
  /**
   * 概念“小分子”：一大群小分子每个画成一粒这么大半径（Å）的圆点，各自描边。这是夸张：真实的分子小得多。
   * The concept "small molecule": each of a crowd of small molecules is drawn as one dot of this radius in Å, outlined on its own. This is an exaggeration: the real molecule is much smaller.
   */
  dots?: number
  /**
   * 概念“核酸”：珠子模型的纤维（每节一两个大珠子）收成中线上的一个球，粗细取真实的：双链 20 Å，单链 10 Å。
   * 模型里的珠子比真实的核酸粗一倍，画出来像一条条粗管子。
   * The concept "nucleic acid": a fibre given as beads (one or two large beads a piece) collapses to one sphere on its midline, of the real width: 20 Å for a duplex, 10 Å for a single strand.
   * The model's beads are twice as wide as real nucleic acid and draw as fat tubes.
   */
  trueFibre?: boolean
  /** 剖开时不切它（叠在密度图里的原子模型）/ left whole by a cut (an atomic model shown inside a density map) */
  noCut?: boolean
}

/** 一段原子在一个算符下的一份拷贝 / one run of atoms under one operator */
export interface Copy {
  start: number
  count: number
  /** 列主序 4x4 / column-major 4x4 */
  matrix: Float32Array
}

interface Group {
  runs: { start: number; count: number }[]
  operators: Float32Array[]
  lipid: boolean
  /**
   * 介观模型里不单独描边的东西：纤维的一节节片段、小分子。同一组的所有拷贝共用一个分子编号。
   * Things a mesoscale picture does not outline one by one: the segments of a fibre, small
   * molecules. All copies of such a group share one molecule id.
   */
  merged: boolean
  /**
   * 一大群小分子（小泡里的谷氨酸等）：除了共用编号，它们彼此之间也不画深度轮廓线，只留整群的外轮廓。
   * A crowd of small molecules (the glutamates in a vesicle, say): besides sharing an id, no depth contours are drawn among them, only the outline of the crowd.
   */
  fine: boolean
  /** 衬在后面：切片的背面不切它 / lines the back: not cut at the back of a slab */
  lined: boolean
  /**
   * 概念“核酸”：模型里一节节摆出来的纤维（DNA、RNA）。画成一条粗细均匀的线：各节之间不画线，只有深度差得多的地方（两股交叉）才画。
   * The concept "nucleic acid": a fibre the model lays out piece by piece (DNA, RNA). It is drawn as a strand of even width: no lines between pieces, only where depth differs a good deal (two strands crossing).
   */
  fibre: boolean
  /** 这一组的第一条链 / the first chain of the group */
  chainIndex: number
}

/**
 * 组装体按“画哪几段原子”归并：链相同的行合在一起，算符接起来。
 * An assembly grouped by which atoms are drawn: rows listing the same chains are merged
 * and their operators concatenated.
 */
function assemblyGroups(mol: Molecule, assembly: string, merge?: RegExp, lining?: RegExp): Group[] {
  const asm = mol.assemblies.find((a) => a.id === assembly) ?? mol.assemblies[0]!
  const byKey = new Map<string, Group>()
  const isLipid = (ci: number) => mol.entities[mol.chains[ci]!.entity]!.kind === 'lipid'
  // 脂质和其余的链分开成组：膜要画成一整片 / lipids are grouped apart from other chains: a membrane is drawn as one sheet
  const split = asm.groups.flatMap((g) => {
    const lipids = g.chains.filter(isLipid)
    if (lipids.length === 0) return [g]
    // 膜的每一小块常常挑不同的几种脂质；按单条链拆开，相同的链才能合并成一次绘制
    // each patch of a membrane often picks a different handful of lipids; splitting by single
    // chain lets identical chains merge into one draw
    const each = lipids.map((ci) => ({ ...g, chains: [ci] }))
    return lipids.length === g.chains.length ? each : [{ ...g, chains: g.chains.filter((ci) => !isLipid(ci)) }, ...each]
  })
  for (const g of split) {
    // 在缓冲里相邻的链共用一次绘制调用。
    // Chains that sit next to each other in the buffer share a draw call.
    const sorted = g.chains.slice().sort((a, b) => mol.chains[a]!.start - mol.chains[b]!.start)
    const runs: { start: number; count: number }[] = []
    for (const ci of sorted) {
      const c = mol.chains[ci]!
      const last = runs[runs.length - 1]
      if (last && last.start + last.count === c.start) last.count += c.count
      else runs.push({ start: c.start, count: c.count })
    }
    const key = runs.map((r) => r.start + ':' + r.count).join(',')
    const have = byKey.get(key)
    if (have) have.operators.push(...g.operators)
    else
      byKey.set(key, {
        runs, operators: g.operators.slice(), lipid: g.chains.every(isLipid),
        merged: g.chains.every((ci) => mol.chains[ci]!.count < 40) || g.chains.some((ci) => /\.fibers?\./i.test(mol.entities[mol.chains[ci]!.entity]!.description) || !!merge?.test(mol.entities[mol.chains[ci]!.entity]!.description)),
        chainIndex: sorted[0]!,
        fibre: g.chains.some((ci) => /\.fibers?\./i.test(mol.entities[mol.chains[ci]!.entity]!.description)),
        lined: !!lining && g.chains.some((ci) => lining.test(mol.entities[mol.chains[ci]!.entity]!.description)),
        fine: g.chains.every((ci) => mol.chains[ci]!.count < 40) || g.chains.some((ci) => !!merge?.test(mol.entities[mol.chains[ci]!.entity]!.description)),
      })
  }
  return [...byKey.values()]
}

/** 把解析后的结构变成可直接上 GPU 的缓冲和它的绘制列表 / Turn a parsed structure into GPU-ready buffers and its draw list. */
export function buildItem(mol: Molecule, coloring: Coloring, tone: Tone, place: Placement | Placement[], annotation?: Annotation | null): RenderItem {
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
  const places = Array.isArray(place) ? place : [place]
  const draws: Draw[] = []
  const byAssembly = new Map<string, Placement[]>()
  for (const p of places) byAssembly.set(p.assembly, [...(byAssembly.get(p.assembly) ?? []), p])
  let total = 0
  const plan: { g: Group; ps: Placement[] }[] = []
  for (const [assembly, ps] of byAssembly)
    for (const g of assemblyGroups(mol, assembly, ps[0]!.merge, ps[0]!.lining)) {
      plan.push({ g, ps })
      total += g.operators.length * ps.length
    }
  const data = new Float32Array(total * 16), iids = new Uint32Array(total * 2)
  // 概念“核酸”：把同一种纤维的各组按走向接成一条，每一小段一个编号（见 fibreSegments）
  // the concept "nucleic acid": the groups of one kind of fibre are joined into one run along its course, with an id per short stretch (see fibreSegments)
  const segments = fibreSegments(mol, plan.filter((x) => x.g.fibre && x.ps.length === 1 && x.ps[0]!.perCopy && !x.ps[0]!.matrix).map((x) => x.g))
  let o = 0, copy = 0
  for (const { g, ps } of plan) {
    const first = o
    const groupCopy = copy
    // 这一组原子的质心，用来给每个拷贝一个中心 / centroid of the group's atoms, giving each copy a centre
    const c = [0, 0, 0]
    if (ps.some((p) => p.perCopy || p.strand)) {
      let n = 0
      for (const r of g.runs) {
        const step = Math.max(1, Math.floor(r.count / 200))
        for (let i = r.start; i < r.start + r.count; i += step) {
          c[0]! += mol.pos[i * 3]!
          c[1]! += mol.pos[i * 3 + 1]!
          c[2]! += mol.pos[i * 3 + 2]!
          n++
        }
      }
      for (let k = 0; k < 3; k++) c[k]! /= Math.max(1, n)
    }
    // 概念“小分子”：这一组的原子收成质心上的一粒圆点 / the concept "small molecule": the atoms of this group collapse into one dot at their centroid
    const dots = g.fine && !g.lipid && !g.fibre && ps.every((p) => p.perCopy && p.dots) ? ps[0]!.dots! : 0
    if (dots) {
      let firstAtom = true
      for (const r of g.runs)
        for (let i = r.start; i < r.start + r.count; i++) {
          posr[i * 4] = c[0]!
          posr[i * 4 + 1] = c[1]!
          posr[i * 4 + 2] = c[2]!
          posr[i * 4 + 3] = firstAtom ? dots : 0.01
          firstAtom = false
        }
    }
    if (g.fibre && ps.every((p) => p.perCopy && p.trueFibre) && g.runs.every((r) => r.count <= 2)) {
      const beads = g.runs.reduce((n, r) => n + r.count, 0)
      let firstAtom = true
      for (const r of g.runs)
        for (let i = r.start; i < r.start + r.count; i++) {
          posr[i * 4] = c[0]!
          posr[i * 4 + 1] = c[1]!
          posr[i * 4 + 2] = c[2]!
          posr[i * 4 + 3] = firstAtom ? (beads >= 2 ? 10 : 5) : 0
          firstAtom = false
        }
    }
    for (const p of ps)
      for (const op of g.operators) {
        const m = p.matrix ? mul(p.matrix, op) : op
        const k = o * 16
        for (let r = 0; r < 3; r++) for (let col = 0; col < 4; col++) data[k + r * 4 + col] = m[col * 4 + r]!
        const centre = p.center ?? (p.perCopy || p.strand ? ([m[0]! * c[0]! + m[4]! * c[1]! + m[8]! * c[2]! + m[12]!, m[1]! * c[0]! + m[5]! * c[1]! + m[9]! * c[2]! + m[13]!, m[2]! * c[0]! + m[6]! * c[1]! + m[10]! * c[2]! + m[14]!] as const) : null)
        if (p.noCut) data[k + 15] = 3
        // 用线段连起来的东西（核酸的走向）：按每个球、每段线自己的深度来切，不按整体的中心 / things joined by segments (the course of a nucleic acid) are cut sphere by sphere and segment by segment at their own depth, not by a centre of the whole
        else if (p.perCopy && mol.segments?.length) data[k + 15] = 5
        // 一整张不分块的膜（只有一份、球很多的脂质）：没有“整体的中心”可言，按球来切 / a membrane in one piece (lipids in a single copy with very many spheres) has no meaningful centre and is cut sphere by sphere
        // 概念“膜”：脂质一律按球来切（切口整齐），并在编号里标成膜；单个病毒颗粒的膜另外衬在后面
        // the concept "membrane": lipids are always cut sphere by sphere (a clean cut edge) and tagged as membrane in the ids; the membrane of a single virion lines the back besides
        else if (p.perCopy && g.lipid) data[k + 15] = total <= LINING_MAX ? 7 : 5
        else if (p.perCopy && g.fibre) data[k + 15] = 8
        else if (centre) {
          data[k + 12] = centre[0]
          data[k + 13] = centre[1]
          data[k + 14] = centre[2]
          // 2 = 纤维的片段：细，需要画得更粗才看得见 / 2 = a fibre segment: thin, drawn fatter to stay visible
          // 膜总是衬在后面：切片的背面不切它，里面的空处露出的是膜的内壁（按深度取深一号的色调），不是白纸
          // a membrane always lines the back: it is not cut at the back of a slab, so empty space inside shows its inner wall (in the deeper tone of its depth) and not paper
          data[k + 15] = p.keepBack || g.lined || (p.perCopy && g.lipid && total <= LINING_MAX) ? 6 : dots ? 1 : p.perCopy && g.fine && !g.lipid ? 4 : p.strand || (p.perCopy && g.merged && !g.lipid) ? 2 : 1
        }
        iids[o * 2] = copy * mol.chains.length
        // 同一种纤维的各组（模型按碱基种类分了组）共用一个编号，连成一条 / the groups of one kind of fibre (the model groups them by base) share one id and join into one strand
        iids[o * 2 + 1] = !p.perCopy || g.lipid || p.oneId ? p.molecule : segments.has(g) ? p.molecule + segments.get(g)![o - first]! : g.fibre ? p.molecule + 3_900_000 + mol.chains[g.chainIndex]!.entity : p.molecule + 1 + (g.merged && !dots ? groupCopy : copy)
        o++
        copy++
      }
    for (const r of g.runs) draws.push({ ...r, opStart: first, opCount: o - first })
  }
  return { posr, color: atomColors(mol, coloring, tone, annotation), ids, draws, instances: { count: total, data, ids: iids }, subunitSize: mol.triangles ? MESH_PART_SIZE : subunitSize(mol), segments: mol.segments, triangles: mol.triangles, solid: mol.solid }
}

/** 一段纤维有多长（Å）：每隔这么长换一个编号。取得很长，线上就没有横纹（他画的 DNA 是光滑的长线）；并排的两股仍然是不同的编号 / the length of a stretch of fibre in Å: the id changes this often. It is long, so a strand has no cross-marks (he paints DNA as a smooth long strand), while two strands side by side still have different ids */
const FIBRE_STRETCH = 2000

/**
 * 模型把一条纤维（比如整条染色体）按碱基种类拆成几组，每组里的各节是按走向排的，但组与组之间的先后丢了。
 * 这里给每一节一个编号：每组沿自己的走向每 FIBRE_STRETCH 换一个；后面的组经过前面的组走过的地方时沿用那里的编号
 * （模型里同一条双链的两股是两组，走向相反，不能简单地按顺序归并）。这样相邻的两股有不同的编号（中间画线），同一股上每隔一段有一道横纹。
 * 返回每组里每一节的编号（从 2,000,000 起，每种纤维错开 600,000）。
 *
 * A model splits one fibre (a whole chromosome, say) into several groups by base, each group's
 * pieces in order along the course but the order between groups lost. Every piece gets an id here:
 * each group changes id every FIBRE_STRETCH along its own course, and a later group passing where an
 * earlier one has been takes the id found there (the two strands of one duplex are two groups running
 * opposite ways, so a plain in-order merge will not do). The id thus changes every FIBRE_STRETCH, so that two strands lying side by side have different ids (and a line
 * between them) and one strand shows a cross-mark every so often. Returns the id of every piece of
 * every group (from 2,000,000, with 600,000 between kinds of fibre).
 */
export function fibreSegments(mol: Molecule, groups: Group[]): Map<Group, Uint32Array> {
  const out = new Map<Group, Uint32Array>()
  const byEntity = new Map<number, Group[]>()
  for (const g of groups) {
    const e = mol.chains[g.chainIndex]!.entity
    byEntity.set(e, [...(byEntity.get(e) ?? []), g])
  }
  let kind = 0
  for (const gs of byEntity.values()) {
    // 每一节的位置：这一组原子的质心经过各自的变换 / where each piece is: the centroid of the group's atoms under each transform
    const pos = gs.map((g) => {
      const c = [0, 0, 0]
      let n = 0
      for (const r of g.runs) for (let i = r.start; i < r.start + r.count; i++) {
        c[0]! += mol.pos[i * 3]!
        c[1]! += mol.pos[i * 3 + 1]!
        c[2]! += mol.pos[i * 3 + 2]!
        n++
      }
      const x = c[0]! / n, y = c[1]! / n, z = c[2]! / n
      const p = new Float32Array(g.operators.length * 3)
      g.operators.forEach((m, k) => {
        p[k * 3] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
        p[k * 3 + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
        p[k * 3 + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
      })
      return p
    })
    const ids = gs.map((g) => new Uint32Array(g.operators.length))
    const base = 2_000_000 + (kind++ % 3) * 600_000
    // 空间格子：每格记下第一个落进来的那一节的编号。后面的组（另一股、另一种碱基）经过同一个地方时沿用它，
    // 这样同一处的几组共用一个编号；找不到才按自己的走向另起编号。
    // A spatial grid: each cell remembers the id of the first piece to land in it. A later group (the
    // other strand, another base) passing the same place takes that id, so the groups share one id
    // where they coincide; only where none is found does a group number its own course afresh.
    const CELL = 28
    const grid = new Map<number, number[]>()
    const key = (x: number, y: number, z: number) => (Math.floor(x / CELL) + 4096) * 67108864 + (Math.floor(y / CELL) + 4096) * 8192 + (Math.floor(z / CELL) + 4096)
    let segment = 0
    gs.forEach((_, k) => {
      const p = pos[k]!
      let along = 0, own = segment++
      for (let i = 0; i < ids[k]!.length; i++) {
        const x = p[i * 3]!, y = p[i * 3 + 1]!, z = p[i * 3 + 2]!
        if (i > 0) {
          const d = Math.hypot(x - p[i * 3 - 3]!, y - p[i * 3 - 2]!, z - p[i * 3 - 1]!)
          along += d
          // 跳得很远说明换了一条新的纤维：另起一段 / a long jump means a new fibre has begun: start a new stretch
          if (along > FIBRE_STRETCH || d > 60) {
            own = segment++
            along = 0
          }
        }
        let found = -1, bd = CELL * CELL
        if (k > 0)
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
            const cell = grid.get(key(x + dx * CELL, y + dy * CELL, z + dz * CELL))
            if (!cell) continue
            for (let q = 0; q < cell.length; q += 4) {
              const d2 = (cell[q]! - x) ** 2 + (cell[q + 1]! - y) ** 2 + (cell[q + 2]! - z) ** 2
              if (d2 < bd) {
                bd = d2
                found = cell[q + 3]!
              }
            }
          }
        const id = found >= 0 ? found : own
        ids[k]![i] = base + (id % 590_000)
        const c = key(x, y, z)
        const cell = grid.get(c)
        if (!cell) grid.set(c, [x, y, z, id])
        else if (cell.length < 16) cell.push(x, y, z, id)
      }
    })
    gs.forEach((g, k) => out.set(g, ids[k]!))
  }
  return out
}

/**
 * 组装体展开后的每一份拷贝（做几何计算用；渲染不走这里）。
 * Every copy of an expanded assembly, for geometry; rendering does not go through this.
 */
export function assemblyCopies(mol: Molecule, assembly: string): Copy[] {
  const out: Copy[] = []
  for (const g of assemblyGroups(mol, assembly)) for (const matrix of g.operators) for (const r of g.runs) out.push({ ...r, matrix })
  return out
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

/** 所有算符都施加之后实际画出的原子数 / Atoms actually drawn once every operator is applied. */
export function placedAtomCount(mol: Molecule, assembly: string): number {
  let n = 0
  for (const g of assemblyGroups(mol, assembly)) for (const r of g.runs) n += r.count * g.operators.length
  return n
}

/** 默认显示的组装体：第一个生物学组装体，只要它不是特别大 / The assembly to show by default: the first biological one, if it is not enormous. */
export function defaultAssembly(mol: Molecule): string {
  return (mol.assemblies[1] ?? mol.assemblies[0]!).id
}

/**
 * 链的典型直径（Å），取自中位原子所属的那条链。含 n 个重原子的紧凑链直径约为
 * 3.3 n^(1/3) Å（1,100 个原子的珠蛋白约 34 Å）。
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
