/**
 * PaxDb：各物种、各组织的蛋白丰度（整合了多项质谱研究），单位是 ppm——每一百万个蛋白分子里有几个是它。
 * 用它代替模型凭印象给的浓度。数据文件运行时下载并缓存，不入库。
 *
 * PaxDb: protein abundance per organism and tissue, integrated over many mass-spectrometry
 * studies, in ppm: how many of every million protein molecules are this one. It replaces the
 * concentrations a language model would give from memory. Files are downloaded at run time
 * and cached; none is in the repository.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stateDir } from '../structures'

export interface Abundances {
  /** 数据集的名字，如 “E.coli … Whole organism (Integrated)” / the dataset's own name */
  name: string
  taxid: number
  tissue: string
  /** 基因名（小写）→ ppm / gene name (lower case) -> ppm */
  ppm: Map<string, number>
}

const BASE = 'https://pax-db.org/downloads/latest/datasets'

/** 解析 PaxDb 的数据文件：# 开头的是说明，其余每行是 基因名、STRING 编号、丰度 / parse a PaxDb file: lines starting with # are metadata, the rest are gene name, STRING id, abundance */
export function parsePaxdb(text: string, taxid: number, tissue: string): Abundances {
  const ppm = new Map<string, number>()
  let name = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) {
      if (line.startsWith('#name:')) name = line.slice(6).trim()
      continue
    }
    const [gene, , value] = line.split('\t')
    const v = Number(value)
    if (!gene || !Number.isFinite(v)) continue
    // 同名基因（少见）取较大的一个 / when a gene name repeats (rare), keep the larger value
    const k = gene.toLowerCase()
    if (v > (ppm.get(k) ?? -1)) ppm.set(k, v)
  }
  return { name, taxid, tissue, ppm }
}

/**
 * 某物种某组织的整合数据集；没有这个组织时退回全生物体；PaxDb 没有这个物种时返回 null。
 * The integrated dataset for an organism and tissue, falling back to the whole organism when
 * the tissue is missing; null when PaxDb does not cover the organism.
 */
export async function abundances(taxid: number, tissue = 'WHOLE_ORGANISM'): Promise<Abundances | null> {
  if (!Number.isInteger(taxid) || taxid <= 0) return null
  const clean = tissue.toUpperCase().replace(/[^A-Z_]/g, '') || 'WHOLE_ORGANISM'
  for (const t of clean === 'WHOLE_ORGANISM' ? [clean] : [clean, 'WHOLE_ORGANISM']) {
    const file = `${taxid}-${t}-integrated.txt`
    const dir = join(stateDir(), 'paxdb')
    const path = join(dir, file)
    let text = await readFile(path, 'utf8').catch(() => '')
    if (!text) {
      const res = await fetch(`${BASE}/${taxid}/${file}`, { headers: { 'User-Agent': 'limn (local illustration tool)' } }).catch(() => null)
      if (!res || !res.ok) continue
      text = await res.text()
      if (!text.includes('#gene_name')) continue
      await mkdir(dir, { recursive: true })
      await writeFile(path, text)
    }
    const a = parsePaxdb(text, taxid, t)
    if (a.ppm.size > 0) return a
  }
  return null
}

/**
 * 细胞里蛋白的平均分子量（道尔顿）。把 ppm 换成浓度时要用；随后各成分还会按区室的总密度整体缩放，
 * 所以它只影响“有实测丰度的成分”与“只有估计值的成分”之间的比例。
 * Mean mass of a protein in a cell, in daltons, needed to turn ppm into a concentration. Copy
 * numbers are afterwards rescaled to the compartment's total density, so this only affects
 * the ratio between ingredients with measured abundance and those with an estimate.
 */
export const MEAN_PROTEIN_DALTON = 40_000

/** ppm → 微摩尔浓度，给定该区室的大分子总浓度（g/L）/ ppm to micromolar, given the compartment's total macromolecule concentration in g/L */
export function ppmToMicromolar(ppm: number, densityGramPerLitre: number): number {
  return ppm * 1e-6 * (densityGramPerLitre / MEAN_PROTEIN_DALTON) * 1e6
}
