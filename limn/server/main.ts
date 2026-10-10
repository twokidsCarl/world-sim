/** Local service for the limn web app: topic resolution and image review. */
import { critique, pickView, type CritiqueRequest } from './critique'
import { available } from './llm'
import { resolveTopic } from './resolve'

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
