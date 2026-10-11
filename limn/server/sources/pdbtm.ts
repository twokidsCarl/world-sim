/**
 * OPM 没有收录时的后备：PDBTM 给出把跨膜蛋白摆进膜坐标系的变换（法线沿 z、膜正中在 z = 0），
 * 但不说哪一面朝外。朝向由 UniProt 的拓扑注释来定：把标为“胞外”“腔内”等的残基放到外侧。
 * 核对过：对两个库都收录的结构（1BL8、2ZXE、3KG2），PDBTM 坐标系里各残基的 z 与 OPM 的只差一个正负号，
 * 数值相差 1-2 Å。PDBTM 的条款只允许非营利使用且不得修改，所以这里只在运行时查询、注明来源，不入库。
 *
 * The fallback when OPM lacks an entry: PDBTM gives the transformation that sets a transmembrane
 * protein into the membrane frame (normal along z, mid-membrane at z = 0) but not which face is
 * outside. That comes from UniProt's topology annotation: residues marked extracellular, lumenal
 * and the like go on the outer side. Checked: for structures both databases hold (1BL8, 2ZXE,
 * 3KG2) the z of every residue in PDBTM's frame differs from OPM's only in sign, and by 1-2 Å in
 * magnitude. PDBTM's terms allow non-profit use without modification only, so it is queried at
 * run time and credited, and nothing of it is in the repository.
 */
const UA = { 'User-Agent': 'limn/0.1 (molecular illustration; local research tool)' }

export interface PdbtmFrame {
  /** 列主序 4x4：结构自己的坐标 → 膜坐标系（哪面朝外未定）/ column-major 4x4: the structure's own coordinates -> the membrane frame (outer face undecided) */
  matrix: number[]
  half: number
}

/** 把 PDBTM 记录里的三行变换读成列主序 4x4 / read the three rows of a PDBTM record's transformation as a column-major 4x4 */
export function readPdbtm(entry: any): PdbtmFrame | null {
  const mem = entry?.additional_entry_annotations?.membrane
  const t = mem?.transformation_matrix
  const rows = [t?.rowx, t?.rowy, t?.rowz]
  if (!rows.every((r) => r && [r.x, r.y, r.z, r.t].every((v) => typeof v === 'number' && Number.isFinite(v)))) return null
  const [x, y, z] = rows
  const half = Math.hypot(mem.normal?.x ?? 0, mem.normal?.y ?? 0, mem.normal?.z ?? 0)
  return { matrix: [x.x, y.x, z.x, 0, x.y, y.y, z.y, 0, x.z, y.z, z.z, 0, x.t, y.t, z.t, 1], half: half > 5 && half < 40 ? half : 15 }
}

export async function pdbtm(pdbId: string): Promise<PdbtmFrame | null> {
  const id = pdbId.toLowerCase()
  if (!/^[0-9][a-z0-9]{3}$/.test(id)) return null
  const res = await fetch(`https://pdbtm.unitmp.org/api/v1/entry/${id}.json`, { headers: UA }).catch(() => null)
  if (!res || !res.ok) return null
  return readPdbtm(await res.json().catch(() => null))
}

/** UniProt 拓扑注释里的说法归为外侧或内侧；认不出的返回 null / sort UniProt's topology wording into outer or inner side; null when unrecognised */
export function sideOf(description: string): 'out' | 'in' | null {
  const d = description.toLowerCase()
  if (/extracellular|lumenal|periplasmic|vesicular|virion surface|intermembrane|perinuclear|exoplasmic/.test(d)) return 'out'
  if (/cytoplasmic|matrix|intravirion|nuclear|stromal|cytosolic/.test(d)) return 'in'
  return null
}

export interface Topology {
  /** label_asym_id → 链上哪些残基号（label_seq_id）在膜的哪一侧 / label_asym_id -> which residue numbers (label_seq_id) of the chain lie on which side of the membrane */
  [asym: string]: { from: number; to: number; side: 'out' | 'in' }[]
}

/** 一个 PDB 结构各条链的膜拓扑：SIFTS 把链对到 UniProt，再取那里的拓扑结构域 / the membrane topology of each chain of a PDB entry: SIFTS maps chains to UniProt, whose topological domains are then read */
export async function topology(pdbId: string): Promise<Topology> {
  const id = pdbId.toLowerCase()
  const out: Topology = {}
  const sifts: any = await fetch(`https://www.ebi.ac.uk/pdbe/api/mappings/uniprot_segments/${id}`, { headers: UA }).then((r) => (r.ok ? r.json() : null), () => null)
  const byAcc = sifts?.[id]?.UniProt ?? {}
  for (const [acc, v] of Object.entries<any>(byAcc)) {
    const entry: any = await fetch(`https://rest.uniprot.org/uniprotkb/${acc}.json?fields=ft_topo_dom`, { headers: UA }).then((r) => (r.ok ? r.json() : null), () => null)
    const domains = (entry?.features ?? [])
      .filter((f: any) => f.type === 'Topological domain')
      .map((f: any) => ({ start: f.location?.start?.value, end: f.location?.end?.value, side: sideOf(String(f.description ?? '')) }))
      .filter((d: any) => d.side && Number.isInteger(d.start) && Number.isInteger(d.end))
    if (domains.length === 0) continue
    for (const m of v.mappings ?? []) {
      const from = m.start?.residue_number, to = m.end?.residue_number, unp = m.unp_start
      if (![from, to, unp].every(Number.isInteger)) continue
      for (const d of domains) {
        // UniProt 位置区间换成这条链上的残基号区间，再截到这一段之内
        // a UniProt range becomes a range of residue numbers on this chain, clipped to the mapped segment
        const a = Math.max(from, d.start - unp + from), b = Math.min(to, d.end - unp + from)
        if (a <= b) (out[String(m.struct_asym_id)] ??= []).push({ from: a, to: b, side: d.side })
      }
    }
  }
  return out
}
