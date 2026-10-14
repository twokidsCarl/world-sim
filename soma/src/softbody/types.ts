// 软组织笼子的数据格式（提议并入数据契约 src/anatomy/types.ts；在那之前这里是唯一的定义）。
// The data format of the soft-tissue cage (proposed for the data contract in src/anatomy/types.ts; until then this is
// its only definition).
//
// 这个目录里的模块 / Modules of this directory
//   lattice.ts  BCC 格子的拓扑 / topology of the BCC lattice
//   solver.ts   XPBD 求解器（CPU 参考实现）/ the XPBD solver (CPU reference)
//   body.ts     笼子数据的读写，接到绑定上的运行时对象 / reading and writing the cage, the run-time object tied to the rig
//   rest.ts     零重力参考形状的反解 / the inverse solve for the zero-gravity reference
//   press.ts    按压工具的接口 press()：细笼子上的准静态压入 / the interface of the pressing tool, press(): quasi-static indentation on a fine cage
//
// 留给空腔脏器的位置（还没有做）：管腔表面和每个器官的 filling 字段到了以后，空腔脏器是嵌在笼子里的薄壳加一条
// "包住的体积 / 压强"约束，与这里的结点体积约束同一种形式（Σ 体积 → 一个乘子）。数据格式里会多一个 hollow 段。
// The slot kept for hollow organs (not built): once lumen surfaces and a per-organ `filling` field arrive, a hollow
// organ is a thin shell embedded in the cage plus one "enclosed volume / pressure" constraint, of the same form as the
// nodal volume constraints here (Σ volumes → one multiplier). The data format will then gain a `hollow` section.
//
// 文件 / Files
//   /anatomy/<body>/soft.json   SoftData
//   /anatomy/<body>/soft.bin    小端二进制，各段的字节偏移在 SoftData.sections 里，每段按 4 字节对齐
//                               little-endian binary; byte offsets of the sections are in SoftData.sections, each
//                               section aligned to 4 bytes
//
// soft.bin 的各段（N = nodeCount，T = tetCount，A = anchorCount）/ Sections of soft.bin:
//   nodes          Float32 × 3N   笼子结点，静止姿势，米，与网格同一坐标系 / cage nodes, rest pose, metres, the meshes' frame
//   tets           Uint32 × 4T    四面体的结点下标，体积为正 / node indices of every tetrahedron, positive volume
//   tetSlot        Uint32 × T     四面体在 BCC 格子里的槽位（见 lattice.ts）：由它可以直接算出任意一点落在哪个四面体
//                                 the tetrahedron's slot in the BCC lattice (see lattice.ts): the tetrahedron containing
//                                 any point follows from it by arithmetic
//   tetMaterial    Uint8 × T      SoftData.materials 的下标 / index into SoftData.materials
//   tetFill        Uint8 × T      四面体落在体内的体积比例 × 255（笼子比身体略大；刚度和密度按它折减）
//                                 share of the tetrahedron inside the body × 255 (the cage is slightly larger than the
//                                 body; stiffness and density are scaled by it)
//   tetSkin        Uint8 × T      皮肤层占四面体体积的比例 × 255（皮肤太薄，不单独成层，按比例混入刚度）
//                                 share of the tetrahedron's volume taken by the skin layer × 255 (the skin is too thin
//                                 to be a layer of its own and is blended into the stiffness by this share)
//   tetMuscle      Uint16 × T     SoftData.muscles 的下标，0xFFFF = 不属于肌肉 / index into SoftData.muscles, 0xFFFF = none
//   nodePin        Int16 × N      结点钉在哪个关节（SoftData.joints 的下标），−1 = 自由结点
//                                 the joint a node is pinned to (index into SoftData.joints), −1 = free
//   nodeInfluence  12 字节 × N    与 rig.bin 相同：4 × uint16 关节下标（指向 SoftData.joints）+ 4 × uint8 权重（和为 255）
//                                 as rig.bin: 4 × uint16 joint indices (into SoftData.joints) + 4 × uint8 weights summing to 255
//   anchors        12 字节 × A    uint32 四面体 + 3 × uint16 重心坐标（÷ 65535，第四个 = 1 − 和）+ uint16 权重（÷ 65535，
//                                 骨占四面体的体积比例；0 = 旧文件，按 1 读）：四面体里骨所在的一点，跟随笼子的蒙皮位置
//                                 uint32 tetrahedron + 3 × uint16 barycentric (÷ 65535, the fourth = 1 − sum) + uint16
//                                 weight (÷ 65535, the share of the tetrahedron taken by bone; 0 = an old file, read as
//                                 1): a point of bone inside a tetrahedron, which follows the skinned cage
//   rest0          Int16 × 3N     （可选）零重力参考形状相对 nodes 的偏移，单位 REST0_UNIT 米
//                                 (optional) offset of the zero-gravity reference from `nodes`, in units of REST0_UNIT metres
//   embedded[i]    12 字节 × 顶点数  与 anchors 相同的编码（末尾两个字节不用）：部件的每个渲染顶点（GLB 解码顺序）所在的四面体和重心坐标
//                                 same encoding as anchors: tetrahedron and barycentric coordinates of every render
//                                 vertex of a part (GLB decode order)

