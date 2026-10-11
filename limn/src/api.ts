import type { SceneSpec } from './scene/spec'
import { t, noteError } from './i18n'

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw noteError('error.noServer')
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !json) throw new Error(json?.error ?? t('error.serverHttp', { status: res.status }))
  return json
}

export async function health(): Promise<{ ok: boolean; claude: boolean }> {
  try {
    const res = await fetch('/api/health')
    return res.ok ? await res.json() : { ok: false, claude: false }
  } catch {
    return { ok: false, claude: false }
  }
}

export const resolve = (topic: string) => post<{ spec: SceneSpec; steps: string[] }>('/api/resolve', { topic })

export interface CritiqueReply {
  scores: { composition: number; color: number; line: number; depth: number; readability: number }
  overall: number
  comment: string
  edits: unknown[]
  done: boolean
}

export const critique = (body: {
  image: string; title: string; contents: string; settings: string; metrics: string; history: string; feedback: string; mode: 'molecule' | 'landscape'
}) => post<CritiqueReply>('/api/critique', body)

export const pickView = (body: { image: string; count: number; title: string; contents: string }) => post<{ index: number; reason: string }>('/api/pick-view', body)

/** 膜蛋白在膜里的取向数据：OPM 的，或者 PDBTM 的变换加 UniProt 拓扑；都没有或服务不可用时为 null / orientation data for a membrane protein: OPM's, or PDBTM's transformation with UniProt topology; null when there is neither or the service is down */
export async function membrane(pdbId: string): Promise<import('./landscape/orient').MembraneData | null> {
  try {
    const res = await fetch(`/api/membrane/${pdbId}`)
    return res.ok ? ((await res.json()) as import('./landscape/orient').MembraneData) : null
  } catch {
    return null
  }
}

/** 一个结构的逐残基注释；没有或服务不可用时为 null / per-residue annotation of a structure; null when there is none or the service is down */
export async function annotations(id: string): Promise<import('./style/annotate').Annotation | null> {
  try {
    const res = await fetch(`/api/annotations/${encodeURIComponent(id)}`)
    return res.ok ? ((await res.json()) as { annotation: import('./style/annotate').Annotation | null }).annotation : null
  } catch {
    return null
  }
}

/** AlphaFold 数据库里某个 UniProt 编号的预测模型 / the AlphaFold DB model for a UniProt accession */
export async function alphafold(accession: string): Promise<{ accession: string; url: string; confident: number; source: 'AlphaFold DB' | 'BFVD' } | null> {
  try {
    const res = await fetch(`/api/alphafold/${accession}`)
    return res.ok ? ((await res.json()) as { prediction: { accession: string; url: string; confident: number; source: 'AlphaFold DB' | 'BFVD' } | null }).prediction : null
  } catch {
    return null
  }
}

export interface Citation { title: string; authors: string[]; journal: string; year: number | null; doi: string; pubmed: number | null }
export interface Released { id: string; title: string; released: string; method: string; resolution: number | null; atoms: number; citation: Citation | null }

/** 某期刊最近发布的结构 / structures recently released for a journal */
export async function recent(journal: string, days: number): Promise<{ journals: string[]; total: number; entries: Released[] }> {
  const res = await fetch(`/api/recent?journal=${encodeURIComponent(journal)}&days=${days}`)
  const json = (await res.json().catch(() => null)) as ({ journals: string[]; total: number; entries: Released[] } & { error?: string }) | null
  if (!res.ok || !json) throw new Error(json?.error ?? t('server.down'))
  return json
}

/** 一个结构的主要引文；开放获取的论文带摘要 / a structure's primary citation, with the abstract when the paper is open access */
export async function citation(id: string): Promise<{ entry: Released | null; paper: { open: boolean; licence: string; abstract: string } | null } | null> {
  try {
    const res = await fetch(`/api/citation/${id}`)
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

export interface EmdbEntry { id: string; title: string; contour: number | null; voxel: number; dims: [number, number, number]; megabytes: number; pdb: string[]; resolution: number | null; url: string }

/** 一张电镜密度图的基本信息 / the basics of an electron-microscopy density map */
export async function emdb(n: string): Promise<EmdbEntry | null> {
  try {
    const res = await fetch(`/api/emdb/${n}`)
    return res.ok ? ((await res.json()) as { entry: EmdbEntry | null }).entry : null
  } catch {
    return null
  }
}

export interface PredictedComplex { id: string; name: string; iptm: number; parts: { accession: string; copies: number }[]; url: string }

/** 含有某个蛋白的预测复合物 / predicted complexes that contain a protein */
export async function complexes(accession: string): Promise<PredictedComplex[]> {
  try {
    const res = await fetch(`/api/complexes/${accession}`)
    return res.ok ? ((await res.json()) as { complexes: PredictedComplex[] }).complexes : []
  } catch {
    return []
  }
}

export interface NeuronHit { name: string; archive: string; species: string; region: string; cellType: string; domain: string; doi: string }

/** 检索 NeuroMorpho.Org / search NeuroMorpho.Org */
export async function neurons(q: { species: string; region: string; cellType: string }): Promise<{ total: number; hits: NeuronHit[] }> {
  try {
    const res = await fetch(`/api/neurons?species=${encodeURIComponent(q.species)}&region=${encodeURIComponent(q.region)}&cellType=${encodeURIComponent(q.cellType)}`)
    return res.ok ? await res.json() : { total: 0, hits: [] }
  } catch {
    return { total: 0, hits: [] }
  }
}

/** 两张图哪张更好 / which of two pictures is better */
export const compare = (body: { a: string; b: string; title: string; contents: string; mode: 'molecule' | 'landscape'; request?: string }) => post<{ better: 'A' | 'B' | 'same'; reason: string }>('/api/compare', body)
