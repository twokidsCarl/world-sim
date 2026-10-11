import type { SceneSpec } from './scene/spec'

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new Error('连不上本地服务。用 bun run dev 同时启动网页和服务。')
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !json) throw new Error(json?.error ?? `本地服务出错（HTTP ${res.status}）`)
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

/** 膜蛋白的 OPM 取向；没有或服务不可用时为 null / a membrane protein's OPM orientation; null when there is none or the service is down */
export async function membrane(pdbId: string): Promise<import('./landscape/orient').OpmData | null> {
  try {
    const res = await fetch(`/api/membrane/${pdbId}`)
    return res.ok ? ((await res.json()) as { orientation: import('./landscape/orient').OpmData | null }).orientation : null
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
export async function alphafold(accession: string): Promise<{ accession: string; url: string; confident: number } | null> {
  try {
    const res = await fetch(`/api/alphafold/${accession}`)
    return res.ok ? ((await res.json()) as { prediction: { accession: string; url: string; confident: number } | null }).prediction : null
  } catch {
    return null
  }
}
