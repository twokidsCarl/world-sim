/**
 * 用户自己提供的拷贝数表。有些定量数据（例如 Wilhelm 等 2014 年测的突触小体里各种蛋白的拷贝数）
 * 不是开放获取的，不能放进仓库；有权限的人可以把表存成一个文本文件放在状态目录里，配方就会用它。
 *
 * 文件：<状态目录>/copy-numbers.tsv，每行“基因名<制表符或逗号>每个区室的拷贝数”，# 开头的是注释；
 * 第一条形如 “# volume_um3: 0.37” 的注释给出这些拷贝数对应的体积（立方微米），用来换算成浓度。
 *
 * A copy-number table supplied by the user. Some quantitative data (the copy numbers of proteins
 * in a synaptic bouton measured by Wilhelm et al. 2014, for one) is not open access and cannot be
 * in the repository; someone with access can save the table as a text file in the state directory,
 * and recipes will use it.
 *
 * The file: <state directory>/copy-numbers.tsv, one "gene<tab or comma>copies per compartment" per
 * line, lines starting with # being comments; a comment of the form "# volume_um3: 0.37" gives the
 * volume, in cubic microns, that the copy numbers refer to, which turns them into concentrations.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stateDir } from '../structures'

export interface CopyTable {
  /** 文件第一行注释里的说明，原样显示 / the note in the file's first comment line, shown as it is */
  label: string
  /** 这些拷贝数对应的体积（立方微米）；没给时为 null / the volume the copy numbers refer to, cubic microns; null when not given */
  volume: number | null
  /** 基因名（小写）→ 拷贝数 / gene name (lower case) -> copies */
  copies: Map<string, number>
}

export function parseCopyTable(text: string): CopyTable {
  const copies = new Map<string, number>()
  let label = '', volume: number | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      const v = /volume_um3\s*:\s*([\d.eE+-]+)/.exec(line)
      if (v && Number(v[1]) > 0) volume = Number(v[1])
      else if (!label) label = line.replace(/^#\s*/, '').slice(0, 160)
      continue
    }
    const [gene, value] = line.split(/[\t,;]/).map((x) => x.trim())
    const n = Number(String(value ?? '').replace(/\s/g, ''))
    if (gene && Number.isFinite(n) && n > 0) copies.set(gene.toLowerCase(), n)
  }
  return { label, volume, copies }
}

/** 拷贝数和体积（立方微米）→ 微摩尔浓度 / copies in a volume (cubic microns) -> micromolar */
export function copiesToMicromolar(copies: number, volumeUm3: number): number {
  // 1 立方微米 = 1e-15 升；除以阿伏伽德罗常数得摩尔数 / one cubic micron is 1e-15 litres; divide by Avogadro's number for moles
  return (copies / 6.022e23 / (volumeUm3 * 1e-15)) * 1e6
}

/** 状态目录里的拷贝数表；没有这个文件时返回 null / the copy-number table in the state directory, or null when there is no such file */
export async function copyTable(): Promise<CopyTable | null> {
  const text = await readFile(join(stateDir(), 'copy-numbers.tsv'), 'utf8').catch(() => '')
  if (!text) return null
  const t = parseCopyTable(text)
  return t.copies.size ? t : null
}
