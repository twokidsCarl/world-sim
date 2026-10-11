import { El, type Chain, type Molecule } from './types'

/** 一个残基的球半径（Å）/ radius of one residue's sphere in Å */
const RESIDUE_RADIUS = 3.4
/** 脂质：每隔这么多个原子留一个 / lipids: keep one atom in this many */
const LIPID_STEP = 16
const LIPID_RADIUS = 3.2

/**
 * 粗粒度版本：蛋白每个残基一个球（Cα），核酸每个核苷酸一个球（P），脂质每个分子留三四个球。
 * 用于原子数超出绘制能力的整细胞模型。组装体和实体不变。
 *
 * A coarse version: one sphere per protein residue (its Cα), one per nucleotide (its P), and
 * three or four per lipid. For whole-cell models with more atoms than can be drawn. Assemblies
 * and entities are unchanged.
 */
export function coarsen(mol: Molecule): Molecule {
  const keep: number[] = []
  const chains: Chain[] = []
  const radius: number[] = []
  for (const ch of mol.chains) {
    const start = keep.length
    const kind = mol.entities[ch.entity]!.kind
    let trace = 0
    for (let i = ch.start; i < ch.start + ch.count; i++) if (mol.isTrace[i]) trace++
    if (kind !== 'lipid' && trace * 3 >= ch.count / 8) {
      // 有主链的链：只留主链原子 / a chain with a backbone: keep the backbone atoms only
      for (let i = ch.start; i < ch.start + ch.count; i++)
        if (mol.isTrace[i]) {
          keep.push(i)
          radius.push(RESIDUE_RADIUS)
        }
    } else {
      // 没有主链的（脂质、小分子、只有珠子的模型）：等间隔抽取，至少留一个
      // no backbone (lipids, small molecules, bead-only models): thin evenly, keep at least one
      const step = kind === 'lipid' ? LIPID_STEP : Math.max(1, Math.min(8, Math.floor(ch.count / 4)))
      for (let i = ch.start + Math.min(ch.count - 1, step >> 1); i < ch.start + ch.count; i += step) {
        keep.push(i)
        radius.push(step === 1 ? (mol.radius?.[i] ?? 1.6) : kind === 'lipid' ? LIPID_RADIUS : RESIDUE_RADIUS * Math.cbrt(step / 8))
      }
    }
    chains.push({ ...ch, start, count: keep.length - start })
  }
  const n = keep.length
  const pos = new Float32Array(n * 3), residue = new Int32Array(n), chainOf = new Uint32Array(n)
  chains.forEach((ch, ci) => chainOf.fill(ci, ch.start, ch.start + ch.count))
  keep.forEach((src, i) => {
    pos[i * 3] = mol.pos[src * 3]!
    pos[i * 3 + 1] = mol.pos[src * 3 + 1]!
    pos[i * 3 + 2] = mol.pos[src * 3 + 2]!
    residue[i] = mol.residue[src]!
  })
  return {
    ...mol,
    atomCount: n,
    pos,
    // 一个球一种颜色：按“非碳”处理 / one sphere, one colour: treated as non-carbon
    element: new Uint8Array(n).fill(El.N),
    radius: new Float32Array(radius),
    chainOf,
    isTrace: new Uint8Array(n).fill(1),
    residue,
    chains,
  }
}
