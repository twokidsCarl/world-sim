import type { Molecule } from '../mol/types'

/** 本地服务给出的注释（与 server/sources/annotations.ts 同形）/ annotation as the local service returns it (same shape as server/sources/annotations.ts) */
export interface Feature {
  kind: 'domain' | 'active' | 'binding' | 'site'
  name: string
  start: number
  end: number
}
export interface ProteinAnnotation {
  accession: string
  name: string
  features: Feature[]
  pathogenicity: number[] | null
}
export interface Annotation {
  chains: Record<string, { accession: string; segments: { from: number; to: number; unp: number }[] }>
  proteins: Record<string, ProteinAnnotation>
}

/**
 * 上色方式。role：按功能角色（默认）；confidence：按预测置信度 pLDDT；domains：按结构域；
 * sites：标出活性位点和结合位点；pathogenicity：按 AlphaMissense 预测的替换致病性。
 * How to colour. role: by functional role (the default); confidence: by predicted confidence,
 * pLDDT; domains: by domain; sites: active and binding sites picked out; pathogenicity: by
 * AlphaMissense's predicted pathogenicity of substitutions.
 */
export type ColorMode = 'role' | 'confidence' | 'domains' | 'sites' | 'pathogenicity'
export const COLOR_MODES: ColorMode[] = ['role', 'confidence', 'domains', 'sites', 'pathogenicity']
export const COLOR_MODE_LABEL: Record<ColorMode, string> = { role: '按功能角色', confidence: '按预测置信度（pLDDT）', domains: '按结构域', sites: '标出活性与结合位点', pathogenicity: '按突变致病性预测（AlphaMissense）' }

type LCH = [number, number, number]

/** 链上的残基号对应的 UniProt 位置；不在任何一段里则为 null / the UniProt position of a residue number on a chain; null when outside every mapped segment */
export function unpPosition(ann: Annotation, asymId: string, residue: number): number | null {
  const c = ann.chains[asymId]
  if (!c) return null
  for (const s of c.segments) if (residue >= s.from && residue <= s.to) return s.unp + (residue - s.from)
  return null
}

/** AlphaFold 通用的四档置信度颜色，调成平涂的色调 / AlphaFold's usual four confidence bands, in flat-wash tones */
export function confidenceLch(plddt: number): LCH {
  if (plddt >= 90) return [0.56, 0.15, 258]
  if (plddt >= 70) return [0.78, 0.1, 232]
  if (plddt >= 50) return [0.89, 0.14, 100]
  return [0.76, 0.15, 58]
}

/** 第 k 个结构域的颜色：色相按黄金角错开，相邻的不会相近 / the colour of domain k: hues stepped by the golden angle, so neighbours are never close */
export function domainLch(k: number): LCH {
  return [0.78, 0.13, (20 + k * 137.5) % 360]
}

/** 致病性 0（良性，蓝）到 1（致病，红），中间是浅灰 / pathogenicity from 0 (benign, blue) to 1 (pathogenic, red) through pale grey */
export function pathogenicityLch(v: number): LCH {
  const t = Math.max(0, Math.min(1, v))
  return t < 0.5 ? [0.74 + 0.14 * (t / 0.5), 0.11 * (1 - t / 0.5) + 0.01, 250] : [0.88 - 0.28 * ((t - 0.5) / 0.5), 0.01 + 0.19 * ((t - 0.5) / 0.5), 25]
}

export const SITE_LCH: Record<'active' | 'binding' | 'site', LCH> = { active: [0.6, 0.22, 25], binding: [0.62, 0.2, 320], site: [0.7, 0.17, 70] }
/** 没有被标注到的部分：浅灰 / whatever no annotation covers: pale grey */
export const PLAIN_LCH: LCH = [0.86, 0.015, 250]

/** 一个蛋白的结构域，按起点排序，供上色和图例用 / the domains of a protein in order of start, for colouring and for the legend */
export function domainsOf(p: ProteinAnnotation): Feature[] {
  return p.features.filter((f) => f.kind === 'domain').sort((a, b) => a.start - b.start)
}

/**
 * 某条链在某种上色方式下，每个残基号的颜色。返回 null 表示这条链没有可用的数据，照常按角色上色。
 * 结果是“残基号 → 颜色”的函数；颜色为 null 的残基也照常上色。
 *
 * The colour of each residue number of a chain under a colour mode. Null means the chain has no
 * usable data and is coloured by role as usual. The result maps residue number to colour;
 * residues that get null are coloured as usual too.
 */
export function chainPainter(mode: ColorMode, mol: Molecule, chain: number, ann: Annotation | null | undefined): ((atom: number) => LCH | null) | null {
  if (mode === 'role') return null
  const ch = mol.chains[chain]!
  if (mol.entities[ch.entity]!.kind !== 'protein') return null
  if (mode === 'confidence') {
    const b = mol.confidence
    return b ? (atom) => confidenceLch(b[atom]!) : null
  }
  if (!ann) return null
  const protein = ann.proteins[ann.chains[ch.asymId]?.accession ?? '']
  if (!protein) return null
  const pos = (atom: number) => unpPosition(ann, ch.asymId, mol.residue[atom]!)
  if (mode === 'domains') {
    const domains = domainsOf(protein)
    if (domains.length === 0) return null
    return (atom) => {
      const p = pos(atom)
      if (p === null) return PLAIN_LCH
      const k = domains.findIndex((d) => p >= d.start && p <= d.end)
      return k >= 0 ? domainLch(k) : PLAIN_LCH
    }
  }
  if (mode === 'sites') {
    const sites = protein.features.filter((f) => f.kind !== 'domain')
    if (sites.length === 0) return null
    return (atom) => {
      const p = pos(atom)
      if (p === null) return PLAIN_LCH
      // 活性位点优先于结合位点，再优先于其他 / active sites win over binding sites, which win over the rest
      for (const kind of ['active', 'binding', 'site'] as const) if (sites.some((s) => s.kind === kind && p >= s.start && p <= s.end)) return SITE_LCH[kind]
      return PLAIN_LCH
    }
  }
  const am = protein.pathogenicity
  if (!am) return null
  return (atom) => {
    const p = pos(atom)
    return p === null || am[p - 1] === undefined ? PLAIN_LCH : pathogenicityLch(am[p - 1]!)
  }
}
