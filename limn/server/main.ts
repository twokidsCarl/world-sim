/** limn 网页应用的本地服务：主题解析和图像评审 / Local service for the limn web app: topic resolution and image review. */
import { compare, critique, pickView, type CritiqueRequest } from './critique'
import { available } from './llm'
import { resolveTopic } from './resolve'
import { annotate } from './sources/annotations'
import { emdb } from './sources/emdb'
import { JOURNALS, openAccess, recent, released } from './sources/literature'
import { orientation } from './sources/opm'
import { pdbtm, topology } from './sources/pdbtm'
import { cached, stateDir } from './structures'
import catalog from '../data/catalog.json'
import { groKey, makeGro } from './tools/gro'
import { makePetworld, petworldKey } from './tools/petworld'
import { poll } from './tools/prepared'
import { alphafold, complexes } from './sources/uniprot'
import { searchNeurons } from './sources/neuromorpho'

const PORT = Number(process.env.LIMN_PORT || 5185)

const json = (body: unknown, status = 200) => Response.json(body, { status })
const fail = (e: unknown, status = 500) => json({ error: e instanceof Error ? e.message : String(e) }, status)
const png = (b64: unknown): Uint8Array => {
  if (typeof b64 !== 'string' || b64.length < 100) throw new Error('缺少图片 / The image is missing')
  return Uint8Array.from(Buffer.from(b64.replace(/^data:image\/png;base64,/, ''), 'base64'))
}

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url)
    try {
      if (url.pathname === '/api/health') return json({ ok: true, claude: await available() })
      // 化学组分的理想坐标（用于膜脂质）。
      // Ideal coordinates of a chemical component (used for the membrane lipid).
      const lig = /^\/api\/ligand\/([A-Za-z0-9]{1,5})$/.exec(url.pathname)
      if (lig) {
        const res = await fetch(`https://files.rcsb.org/ligands/download/${lig[1]!.toUpperCase()}_ideal.sdf`)
        return res.ok ? new Response(await res.text(), { headers: { 'Content-Type': 'text/plain' } }) : json({ error: `没有找到配体 ${lig[1]} / Ligand ${lig[1]} was not found` }, 404)
      }
      // 结构文件：从白名单主机取一次，之后读本机缓存
      // structure files: fetched once from an allowlisted host, then served from the local cache
      if (url.pathname === '/api/structure') {
        const target = url.searchParams.get('url') ?? ''
        const file = Bun.file(await cached(target))
        return new Response(file, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size), 'Cache-Control': 'max-age=86400' } })
      }
      // 预处理过的超大模型：第一次请求时下载原文件并粗化（要一两分钟），之后直接给
      // a prepared very large model: the first request downloads and coarsens the original (a minute or two), later ones are served straight away
      if (url.pathname === '/api/prepared') {
        // 只认目录里的条目：要下载什么、怎么转换，都由仓库里的目录决定，不由请求决定
        // only catalogue entries are accepted: what is downloaded and how it is converted is decided by the catalogue in the repository, not by the request
        const src = (catalog.models as { id: string; source: { kind: string; url?: string; format?: string; member?: string; head?: number; budget?: number } }[]).find((m) => m.id === url.searchParams.get('id') && m.source.kind === 'prepared')?.source
        if (!src?.url) return fail(new Error('目录里没有这个预处理模型 / no such prepared model in the catalogue'), 404)
        const state =
          src.format === 'gro'
            ? await poll(groKey(src.url, src.member!, src.head!, src.budget ?? 4_000_000), () => makeGro(src.url!, src.member!, src.head!, src.budget ?? 4_000_000))
            : await poll(petworldKey(src.url), () => makePetworld(src.url!))
        if ('preparing' in state) return json(state, 202)
        const file = Bun.file(state.path)
        return new Response(file, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size), 'Cache-Control': 'max-age=86400' } })
      }
      // 膜蛋白在膜里的取向（OPM）；没有收录时返回 null
      // a membrane protein's orientation in the membrane (OPM); null when OPM does not have it
      const mem = /^\/api\/membrane\/([0-9][A-Za-z0-9]{3})$/.exec(url.pathname)
      if (mem) {
        const opm = await orientation(mem[1]!)
        if (opm) return json({ orientation: opm })
        // OPM 没有：退到 PDBTM 的变换，加上 UniProt 的拓扑来定朝向 / not in OPM: fall back to PDBTM's transformation, with UniProt topology to settle which way it faces
        const frame = await pdbtm(mem[1]!)
        return json({ orientation: null, pdbtm: frame, topology: frame ? await topology(mem[1]!) : {} })
      }
      // 某期刊最近发布的结构 / structures recently released for a journal
      if (url.pathname === '/api/recent') {
        const journal = url.searchParams.get('journal') ?? 'Nature'
        const days = Math.min(365, Math.max(7, Number(url.searchParams.get('days')) || 90))
        return json({ journals: JOURNALS, journal, days, ...(await recent(journal, days)) })
      }
      // 一个结构的主要引文；开放获取的论文带摘要 / a structure's primary citation, with the abstract when the paper is open access
      const cit = /^\/api\/citation\/([0-9][A-Za-z0-9]{3})$/.exec(url.pathname)
      if (cit) {
        const [entry] = await released([cit[1]!])
        return json({ entry: entry ?? null, paper: entry?.citation?.doi ? await openAccess(entry.citation.doi) : null })
      }
      // 一张电镜密度图的基本信息 / the basics of an electron-microscopy density map
      const em = /^\/api\/emdb\/(\d{4,6})$/.exec(url.pathname)
      if (em) return json({ entry: await emdb(em[1]!) })
      // AlphaFold 预测模型的下载地址 / where to download an AlphaFold predicted model
      const afm = /^\/api\/alphafold\/([A-Za-z0-9]{6,20})$/.exec(url.pathname)
      if (afm) return json({ prediction: await alphafold(afm[1]!.toUpperCase()) })
      // 含有某个蛋白的预测复合物（界面可信度不够的已滤掉）/ predicted complexes containing a protein, unreliable interfaces already dropped
      const cpx = /^\/api\/complexes\/([A-Za-z0-9]{6,10})$/.exec(url.pathname)
      if (cpx) return json({ complexes: await complexes(cpx[1]!.toUpperCase()) })
      // 按物种、脑区、细胞类型检索神经元形态重建 / search neuron reconstructions by species, region and cell type
      if (url.pathname === '/api/neurons') {
        const q = url.searchParams
        return json(await searchNeurons({ species: q.get('species') ?? '', region: q.get('region') ?? '', cellType: q.get('cellType') ?? '' }))
      }
      // 逐残基注释：结构域、位点、致病性预测 / per-residue annotation: domains, sites, predicted pathogenicity
      const ann = /^\/api\/annotations\/([A-Za-z0-9-]{4,16})$/.exec(url.pathname)
      if (ann) return json({ annotation: await annotate(ann[1]!) })
      if (req.method !== 'POST') return json({ error: 'not found' }, 404)
      const body = (await req.json()) as Record<string, unknown>
      if (url.pathname === '/api/resolve') {
        const steps: string[] = []
        const spec = await resolveTopic(String(body.topic ?? ''), undefined, (s) => steps.push(s))
        return json({ spec, steps })
      }
      if (url.pathname === '/api/critique') {
        const r = body as unknown as Omit<CritiqueRequest, 'image'> & { image: string }
        return json(await critique({ ...r, image: png(r.image) }))
      }
      // 把一张渲染结果存到缓存目录，便于在浏览器之外检查（仅本机）
      // Save a rendered picture under the cache directory so it can be inspected outside the browser (local only).
      if (url.pathname === '/api/snapshot') {
        const name = String(body.name ?? 'snapshot').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'snapshot'
        const path = `${stateDir()}/snapshots/${name}.png`
        await Bun.write(path, png(body.image))
        return json({ path })
      }
      // 两张图哪张更好 / which of two pictures is better
      if (url.pathname === '/api/compare') {
        return json(await compare(png(body.a), png(body.b), String(body.title ?? ''), String(body.contents ?? ''), body.mode === 'landscape' ? 'landscape' : 'molecule', String(body.request ?? '')))
      }
      if (url.pathname === '/api/pick-view') {
        return json(await pickView(png(body.image), Number(body.count), String(body.title ?? ''), String(body.contents ?? '')))
      }
      return json({ error: 'not found' }, 404)
    } catch (e) {
      console.error(`${url.pathname}:`, e)
      return fail(e)
    }
  },
})
console.log(`limn server on http://127.0.0.1:${PORT}`)
