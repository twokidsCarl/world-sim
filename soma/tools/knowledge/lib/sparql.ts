// Cached, polite access to the Wikidata Query Service and other HTTP sources.
// Every response is written under data/raw/knowledge/ (gitignored) so reruns are offline.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { CACHE_DIR } from './paths.ts'

export const USER_AGENT =
  'soma-anatomy-knowledge/0.1 (educational 3D anatomy browser; offline batch build; https://github.com/twokidsCarl/world-sim) bun-fetch'
const ENDPOINT = 'https://query.wikidata.org/sparql'

export interface FetchOptions {
  /** Ignore the cache and re-query. */
  refresh: boolean
  /** Fail instead of touching the network on a cache miss. */
  offline: boolean
}

export const stats = { cacheHits: 0, networkRequests: 0 }

let lastRequest = 0
async function throttle(minGapMs: number) {
  const wait = lastRequest + minGapMs - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequest = Date.now()
}

async function politeFetch(url: string, init: RequestInit, minGapMs: number): Promise<string> {
  let delay = 5000
  for (let attempt = 1; ; attempt++) {
    await throttle(minGapMs)
    stats.networkRequests++
    let res: Response | undefined
    let err: unknown
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) })
    } catch (e) {
      err = e
    }
    if (res?.ok) return await res.text()
    const status = res?.status
    const retryable = !res || status === 429 || (status !== undefined && status >= 500)
    if (!retryable || attempt >= 5) {
      const body = res ? (await res.text()).slice(0, 400) : String(err)
      throw new Error(`request failed (${status ?? 'network'}) after ${attempt} attempt(s): ${url}\n${body}`)
    }
    const retryAfter = Number(res?.headers.get('retry-after'))
    const pause = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay
    console.warn(`  retry ${attempt} after ${status ?? 'network error'}; waiting ${Math.round(pause / 1000)}s`)
    await new Promise((r) => setTimeout(r, pause))
    delay *= 2
  }
}

function cachePath(group: string, key: string, ext: string) {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 16)
  return resolve(CACHE_DIR, group, `${hash}.${ext}`)
}

export type Row = Record<string, string>

/** Runs a SELECT query; returns rows of plain strings (entity URIs shortened to their Q/P id). */
export async function sparql(group: string, query: string, opts: FetchOptions): Promise<Row[]> {
  const file = cachePath(`wikidata/${group}`, query, 'json')
  if (!opts.refresh && existsSync(file)) {
    stats.cacheHits++
    return JSON.parse(readFileSync(file, 'utf8')).rows as Row[]
  }
  if (opts.offline) throw new Error(`cache miss in --offline mode: ${file}`)
  if (process.env.KNOWLEDGE_VERBOSE) console.error(`  sparql ${group} (${query.length} chars)`)
  const text = await politeFetch(
    ENDPOINT,
    {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/sparql-results+json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ query }).toString(),
    },
    1100,
  )
  const json = JSON.parse(text) as {
    results: { bindings: Record<string, { type: string; value: string; 'xml:lang'?: string }>[] }
  }
  const rows: Row[] = json.results.bindings.map((b) => {
    const row: Row = {}
    for (const [k, v] of Object.entries(b)) {
      row[k] = v.type === 'uri' ? v.value.replace(/^http:\/\/www\.wikidata\.org\/(entity|prop\/direct)\//, '') : v.value
      if (v['xml:lang']) row[`${k}Lang`] = v['xml:lang']
    }
    return row
  })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ endpoint: ENDPOINT, fetchedAt: new Date().toISOString(), query, rows }))
  return rows
}

/** Cached GET of an arbitrary URL (MediaWiki API, static data files). */
export async function cachedGet(group: string, url: string, opts: FetchOptions, ext = 'json'): Promise<string> {
  const file = cachePath(group, url, ext)
  if (!opts.refresh && existsSync(file)) {
    stats.cacheHits++
    return readFileSync(file, 'utf8')
  }
  if (opts.offline) throw new Error(`cache miss in --offline mode: ${url}`)
  const text = await politeFetch(url, { headers: { 'User-Agent': USER_AGENT } }, 300)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return text
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
