/** limn 网页应用的本地服务：主题解析和图像评审 / Local service for the limn web app: topic resolution and image review. */
import { critique, pickView, type CritiqueRequest } from './critique'
import { available } from './llm'
import { resolveTopic } from './resolve'
import { annotate } from './sources/annotations'
import { orientation } from './sources/opm'
import { cached, stateDir } from './structures'
import { alphafold } from './sources/uniprot'

const PORT = Number(process.env.LIMN_PORT || 5185)

const json = (body: unknown, status = 200) => Response.json(body, { status })
const fail = (e: unknown, status = 500) => json({ error: e instanceof Error ? e.message : String(e) }, status)
const png = (b64: unknown): Uint8Array => {
  if (typeof b64 !== 'string' || b64.length < 100) throw new Error('缺少图片')
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
        return res.ok ? new Response(await res.text(), { headers: { 'Content-Type': 'text/plain' } }) : json({ error: `没有找到配体 ${lig[1]}` }, 404)
      }
      // 结构文件：从白名单主机取一次，之后读本机缓存
      // structure files: fetched once from an allowlisted host, then served from the local cache
      if (url.pathname === '/api/structure') {
        const target = url.searchParams.get('url') ?? ''
        const file = Bun.file(await cached(target))
        return new Response(file, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size), 'Cache-Control': 'max-age=86400' } })
      }
      // 膜蛋白在膜里的取向（OPM）；没有收录时返回 null
      // a membrane protein's orientation in the membrane (OPM); null when OPM does not have it
      const mem = /^\/api\/membrane\/([0-9][A-Za-z0-9]{3})$/.exec(url.pathname)
      if (mem) return json({ orientation: await orientation(mem[1]!) })
      // AlphaFold 预测模型的下载地址 / where to download an AlphaFold predicted model
      const afm = /^\/api\/alphafold\/([A-Za-z0-9]{6,10})$/.exec(url.pathname)
      if (afm) return json({ prediction: await alphafold(afm[1]!.toUpperCase()) })
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
