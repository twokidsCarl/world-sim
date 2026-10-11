/**
 * 结构与论文：按期刊和发布日期找最近公开的结构（RCSB），以及一个结构的主要引文。
 * 论文本身多数不是开放获取的，所以这里只取书目信息（标题、作者、期刊、年份、DOI）；
 * 摘要只在 Europe PMC 标明开放获取并带许可时才取。
 *
 * Structures and papers: the structures most recently released for a journal (RCSB), and the
 * primary citation of a structure. Most of the papers are not open access, so only bibliographic
 * facts are taken (title, authors, journal, year, DOI); an abstract is fetched only when Europe
 * PMC marks the paper open access with a licence.
 */
const UA = { 'User-Agent': 'limn/0.1 (molecular illustration; local research tool)' }

export interface Citation {
  title: string
  authors: string[]
  journal: string
  year: number | null
  doi: string
  pubmed: number | null
}

export interface Released {
  id: string
  title: string
  /** 发布日期，YYYY-MM-DD / release date, YYYY-MM-DD */
  released: string
  method: string
  resolution: number | null
  atoms: number
  citation: Citation | null
}

/** RCSB 里期刊的缩写（rcsb_primary_citation.rcsb_journal_abbrev 的取值）/ journal abbreviations as RCSB writes them (values of rcsb_primary_citation.rcsb_journal_abbrev) */
export const JOURNALS = ['Nature', 'Science', 'Cell', 'Nat Struct Mol Biol', 'Mol Cell', 'Nat Commun', 'Proc Natl Acad Sci U S A', 'Elife']

const GQL = `query($ids:[String!]!){entries(entry_ids:$ids){
  rcsb_id struct{title} exptl{method}
  rcsb_accession_info{initial_release_date}
  rcsb_entry_info{resolution_combined deposited_atom_count}
  rcsb_primary_citation{title journal_abbrev rcsb_journal_abbrev year pdbx_database_id_DOI pdbx_database_id_PubMed rcsb_authors}
}}`

function toReleased(e: any): Released {
  const c = e.rcsb_primary_citation
  return {
    id: String(e.rcsb_id).toUpperCase(),
    title: e.struct?.title ?? '',
    released: String(e.rcsb_accession_info?.initial_release_date ?? '').slice(0, 10),
    method: (e.exptl ?? []).map((x: any) => x.method).join(', '),
    resolution: e.rcsb_entry_info?.resolution_combined?.[0] ?? null,
    atoms: e.rcsb_entry_info?.deposited_atom_count ?? 0,
    citation: c?.title
      ? { title: c.title, authors: c.rcsb_authors ?? [], journal: c.rcsb_journal_abbrev ?? c.journal_abbrev ?? '', year: c.year ?? null, doi: c.pdbx_database_id_DOI ?? '', pubmed: c.pdbx_database_id_PubMed ?? null }
      : null,
  }
}

/** 若干结构的发布信息和主要引文 / release facts and primary citation for some entries */
export async function released(ids: string[]): Promise<Released[]> {
  if (ids.length === 0) return []
  const res = await fetch('https://data.rcsb.org/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', ...UA }, body: JSON.stringify({ query: GQL, variables: { ids: ids.map((i) => i.toUpperCase()) } }) })
  if (!res.ok) throw new Error(`RCSB 数据接口失败（HTTP ${res.status}）`)
  const json = (await res.json()) as { data?: { entries?: any[] } }
  return (json.data?.entries ?? []).filter(Boolean).map(toReleased)
}

/** 构造“某期刊、某日期之后发布”的检索请求 / build the search request for "this journal, released on or after this date" */
export function recentQuery(journal: string, since: string, rows: number) {
  return {
    query: {
      type: 'group', logical_operator: 'and',
      nodes: [
        { type: 'terminal', service: 'text', parameters: { attribute: 'rcsb_primary_citation.rcsb_journal_abbrev', operator: 'exact_match', value: journal } },
        { type: 'terminal', service: 'text', parameters: { attribute: 'rcsb_accession_info.initial_release_date', operator: 'greater_or_equal', value: since } },
      ],
    },
    return_type: 'entry',
    request_options: { paginate: { start: 0, rows }, sort: [{ sort_by: 'rcsb_accession_info.initial_release_date', direction: 'desc' }] },
  }
}

/**
 * 某期刊最近 `days` 天里发布的结构，新的在前。`now` 可传入以便测试。
 * Structures released for a journal in the last `days` days, newest first. `now` can be passed in for tests.
 */
export async function recent(journal: string, days = 90, rows = 60, now = new Date()): Promise<{ total: number; entries: Released[] }> {
  if (!JOURNALS.includes(journal)) throw new Error(`不支持的期刊：${journal}`)
  const since = new Date(now.getTime() - days * 86400_000).toISOString().slice(0, 10)
  const res = await fetch('https://search.rcsb.org/rcsbsearch/v2/query', { method: 'POST', headers: { 'Content-Type': 'application/json', ...UA }, body: JSON.stringify(recentQuery(journal, since, rows)) })
  if (res.status === 204) return { total: 0, entries: [] }
  if (!res.ok) throw new Error(`RCSB 搜索失败（HTTP ${res.status}）`)
  const json = (await res.json()) as { total_count?: number; result_set?: { identifier: string }[] }
  const ids = (json.result_set ?? []).map((r) => r.identifier)
  const info = await released(ids)
  const byId = new Map(info.map((x) => [x.id, x]))
  return { total: json.total_count ?? ids.length, entries: ids.map((i) => byId.get(i.toUpperCase())).filter((x): x is Released => !!x) }
}

/**
 * 论文是否开放获取；是的话带回许可和摘要。查不到或不开放时 abstract 为空。
 * Whether a paper is open access; if so, with its licence and abstract. The abstract is empty when the paper is not found or not open.
 */
export async function openAccess(doi: string): Promise<{ open: boolean; licence: string; abstract: string }> {
  const none = { open: false, licence: '', abstract: '' }
  if (!/^10\.\d{4,9}\/\S+$/.test(doi)) return none
  const res = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`DOI:"${doi}"`)}&resultType=core&format=json&pageSize=1`, { headers: UA }).catch(() => null)
  if (!res || !res.ok) return none
  const r = ((await res.json().catch(() => null)) as any)?.resultList?.result?.[0]
  // 只有明确标了开放获取并且带知识共享许可的，才把摘要拿来显示
  // an abstract is shown only when the record is marked open access and carries a Creative Commons licence
  if (!r || r.isOpenAccess !== 'Y' || !/^cc/i.test(String(r.license ?? ''))) return none
  return { open: true, licence: String(r.license).toUpperCase(), abstract: String(r.abstractText ?? '').replace(/<[^>]+>/g, '') }
}
