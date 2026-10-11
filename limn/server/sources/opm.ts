/**
 * OPM（Orientations of Proteins in Membranes）：膜蛋白在脂双层里的位置和取向。它给出预先摆好的坐标：
 * 膜法线沿 z，膜的正中在 z = 0，z 为正的一面是外侧（胞外、周质、腔内），z 为负的一面是内侧（胞质）。
 * 这里只取其中的 Cα 位置和疏水层的半厚度，网页端用它们把同一个结构叠合过去。数据运行时下载并缓存，不入库。
 *
 * OPM (Orientations of Proteins in Membranes): where a membrane protein sits in the bilayer and
 * which way it faces. It publishes pre-oriented coordinates: the membrane normal is z, the middle
 * of the membrane is z = 0, positive z is the outer side (extracellular, periplasmic, lumenal)
 * and negative z the inner, cytoplasmic side. Only the Cα positions and the half-thickness of the
 * hydrophobic slab are taken here; the web app superposes the same structure onto them. The data
 * is downloaded at run time and cached, and is not in the repository.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stateDir } from '../structures'

export interface Orientation {
  pdbId: string
  /** 疏水层的半厚度（Å）/ half the thickness of the hydrophobic slab, Å */
  half: number
  /** 每个 Cα 的键：作者链名:作者残基号 / one key per Cα: author chain id, colon, author residue number */
  keys: string[]
  /** 对应的坐标，x, y, z 连排，在 OPM 的膜坐标系里 / matching coordinates, x y z in a row, in OPM's membrane frame */
  xyz: number[]
}

/** 最多保留这么多个 Cα，足够定出一个刚体变换 / keep at most this many Cα atoms, plenty for a rigid fit */
const MAX_POINTS = 600

/** 解析 OPM 的 PDB 格式文件 / parse an OPM file in PDB format */
export function parseOpm(text: string, pdbId: string): Orientation | null {
  const m = /1\/2 of bilayer thickness:\s*([\d.]+)/.exec(text)
  const all: { key: string; p: [number, number, number] }[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('ATOM') || line.slice(12, 16).trim() !== 'CA') continue
    const alt = line[16]
    if (alt !== ' ' && alt !== 'A') continue
    const p: [number, number, number] = [Number(line.slice(30, 38)), Number(line.slice(38, 46)), Number(line.slice(46, 54))]
    if (!p.every(Number.isFinite)) continue
    all.push({ key: `${line[21]!.trim()}:${Number(line.slice(22, 26))}`, p })
  }
  if (!m || all.length < 10) return null
  const step = Math.max(1, Math.ceil(all.length / MAX_POINTS))
  const kept = all.filter((_, i) => i % step === 0)
  return { pdbId: pdbId.toUpperCase(), half: Number(m[1]), keys: kept.map((a) => a.key), xyz: kept.flatMap((a) => a.p) }
}

/** OPM 里这个 PDB 编号的取向；没有收录时返回 null / OPM's orientation of a PDB entry, or null when OPM does not have it */
export async function orientation(pdbId: string): Promise<Orientation | null> {
  const id = pdbId.toLowerCase()
  if (!/^[0-9][a-z0-9]{3}$/.test(id)) return null
  const dir = join(stateDir(), 'opm')
  const path = join(dir, `${id}.pdb`)
  let text = await readFile(path, 'utf8').catch(() => '')
  if (!text) {
    const res = await fetch(`https://opm-assets.storage.googleapis.com/pdb/${id}.pdb`, { headers: { 'User-Agent': 'limn (local illustration tool)' } }).catch(() => null)
    if (!res || !res.ok) return null
    text = await res.text()
    if (!text.includes('bilayer thickness')) return null
    await mkdir(dir, { recursive: true })
    await writeFile(path, text)
  }
  return parseOpm(text, id)
}
