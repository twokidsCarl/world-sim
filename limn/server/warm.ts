/**
 * 预热：后端一启动，就在后台把各张卡片要用的文件取到本机（并把超大模型转换好），
 * 这样第一次打开某张卡时不必现等下载。一次只做一件，从小的做起；已经有的直接跳过；
 * 哪一件失败了记下来继续做下一件，不影响别的。
 *
 * 这些文件不在仓库里（第三方数据，有的几百 MB），所以只能在用的机器上取。
 * 只在托管时（设了 WORLD_SIM_STATE）默认开启；开发时后端会随改动反复重启，
 * 大文件下到一半就得重来，所以默认不开。可用 LIMN_WARM=1 或 0 明确指定。
 *
 * Warm-up: as soon as the backend starts, the files the cards need are fetched to this machine
 * in the background (and the very large models converted), so that opening a card for the first
 * time does not have to wait for a download. One thing at a time, smallest first; what is already
 * there is skipped; a failure is noted and the next item goes ahead regardless.
 *
 * These files are not in the repository (third-party data, some of it hundreds of MB), so they
 * can only be fetched on the machine that uses them. It is on by default only when hosted
 * (WORLD_SIM_STATE set): while developing, the backend restarts with every change and a large
 * download would start over each time. LIMN_WARM=1 or 0 says so explicitly.
 */
import catalog from '../data/catalog.json'
import cells from '../data/cells.json'
import neurons from '../data/neurons.json'
import { micronsUrl, neuromorphoUrl } from '../src/neuro/swc'
import { emdb } from './sources/emdb'
import { cached } from './structures'
import type { CellSource } from '../src/volume/cell'
import { bigPdbKey, makeBigPdb, type BigPdbSource } from './tools/bigpdb'
import { cellKey, makeCell } from './tools/cell'
import { groKey, makeGro } from './tools/gro'
import { makePetworld, petworldKey } from './tools/petworld'
import { preparedFile } from './tools/prepared'

export interface WarmItem {
  label: string
  run: () => Promise<unknown>
}

interface Source { kind: string; url?: string; id?: string; format?: string; member?: string; head?: number; budget?: number }

/** 把一个预处理模型做出来（已有就直接返回）/ make one prepared model (returning at once if it is there) */
export function prepare(src: Source): Promise<string> {
  if (src.format === 'pdb') return preparedFile(bigPdbKey(src as unknown as BigPdbSource), () => makeBigPdb(src as unknown as BigPdbSource))
  if (src.format === 'gro') return preparedFile(groKey(src.url!, src.member!, src.head!, src.budget ?? 4_000_000), () => makeGro(src.url!, src.member!, src.head!, src.budget ?? 4_000_000))
  return preparedFile(petworldKey(src.url!), () => makePetworld(src.url!))
}

/**
 * 要预热的东西，按大致从小到大排：单个结构、神经元、密度图、整体模型，最后是要转换的超大模型。
 * `cards` 是 sim.json 里各卡片的地址，用来找出按编号直达的结构和密度图。
 * What to warm, roughly smallest first: single structures, neurons, density maps, whole models,
 * and last the very large models that need converting. `cards` are the card addresses from
 * sim.json, used to find the structures and density maps opened directly by id.
 */
export function warmList(cards: string[]): WarmItem[] {
  const out: WarmItem[] = []
  const pdb = (id: string) => out.push({ label: `PDB ${id}`, run: () => cached(`https://models.rcsb.org/${id.toLowerCase()}.bcif.gz`) })
  const models = catalog.models as { id: string; source: Source }[]
  for (const url of cards) {
    const id = /[?&]id=([^&]+)/.exec(url)?.[1]
    if (id && /^[0-9][A-Za-z0-9]{3}$/.test(id)) pdb(id.toUpperCase())
  }
  for (const m of models) if (m.source.kind === 'pdb' && m.source.id) pdb(m.source.id)
  for (const n of neurons.neurons) out.push({ label: n.name, run: () => cached(neuromorphoUrl(n.archive, n.name)) })
  for (const g of neurons.groups) for (const c of g.cells) out.push({ label: `MICrONS ${c}`, run: () => cached(micronsUrl(c)) })
  for (const url of cards) {
    const n = /[?&]id=EMD-(\d+)/i.exec(url)?.[1]
    if (n)
      out.push({
        label: `EMD-${n}`,
        run: async () => {
          const info = await emdb(n)
          if (info) await cached(info.url)
        },
      })
  }
  for (const m of models) if (m.source.kind === 'url' && m.source.url) out.push({ label: m.id, run: () => cached(m.source.url!) })
  // 整个细胞：分割数据一百多块，取齐并算好表面 / whole cells: over a hundred blocks of segmentation, fetched and turned into surfaces
  for (const c of cells.cells as (CellSource & { id: string })[]) out.push({ label: c.id, run: () => preparedFile(cellKey(c), () => makeCell(c)) })
  const big = models.filter((m) => m.source.kind === 'prepared').sort((a, b) => (a.source.head ?? 0) - (b.source.head ?? 0))
  for (const m of big) out.push({ label: m.id, run: () => prepare(m.source) })
  return out
}

/** 预热进行到哪了 / how far the warm-up has got */
export const warmState = { total: 0, done: 0, failed: [] as string[], current: '', finished: false }

/** 依次做完；不抛错 / do them one after another; never throws */
export async function warm(items: WarmItem[], log: (line: string) => void = console.log): Promise<void> {
  warmState.total = items.length
  for (const item of items) {
    warmState.current = item.label
    try {
      await item.run()
    } catch (e) {
      warmState.failed.push(item.label)
      log(`warm: ${item.label} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    warmState.done++
  }
  warmState.current = ''
  warmState.finished = true
  log(`warm: ${items.length - warmState.failed.length}/${items.length} ready`)
}

/** 该不该预热：明确指定的优先，否则只在托管时 / whether to warm: an explicit setting wins, otherwise only when hosted */
export function shouldWarm(env: Record<string, string | undefined>): boolean {
  if (env.LIMN_WARM === '1') return true
  if (env.LIMN_WARM === '0') return false
  return !!env.WORLD_SIM_STATE
}
