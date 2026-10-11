import { El, IDENTITY, type Chain, type Molecule } from './types'

/**
 * 读 PDB 格式（旧的定宽文本格式）里的 ATOM 行，得到一条或几条蛋白链。只为那些只提供这种格式的
 * 预测模型库（BFVD）准备：不读配体、不读组装体；B 因子一栏当作预测置信度 pLDDT。
 *
 * Reads the ATOM lines of a PDB-format file (the old fixed-width text format) into one or more
 * protein chains. It exists only for libraries of predicted models that offer nothing else
 * (BFVD): no ligands, no assemblies; the B-factor column is taken as the predicted confidence, pLDDT.
 */
export function parsePdb(text: string, id: string, minConfidence?: number): Molecule {
  const pos: number[] = [], element: number[] = [], isTrace: number[] = [], residue: number[] = [], confidence: number[] = [], chainOf: number[] = []
  const chains: Chain[] = []
  let cur: Chain | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith('ENDMDL')) break
    if (!line.startsWith('ATOM')) continue
    const alt = line[16]
    if (alt && alt !== ' ' && alt !== 'A') continue
    const sym = (line.slice(76, 78).trim() || line.slice(12, 14).trim().replace(/[0-9]/g, '')).toUpperCase()
    if (sym === 'H' || sym === 'D') continue
    const b = Number(line.slice(60, 66))
    if (minConfidence !== undefined && b < minConfidence) continue
    const x = Number(line.slice(30, 38)), y = Number(line.slice(38, 46)), z = Number(line.slice(46, 54))
    if (![x, y, z].every(Number.isFinite)) continue
    const chain = line[21]?.trim() || 'A'
    if (!cur || cur.asymId !== chain) {
      cur = { asymId: chain, authAsymId: chain, entity: 0, start: pos.length / 3, count: 0, model: 1 }
      chains.push(cur)
    }
    pos.push(x, y, z)
    element.push(sym === 'C' ? El.C : sym === 'N' ? El.N : sym === 'O' ? El.O : sym === 'S' || sym === 'SE' ? El.S : sym === 'P' ? El.P : El.Other)
    isTrace.push(line.slice(12, 16).trim() === 'CA' ? 1 : 0)
    residue.push(Number(line.slice(22, 26)) || 0)
    confidence.push(Number.isFinite(b) ? b : 0)
    chainOf.push(chains.length - 1)
    cur.count++
  }
  const n = pos.length / 3
  if (n === 0) throw new Error(`${id} 里没有读到原子 / no atoms read from ${id}`)
  return {
    id: id.toUpperCase(),
    title: '',
    atomCount: n,
    pos: new Float32Array(pos),
    element: new Uint8Array(element),
    chainOf: new Uint32Array(chainOf),
    isTrace: new Uint8Array(isTrace),
    residue: new Int32Array(residue),
    confidence: new Float32Array(confidence),
    chains,
    entities: [{ id: '1', description: id, kind: 'protein' }],
    assemblies: [{ id: 'asym', groups: [{ chains: chains.map((_, i) => i), operators: [IDENTITY] }] }],
  }
}
