/**
 * NeuroMorpho.Org 的检索：按物种、脑区、细胞类型找神经元形态重建。内容以 CC BY 4.0 发布，
 * 使用时要引用每个重建的原始论文，所以结果里带上 DOI。站方要求脚本访问表明身份，这里设了 User-Agent。
 *
 * Search of NeuroMorpho.Org: neuron reconstructions by species, brain region and cell type. Its
 * content is released under CC BY 4.0 and the original paper of each reconstruction is to be
 * cited, so results carry the DOI. The site asks scripted access to identify itself, hence the User-Agent.
 */
const UA = { 'User-Agent': 'limn/0.1 (molecular illustration; local research tool)' }

export interface NeuronHit {
  name: string
  archive: string
  species: string
  region: string
  cellType: string
  /** 重建了哪些部分，如 “Dendrites, Soma, No Axon” / which parts were reconstructed, e.g. "Dendrites, Soma, No Axon" */
  domain: string
  doi: string
}

const clean = (s: string) => s.replace(/[^A-Za-z0-9 _.\\-]/g, '').trim().slice(0, 60)

/** 构造检索地址：三个条件都可省，至少给一个 / build the search address: each of the three conditions is optional, at least one is given */
export function searchUrl(q: { species?: string; region?: string; cellType?: string }, size = 20): string | null {
  const parts = [q.species && `species:${clean(q.species)}`, q.region && `brain_region:${clean(q.region)}`, q.cellType && `cell_type:${clean(q.cellType)}`].filter((x): x is string => !!x && !x.endsWith(':'))
  if (parts.length === 0) return null
  const [first, ...rest] = parts
  return `https://neuromorpho.org/api/neuron/select?q=${encodeURIComponent(first!)}${rest.map((r) => `&fq=${encodeURIComponent(r)}`).join('')}&size=${size}&sort=neuron_id,asc`
}

export function readHits(json: any): { total: number; hits: NeuronHit[] } {
  const list: any[] = json?._embedded?.neuronResources ?? []
  const join = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''))
  return {
    total: Number(json?.page?.totalElements) || list.length,
    hits: list
      .filter((n) => n?.neuron_name && n?.archive)
      .map((n) => ({ name: String(n.neuron_name), archive: String(n.archive), species: String(n.species ?? ''), region: join(n.brain_region), cellType: join(n.cell_type), domain: String(n.domain ?? ''), doi: String((n.reference_doi ?? [])[0] ?? '') })),
  }
}

export async function searchNeurons(q: { species?: string; region?: string; cellType?: string }): Promise<{ total: number; hits: NeuronHit[] }> {
  const url = searchUrl(q)
  if (!url) return { total: 0, hits: [] }
  const res = await fetch(url, { headers: UA }).catch(() => null)
  if (!res?.ok) return { total: 0, hits: [] }
  return readHits(await res.json().catch(() => null))
}
