import { El, IDENTITY, type Molecule } from '../mol/types'

/** 从 MDL molfile/SDF（V2000）读重原子，作为单链分子 / Read heavy atoms from an MDL molfile/SDF (V2000) as a one-chain molecule. */
export function parseSdf(text: string, id: string): Molecule {
  const lines = text.split(/\r?\n/)
  const counts = lines[3] ?? ''
  const n = Number(counts.slice(0, 3))
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${id} 的坐标文件无法解析`)
  const pos: number[] = [], element: number[] = []
  for (let i = 0; i < n; i++) {
    const l = lines[4 + i] ?? ''
    const sym = l.slice(31, 34).trim()
    if (sym === 'H' || sym === 'D' || !sym) continue
    pos.push(Number(l.slice(0, 10)), Number(l.slice(10, 20)), Number(l.slice(20, 30)))
    element.push(sym === 'C' ? El.C : sym === 'N' ? El.N : sym === 'O' ? El.O : sym === 'S' ? El.S : sym === 'P' ? El.P : El.Other)
  }
  const count = element.length
  if (count === 0) throw new Error(`${id} 没有原子`)
  return {
    id,
    title: id,
    atomCount: count,
    pos: new Float32Array(pos),
    element: new Uint8Array(element),
    chainOf: new Uint32Array(count),
    isTrace: new Uint8Array(count),
    residue: new Int32Array(count).fill(1),
    chains: [{ asymId: 'A', authAsymId: 'A', entity: 0, start: 0, count, model: 1 }],
    entities: [{ id: '1', description: 'phospholipid', kind: 'lipid' }],
    assemblies: [{ id: 'asym', groups: [{ chains: [0], operators: [IDENTITY] }] }],
  }
}

/** POPC（PDB 化学组分 POV），理想坐标，经本地服务器获取 / POPC (PDB chemical component POV), ideal coordinates, via the local server. */
export async function loadLipid(): Promise<Molecule> {
  const res = await fetch('/api/ligand/POV')
  if (!res.ok) throw new Error('下载脂质坐标失败')
  return parseSdf(await res.text(), 'POV')
}
