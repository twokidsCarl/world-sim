/**
 * 结构文件的本地缓存：按地址从白名单里的主机下载一次，存在状态目录里，之后直接从本机读。
 * 结构是公开数据，不进 git；缓存只是为了不必每次都从外网取。
 *
 * A local cache of structure files: each is downloaded once from a host on the allowlist,
 * kept under the state directory, and served from disk afterwards. Structures are public
 * data and are not in git; the cache only saves fetching them from the internet every time.
 */
import { createHash } from 'node:crypto'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 运行时写数据的目录：托管时是 WORLD_SIM_STATE 指的目录，开发时是源码旁的 .cache。
 * Where run-time data is written: the directory named by WORLD_SIM_STATE when hosted, and
 * .cache next to the source while developing.
 */
export function stateDir(): string {
  return process.env.LIMN_CACHE || process.env.WORLD_SIM_STATE || join(import.meta.dirname, '..', '.cache')
}

/** 允许代为下载的主机 / hosts this server will download from on the page's behalf */
const ALLOWED = new Set(['models.rcsb.org', 'files.rcsb.org', 'mesoscope.scripps.edu', 'alphafold.ebi.ac.uk', 'raw.githubusercontent.com', 'neuromorpho.org', 'ftp.ebi.ac.uk', 'bossdb-open-data.s3.amazonaws.com'])
/**
 * 只提供 http、没有 https 的主机（YASARA 的下载站）。从这里取的只是坐标文本，解析之外不做别的；仍然只限这一个主机。
 * Hosts that serve http only and have no https (YASARA's download site). What is fetched there is
 * coordinate text, which is parsed and nothing else; the exception is still limited to this one host.
 */
const HTTP_ONLY = new Set(['download.yasara.org'])
const MAX_BYTES = 400_000_000

const pending = new Map<string, Promise<string>>()

/** 地址是否在白名单内 / whether a URL is on the allowlist */
export function allowed(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'https:' && ALLOWED.has(u.hostname)) || (u.protocol === 'http:' && HTTP_ONLY.has(u.hostname))
  } catch {
    return false
  }
}

/**
 * 返回缓存文件的路径，没有就先下载。同一个地址同时只下载一次。
 * Path of the cached file, downloading it first if needed. One URL is downloaded only once at a time.
 */
export function cached(url: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!allowed(url)) return Promise.reject(new Error(`不允许从这个地址下载 / downloading from this address is not allowed: ${url}`))
  const dir = join(stateDir(), 'structures')
  const path = join(dir, createHash('sha256').update(url).digest('hex').slice(0, 32))
  const running = pending.get(path)
  if (running) return running
  const job = (async () => {
    if (await stat(path).then((s) => s.size > 0, () => false)) return path
    await mkdir(dir, { recursive: true })
    const res = await fetcher(url, { headers: { 'User-Agent': 'limn (local illustration tool)' } })
    if (!res.ok) throw new Error(`下载失败 / download failed (HTTP ${res.status}): ${url}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.length === 0 || buf.length > MAX_BYTES) throw new Error(`文件大小不合理 / implausible file size (${buf.length} bytes): ${url}`)
    // 先写临时文件再改名，中途断掉不会留下半个文件 / write to a temporary file and rename, so an interrupted download leaves no partial file
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, buf)
    await rename(tmp, path)
    return path
  })().finally(() => pending.delete(path))
  pending.set(path, job)
  return job
}
