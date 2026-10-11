export type EntityKind = 'protein' | 'dna' | 'rna' | 'glycan' | 'ligand' | 'ion' | 'lipid' | 'water'

export interface Entity {
  id: string
  description: string
  kind: EntityKind
}

export interface Chain {
  /** label_asym_id：文件里每个链实例唯一 / label_asym_id: unique per chain instance in the file */
  asymId: string
  authAsymId: string
  entity: number
  start: number
  count: number
  /**
   * 文件里的模型号。介观模型把不同的对象放在不同的模型里，链名会重复。
   * Model number in the file. Mesoscale models keep each object in its own model, and chain names repeat across them.
   */
  model: number
}

/** 组装体的一行：这些链，由这些算符各复制一份 / One row of an assembly: these chains, copied by each of these operators. */
export interface AssemblyGroup {
  chains: number[]
  /** 列主序 4x4 / column-major 4x4 */
  operators: Float32Array[]
}

export interface Assembly {
  id: string
  groups: AssemblyGroup[]
}

export const enum El {
  C = 0,
  N = 1,
  O = 2,
  S = 3,
  P = 4,
  Other = 5,
}

/** 解析后的结构：第一个模型的重原子，已去掉水 / A parsed structure: heavy atoms of the first model, waters removed. */
export interface Molecule {
  id: string
  title: string
  atomCount: number
  /** x、y、z，单位 Å / x, y, z in Å */
  pos: Float32Array
  element: Uint8Array
  /**
   * 每个球的半径（Å）。只有粗粒度模型才有：一个球代表一段残基。没有时按元素取原子半径。
   * Radius of each sphere in Å. Present only for coarse-grained models, where one sphere
   * stands for a stretch of residues; otherwise atoms take their element's radius.
   */
  radius?: Float32Array
  chainOf: Uint32Array
  /** 主链骨架原子为 1：蛋白质的 Cα 和核酸的 P / 1 for backbone trace atoms: protein Cα and nucleic acid P */
  isTrace: Uint8Array
  /** 链内的残基编号，只用来找残基级的描边 / residue number within its chain, used only to find residue-level outlines */
  residue: Int32Array
  chains: Chain[]
  entities: Entity[]
  /** assemblies[0] 始终是存档时的非对称单元 / assemblies[0] is always the asymmetric unit as deposited */
  assemblies: Assembly[]
}

export const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
