// 下载参照数据到 data/raw/calibration/<id>/，并写 SOURCE.txt（网址、日期、版本、许可及条款）。
// Downloads the reference data into data/raw/calibration/<id>/ and writes SOURCE.txt (URL, date, version, licence and clause).
//
// 用法 / usage: bun tools/calibrate/fetch.ts [id ...]      （不给 id 则全部 / all when no id is given）
// 下载的文件是不可信数据：只读取、解析，从不执行。 Downloaded files are untrusted data: read and parsed, never executed.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RAW, REFS, USER_AGENT, type RefDownload } from './refs.ts'

async function get(url: string): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    if (res.ok) return new Uint8Array(await res.arrayBuffer())
    if (attempt >= 3) throw new Error(`fetch ${url}: ${res.status}`)
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
  }
}

export async function fetchRef(ref: RefDownload, log: (m: string) => void): Promise<void> {
  const dir = join(RAW, ref.id)
  mkdirSync(dir, { recursive: true })
  const files = [...ref.files]
  if (ref.tree) {
    const tree = JSON.parse(new TextDecoder().decode(await get(`https://api.github.com/repos/${ref.tree.repo}/git/trees/${ref.tree.commit}?recursive=1`))) as { tree: { path: string; type: string }[] }
    for (const t of tree.tree) if (t.type === 'blob' && ref.tree.pick(t.path)) files.push({ url: `https://raw.githubusercontent.com/${ref.tree.repo}/${ref.tree.commit}/${t.path}`, path: t.path })
  }
  let done = 0
  for (const f of files) {
    const target = join(dir, f.path)
    if (!target.startsWith(dir)) throw new Error(`refusing path ${f.path}`)
    if (existsSync(target)) continue
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, await get(f.url))
    done++
  }
  writeFileSync(
    join(dir, 'SOURCE.txt'),
    [
      `Name: ${ref.name}`,
      `URL: ${ref.url}`,
      `Version: ${ref.version}`,
      `Downloaded: ${new Date().toISOString().slice(0, 10)}`,
      `Licence: ${ref.licence}`,
      `Clause: ${ref.clause}`,
      `Licence read on: ${ref.opened}`,
      `Files: ${files.length}`,
      'Use: local comparison only (tools/calibrate). Nothing in this directory is committed or redistributed.',
      '',
    ].join('\n'),
  )
  log(`${ref.id}: ${files.length} files (${done} new)`)
}

if (import.meta.main) {
  const want = process.argv.slice(2)
  for (const ref of Object.values(REFS)) {
    if (want.length && !want.includes(ref.id)) continue
    await fetchRef(ref, (m) => console.log(`[fetch] ${m}`))
  }
}
