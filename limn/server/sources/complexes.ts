/**
 * EBI Complex Portal：人工整理的蛋白复合物及各亚基的份数。用来核对“一个复合物里每种亚基有几份”，
 * 这个数在把亚基丰度换成复合物丰度时要用。覆盖不全，查不到时调用方保持原来的做法。
 *
 * The EBI Complex Portal: hand-curated protein complexes with the copy number of each subunit.
 * It checks how many copies of each subunit a complex holds, the number needed to turn subunit
 * abundance into complex abundance. Coverage is partial; with no hit, callers keep what they did before.
 */
const UA = { 'User-Agent': 'limn/0.1 (molecular illustration; local research tool)' }

export interface CuratedComplex {
  id: string
  name: string
  organism: string
  /** UniProt 编号 → 份数（数据库没给时为 null）/ UniProt accession -> copies, or null when the database gives none */
  subunits: Record<string, number | null>
}

/** 读 Complex Portal 的“minValue: 7, maxValue: 7”写法 / read the Complex Portal's "minValue: 7, maxValue: 7" notation */
export function readStoichiometry(s: unknown): number | null {
  const m = /minValue:\s*(\d+)\s*,\s*maxValue:\s*(\d+)/.exec(String(s ?? ''))
  if (!m) return null
  const lo = Number(m[1]), hi = Number(m[2])
  return lo === hi && lo > 0 ? lo : null
}

export function readComplexPortal(json: any): CuratedComplex[] {
  const out: CuratedComplex[] = []
  for (const e of json?.elements ?? []) {
    const subunits: Record<string, number | null> = {}
    for (const i of e.interactors ?? []) {
      const acc = String(i.identifier ?? '')
      // 只要蛋白亚基；小分子、核酸的编号不是 UniProt 的格式 / protein subunits only; small molecules and nucleic acids do not carry UniProt-style ids
      if (/^[OPQ][0-9][A-Z0-9]{3}[0-9]$|^[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]$/.test(acc)) subunits[acc] = readStoichiometry(i.stochiometry)
    }
    if (Object.keys(subunits).length) out.push({ id: String(e.complexAC), name: String(e.complexName ?? ''), organism: String(e.organismName ?? '').split(';')[0]!.trim(), subunits })
  }
  return out
}

/** 含有某个蛋白的复合物 / complexes that contain a protein */
export async function curatedComplexes(accession: string): Promise<CuratedComplex[]> {
  const res = await fetch(`https://www.ebi.ac.uk/intact/complex-ws/search/${encodeURIComponent(accession)}?format=json&first=0&number=10`, { headers: UA }).catch(() => null)
  if (!res?.ok) return []
  return readComplexPortal(await res.json().catch(() => null))
}

/**
 * 一个结构里这些蛋白各有几条链，与数据库里哪个复合物的配比最吻合；返回那个复合物里每种亚基的份数的
 * 最大公约意义上的“一个复合物含几份这种亚基”。找不到吻合的返回 null。
 * Given how many chains of each protein a structure has, find the curated complex whose
 * stoichiometry fits best and return the copies of a given subunit per complex. Null when none fits.
 */
export function copiesPerComplex(found: CuratedComplex[], accession: string, chainsByAccession: Record<string, number>): { complex: CuratedComplex; copies: number } | null {
  let best: { complex: CuratedComplex; copies: number; score: number } | null = null
  for (const c of found) {
    const copies = c.subunits[accession]
    if (!copies) continue
    // 结构里出现的蛋白，有多少也在这个复合物里 / of the proteins in the structure, how many are also in this complex
    const shared = Object.keys(chainsByAccession).filter((a) => a in c.subunits).length
    const score = shared / Math.max(Object.keys(chainsByAccession).length, Object.keys(c.subunits).length)
    if (!best || score > best.score) best = { complex: c, copies, score }
  }
  return best && best.score >= 0.5 ? { complex: best.complex, copies: best.copies } : null
}
