import type { Role } from '../style/palettes'

/**
 * 可信度等级：实测（实验结构、真实位置）、整理（已发表的模型、数据库整理的数值）、预测、估计。
 * How far something can be trusted: measured (experimental structures, real positions), curated
 * (published models, database-curated values), predicted, or estimated.
 */
export type Tier = 'measured' | 'curated' | 'predicted' | 'estimated'

export const TIER_LABEL: Record<Tier, string> = { measured: '实测', curated: '整理的模型', predicted: '预测', estimated: '估计' }

/** 结构的坐标从哪来，以及有多可信 / Where a structure's coordinates come from, and how far they can be trusted. */
export interface SourceRef {
  /**
   * PDB id（如 "6VXX"）、AlphaFold 模型的 "AF-<UniProt accession>"，或目录 id
   * PDB id (e.g. "6VXX"), "AF-<UniProt accession>" for an AlphaFold model, or a catalogue id
   */
  id: string
  /** 'model'：目录里的现成介观模型 / 'model': a ready-made mesoscale model from the catalogue */
  kind: 'pdb' | 'alphafold' | 'model'
  /**
   * AlphaFold 和目录模型的下载 URL；PDB 条目按 id 获取
   * download URL for AlphaFold and catalogue models; PDB entries are fetched by id
   */
  url?: string
  /** 数据的许可、作者、论文和主页，显示在出处面板 / licence, authors, paper and home page, shown with the provenance */
  licence?: string
  attribution?: string
  citation?: string
  link?: string
  /** 可信度等级 / how far the content can be trusted */
  tier?: Tier
  title: string
  method: string
  resolution: number | null
  year: number | null
}

export interface EntitySpec {
  entityId: string
  role: Role
  /** 简短的显示名 / short display name */
  name: string
  description: string
  organism: string
}

/** 画面里的一个结构。一个机制是并排的几个面板 / One structure in the picture. A mechanism is several panels side by side. */
export interface PanelSpec {
  label: string
  source: SourceRef
  assembly: string
  entities: EntitySpec[]
  /** 为什么选这个结构，用主题解析的原话 / why this structure was chosen, in the resolver's words */
  reason: string
}

/**
 * 拥挤场景里的一种分子。`panel` 是 SceneSpec.panels 的下标。
 * One kind of molecule in a crowded scene. `panel` indexes SceneSpec.panels.
 */
export interface Ingredient {
  panel: number
  /** 在膜的上方、下方，或在膜内；没有膜的场景用 'below' / above or below the membrane, or in it; scenes without a membrane use 'below' */
  compartment: 'above' | 'membrane' | 'below'
  /** 按所述丰度，场景体积里有多少个拷贝 / how many copies the stated abundance gives in the scene's volume */
  copies: number
  /** 数量所依据的丰度，照模型所述原样记录 / the abundance the count came from, as the model stated it */
  abundance: string
  /** 即使丰度四舍五入为零，也至少显示一个 / always shown at least once even if the abundance rounds to zero */
  feature: boolean
  /** 丰度的来历：数据库里的实测值（curated），还是模型的估计 / where the abundance comes from: measured values in a database (curated), or the model's estimate */
  tier?: Tier
  /**
   * 用于膜蛋白：结构是跨膜的，还是只有立在膜一侧的那部分
   * （病毒刺突和受体的结构大多是这样的胞外域）。
   * For membrane proteins: whether the structure crosses the membrane, or is
   * only the part that stands on one side of it (most structures of viral
   * spikes and receptors are such ectodomains).
   */
  anchor?: 'spans' | 'above' | 'below'
  /** 已知时，链的哪一端在膜上 / which end of the chain is at the membrane, when known */
  terminus?: 'N' | 'C'
}

/** 以剖面画出的一片细胞。尺寸单位 Å / A slab of cell drawn in cross-section. Sizes in Å. */
export interface LandscapeSpec {
  width: number
  height: number
  depth: number
  membrane: boolean
  /** 膜的外侧（胞外、周质、腔内）在场景的上方还是下方 / whether the membrane's outer side (extracellular, periplasmic, lumenal) is up or down in the scene */
  outer?: 'above' | 'below'
  above: string
  below: string
  ingredients: Ingredient[]
  /**
   * 要画的 DNA：这一片里双螺旋的总长度（Å），以及这个数的来历。
   * DNA to draw: the total length of double helix in the slab, in Å, and where that figure comes from.
   */
  dna?: { length: number; basis: string }
}

export interface SceneSpec {
  topic: string
  kind: 'molecule' | 'complex' | 'virus' | 'gene' | 'mechanism' | 'landscape' | 'model'
  title: string
  caption: string
  panels: PanelSpec[]
  /** 读者应当知道的事：哪些是预测的、建模的或省略的 / things a reader should know: what is predicted, modelled or left out */
  notes: string[]
  /**
   * 介观模型：组装体的每个拷贝是一个分子，按全景的画法画。
   * A mesoscale model: every copy in the assembly is a molecule, drawn the way landscapes are.
   */
  mesoscale?: boolean
  /** 不逐个描边的实体名（正则）/ names of entities not outlined one by one (a regular expression) */
  merge?: string
  /** 主题解析选中了目录里的一个现成模型 / the resolver chose a ready-made model from the catalogue */
  catalog?: string
  /** kind 为 'landscape' 时才有 / present when kind is 'landscape' */
  landscape?: LandscapeSpec
}