import type { BodyId, Vec3 } from '../anatomy/types.ts'
import type { Lattice } from './lattice.ts'

export const REST0_UNIT = 2e-5
export const NO_MUSCLE = 0xffff
/** 落在体外的四面体的最小折减系数：刚度和质量不能为零 / floor of the fill factor: stiffness and mass must not vanish */
export const MIN_FILL = 0.03
/** 刚度折减系数的下限（高于质量的下限，见 body.ts 的 solverInput）/ floor of the fill factor for stiffness (above that for mass; see solverInput in body.ts) */
export const STIFF_FILL = 0.12

/** 求解器用的一种材料：线弹性常数 + 密度；非线性的说明见 data/curated/softbody/materials.json。 */
/** One material as the solver uses it: linear constants and density; for the nonlinearity see data/curated/softbody/materials.json. */
export interface SoftMaterial {
  id: string
  name: { zh: string; en: string }
  /** 小应变杨氏模量，帕 / small-strain Young's modulus, Pa */
  young: number
  poisson: number
  /** kg/m³ */
  density: number
  /** 肌肉：完全激活时的杨氏模量（横向），帕 / muscle: Young's modulus at full activation (across the fibres), Pa */
  youngActive?: number
  /** 肌肉：沿纤维方向额外的模量，帕 / muscle: extra modulus along the fibres, Pa */
  fibreYoung?: number
  /** 应变硬化系数 κ：Ψ_dev = μ/2·c + μκ/4·c²（c = I₁ − 3）；省略 = 0 / strain-stiffening coefficient κ: Ψ_dev = μ/2·c + μκ/4·c² (c = I₁ − 3); omitted = 0 */
  stiffening?: number
  /** 快的 Maxwell 支路：模量与 μ 之比、松弛时间（秒）；省略 = 没有 / the fast Maxwell branch: its modulus over μ and its relaxation time (s); omitted = none */
  branchRatio?: number
  branchTau?: number
  /**
   * Ogden 型偏量能（Mihai 等 2015 的写法，m_p 为整数，帕）：给出时它取代 neo-Hookean 的偏量部分，young/poisson 只定体积项 λ。
   * Ogden-type deviatoric energy (the form of Mihai et al. 2015, integer m_p, Pa): when given it replaces the neo-Hookean
   * deviatoric part, and young/poisson set the volume term λ only.
   */
  ogden?: { c: number[]; m: number[] }
  /** true = 不求解（骨：四个结点都钉住的四面体）/ true = not solved (bone: tetrahedra with four pinned nodes) */
  rigid?: boolean
}

export interface SoftSection {
  /** soft.bin 里的字节偏移 / byte offset in soft.bin */
  offset: number
  /** 元素个数（结点、四面体、锚点或顶点）/ number of elements (nodes, tetrahedra, anchors or vertices) */
  count: number
}

export interface SoftData {
  schema: 1
  body: BodyId
  /** 构建所用输入文件的哈希（键和算法与 rig-report.json 相同），运行时据此拒绝过期的数据。 */
  /** Hashes of the input files of the build (keys and algorithm as in rig-report.json); the runtime rejects stale data by them. */
  inputs: Record<string, string>
  lattice: Lattice
  nodeCount: number
  tetCount: number
  anchorCount: number
  /** 建模时的重力（发布的网格是这个重力下的平衡形状），m/s² / gravity at modelling time (the shipped meshes are the equilibrium under it), m/s² */
  gravity: Vec3
  /** nodePin 和 nodeInfluence 所指的关节 id，按下标；应与 rig.json 的 joints 顺序一致 / joint ids referred to by nodePin and nodeInfluence, by index; must match the order of rig.json's joints */
  joints: string[]
  materials: SoftMaterial[]
  /** 皮肤层：部件、厚度（米）、材料下标 / the skin layer: part, thickness (m), material index */
  skin: { part: string; thickness: number; material: number }
  /** 肌肉：部件 id 和纤维方向（作用线，静止姿势，单位向量；没有作用线的为 null）/ muscles: part id and fibre direction (line of action, rest pose, unit; null without a line) */
  muscles: { part: string; fibre: Vec3 | null }[]
  /** 长骨的胶囊代理（静止姿势），随所属关节移动 / capsule proxies of long bones (rest pose), moving with their joint */
  capsules: { part: string; joint: string; a: Vec3; b: Vec3; radius: number }[]
  sections: {
    nodes: SoftSection
    tets: SoftSection
    tetSlot: SoftSection
    tetMaterial: SoftSection
    tetFill: SoftSection
    tetSkin: SoftSection
    tetMuscle: SoftSection
    nodePin: SoftSection
    nodeInfluence: SoftSection
    anchors: SoftSection
    rest0?: SoftSection
  }
  /** 显式存盘的嵌入（至少有皮肤；其余部件的嵌入由 lattice + tetSlot 在加载时算出）/ embeddings stored explicitly (the skin at least; those of other parts are computed at load from lattice + tetSlot) */
  embedded: ({ part: string } & SoftSection)[]
  /** 这份笼子没有做到的事，给界面显示 / what this cage does not do, for display */
  cautions: { zh: string; en: string }[]
}
