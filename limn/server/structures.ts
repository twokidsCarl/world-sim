/**
 * 结构文件的本地缓存：按地址从白名单里的主机下载一次，存在状态目录里，之后直接从本机读。
 * 结构是公开数据，不进 git；缓存只是为了不必每次都从外网取。
 *
 * A local cache of structure files: each is downloaded once from a host on the allowlist,
 * kept under the state directory, and served from disk afterwards. Structures are public
 * data and are not in git; the cache only saves fetching them from the internet every time.
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
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
const ALLOWED = new Set(['models.rcsb.org', 'files.rcsb.org', 'mesoscope.scripps.edu', 'alphafold.ebi.ac.uk', 'raw.githubusercontent.com', 'neuromorpho.org', 'ftp.ebi.ac.uk', 'bossdb-open-data.s3.amazonaws.com', 'zenodo.org'])
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
 * 返回缓存文件的路径，没有就先下载。同一个地址同时只下载一次。边下边写盘，不把整个文件放进内存。
 * `head` 只取文件开头这么多字节（一个几十 GB 的压缩包，要的东西在最前面时用）；`maxBytes` 放宽大小上限。
 *
 * Path of the cached file, downloading it first if needed. One URL is downloaded only once at a
 * time. The file is written to disk as it arrives rather than held in memory. `head` fetches only
 * that many bytes from the start (for an archive of tens of GB whose wanted part comes first);
 * `maxBytes` raises the size limit.
 */
export function cached(url: string, fetcher: typeof fetch = fetch, opts: { head?: number; maxBytes?: number } = {}): Promise<string> {
  if (!allowed(url)) return Promise.reject(new Error(`不允许从这个地址下载 / downloading from this address is not allowed: ${url}`))
  const dir = join(stateDir(), 'structures')
  const limit = opts.maxBytes ?? MAX_BYTES
  if (opts.head && opts.head > limit) return Promise.reject(new Error(`要取的开头部分超过了大小上限 / the leading part asked for exceeds the size limit: ${url}`))
  const path = join(dir, createHash('sha256').update(opts.head ? `${url}|head=${opts.head}` : url).digest('hex').slice(0, 32))
  const running = pending.get(path)
  if (running) return running
  const job = (async () => {
    if (await stat(path).then((s) => s.size > 0, () => false)) return path
    await mkdir(dir, { recursive: true })
    const res = await fetcher(url, { headers: { 'User-Agent': 'limn (local illustration tool)', ...(opts.head ? { Range: `bytes=0-${opts.head - 1}` } : {}) } })
    if (!res.ok) throw new Error(`下载失败 / download failed (HTTP ${res.status}): ${url}`)
    // 先写临时文件再改名，中途断掉不会留下半个文件 / write to a temporary file and rename, so an interrupted download leaves no partial file
    const tmp = `${path}.${process.pid}.tmp`
    const out = createWriteStream(tmp)
    let size = 0
    try {
      const reader = res.body?.getReader()
      for (;;) {
        const chunk = reader ? await reader.read() : { done: true as const, value: undefined }
        if (chunk.done) break
        size += chunk.value.length
        // 要了开头一段、服务器却把整个文件发来时，到够了就停 / when a leading part was asked for and the server sends the whole file anyway, stop once there is enough
        if (opts.head && size >= opts.head) {
          out.write(chunk.value.subarray(0, chunk.value.length - (size - opts.head)))
          size = opts.head
          await reader!.cancel().catch(() => {})
          break
        }
        if (size > limit) throw new Error(`文件大小不合理 / implausible file size (over ${limit} bytes): ${url}`)
        if (!out.write(chunk.value)) await new Promise<void>((r) => out.once('drain', () => r()))
      }
      await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
      if (size === 0) throw new Error(`文件大小不合理 / implausible file size (0 bytes): ${url}`)
    } catch (e) {
      out.destroy()
      await unlink(tmp).catch(() => {})
      throw e
    }
    await rename(tmp, path)
    return path
  })().finally(() => pending.delete(path))
  pending.set(path, job)
  return job
}
