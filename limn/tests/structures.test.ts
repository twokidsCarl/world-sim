// 结构文件的本机缓存 / the local cache of structure files
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allowed, cached, stateDir } from '../server/structures'

describe('structure cache', () => {
  const saved = { cache: process.env.LIMN_CACHE, state: process.env.WORLD_SIM_STATE }
  let dir = ''
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'limn-test-'))
    process.env.LIMN_CACHE = dir
  })
  afterAll(() => {
    process.env.LIMN_CACHE = saved.cache
    process.env.WORLD_SIM_STATE = saved.state
    if (saved.cache === undefined) delete process.env.LIMN_CACHE
    if (saved.state === undefined) delete process.env.WORLD_SIM_STATE
  })

  it('only downloads from hosts on the allowlist, over https', () => {
    expect(allowed('https://models.rcsb.org/2hhb.bcif.gz')).toBe(true)
    expect(allowed('http://models.rcsb.org/2hhb.bcif.gz')).toBe(false)
    expect(allowed('https://example.com/x.bcif')).toBe(false)
    expect(allowed('https://models.rcsb.org.evil.example/x')).toBe(false)
    expect(allowed('file:///etc/passwd')).toBe(false)
    expect(allowed('not a url')).toBe(false)
  })

  it('refuses a URL off the allowlist without fetching', async () => {
    let calls = 0
    await expect(cached('https://example.com/x', (async () => (calls++, new Response('x'))) as unknown as typeof fetch)).rejects.toThrow()
    expect(calls).toBe(0)
  })

  it('downloads once and serves from disk afterwards', async () => {
    let calls = 0
    const fake = (async () => (calls++, new Response(new Uint8Array([1, 2, 3])))) as unknown as typeof fetch
    const url = 'https://models.rcsb.org/test-entry.bcif'
    const [a, b] = await Promise.all([cached(url, fake), cached(url, fake)])
    const c = await cached(url, fake)
    expect(calls).toBe(1)
    expect(a).toBe(b)
    expect(a).toBe(c)
    expect(a.startsWith(dir)).toBe(true)
    expect(Array.from(await readFile(a))).toEqual([1, 2, 3])
  })

  it('reports a failed download and caches nothing', async () => {
    const bad = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    await expect(cached('https://models.rcsb.org/missing.bcif', bad)).rejects.toThrow(/404/)
    let calls = 0
    await cached('https://models.rcsb.org/missing.bcif', (async () => (calls++, new Response('ok'))) as unknown as typeof fetch)
    expect(calls).toBe(1)
  })

  it('writes under WORLD_SIM_STATE when hosted', () => {
    delete process.env.LIMN_CACHE
    process.env.WORLD_SIM_STATE = '/somewhere/state'
    expect(stateDir()).toBe('/somewhere/state')
    process.env.LIMN_CACHE = dir
  })
})
