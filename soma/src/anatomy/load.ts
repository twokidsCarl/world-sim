// Dataset loading: anatomy.json for the requested body (with fixture fallback) and the
// optional knowledge layer. Geometry (GLB) is loaded by the viewer.

import type { AnatomyData, NameEntry, Relation } from './types.ts'

export interface LoadedDataset {
  /** Directory under /anatomy actually used. */
  dataset: string
  /** URL of that directory, with trailing slash. */
  baseUrl: string
  data: AnatomyData
  names: Record<string, NameEntry> | null
  relations: Relation[] | null
  notices: string[]
}

/** Datasets with their own synthetic knowledge files (their FMA ids are not real). */
const SYNTHETIC = new Set(['fixture', 'stress'])
const ALLOWED = new Set(['male', 'female', 'fixture', 'stress'])

export function requestedDataset(search: string): string {
  const v = new URLSearchParams(search).get('body') ?? 'male'
  return ALLOWED.has(v) ? v : 'male'
}

/**
 * Fetch JSON, returning null for anything that is not a JSON document. The dev server
 * answers unknown paths with index.html and status 200, so a 200 alone proves nothing.
 */
export async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const text = await res.text()
    if (text.trimStart().startsWith('<')) return null
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function isAnatomyData(d: unknown): d is AnatomyData {
  const a = d as Partial<AnatomyData> | null
  return !!a && a.schema === 1 && Array.isArray(a.parts) && Array.isArray(a.systems) && !!a.trees
    && Array.isArray(a.trees.isa) && Array.isArray(a.trees.partOf)
}

export async function loadDataset(requested: string, root = `${import.meta.env.BASE_URL}anatomy/`): Promise<LoadedDataset> {
  const notices: string[] = []
  let dataset = requested
  let data = await fetchJson<unknown>(`${root}${dataset}/anatomy.json`)
  if (!isAnatomyData(data)) {
    if (dataset !== 'fixture') {
      notices.push(`未找到“${dataset}”人体数据，已改用内置示例数据（fixture，非真实解剖）。 Dataset "${dataset}" not found — showing the synthetic fixture.`)
      dataset = 'fixture'
      data = await fetchJson<unknown>(`${root}fixture/anatomy.json`)
    }
    if (!isAnatomyData(data)) {
      throw new Error(
        `没有可用的解剖数据。请先运行 bun tools/fixture/make-fixture.ts 生成示例数据。 No anatomy data at ${root}${dataset}/anatomy.json.`,
      )
    }
  }
  const kdir = SYNTHETIC.has(dataset) ? `${root}${dataset}/knowledge/` : `${root}knowledge/`
  const [names, relations] = await Promise.all([
    fetchJson<Record<string, NameEntry>>(`${kdir}names.json`),
    fetchJson<Relation[]>(`${kdir}relations.json`),
  ])
  return {
    dataset,
    baseUrl: `${root}${dataset}/`,
    data,
    names: names && typeof names === 'object' && !Array.isArray(names) ? names : null,
    relations: Array.isArray(relations) ? relations : null,
    notices,
  }
}
