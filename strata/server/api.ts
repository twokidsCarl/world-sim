// 不依赖浏览器的运行入口：一个只绑 127.0.0.1 的小 HTTP 服务，把请求交给 CPU 参考实现。
//   bun --preload ./server/raw.ts server/api.ts --port 8790
// 接口：GET /api/health；POST /api/run/<底座>，请求体见 sim.json 的 agent.capabilities。
// 不调用模型，不写文件。
// The entry point that needs no browser: a small HTTP server bound to 127.0.0.1 that hands
// requests to the CPU reference implementation.
//   bun --preload ./server/raw.ts server/api.ts --port 8790
// Routes: GET /api/health; POST /api/run/<substrate>, with the body described under
// agent.capabilities in sim.json. It calls no model and writes no file.

import { RequestError, runHeadless } from '../src/headless/run'
import { RUN_SECONDS } from '../src/headless/schema'
import { SUBSTRATES } from '../src/substrates'

const flag = process.argv.indexOf('--port')
const port = Number(flag >= 0 ? process.argv[flag + 1] : (process.env.PORT ?? 8790))
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('端口要用 --port <数字> 或环境变量 PORT 给出 / give the port with --port <number> or the PORT environment variable')
  process.exit(2)
}

const json = (status: number, body: unknown) => Response.json(body, { status })

// 一次只算一个：模拟是单线程的，同时算几个只会一起变慢、一起超时。
// One run at a time: the simulation is single-threaded, and several at once would only slow
// down and time out together.
let queue: Promise<unknown> = Promise.resolve()

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function run(substrate: string, request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json(400, { detail: '请求体要是 JSON / the request body must be JSON', hint: `POST /api/run/${substrate} with a JSON object` })
  }
  const turn = queue.then(async () => {
    // 调用方已经不等了就不算了。 / Skip the work when the caller has stopped waiting.
    if (request.signal.aborted) throw new RequestError('请求已取消 / the request was cancelled', '', 499)
    return runHeadless(substrate, body, {
      budgetMs: RUN_SECONDS * 1000,
      pause: async () => {
        await pause()
        if (request.signal.aborted) throw new RequestError('请求已取消 / the request was cancelled', '', 499)
      },
    })
  })
  queue = turn.catch(() => {})
  try {
    return json(200, await turn)
  } catch (error) {
    if (error instanceof RequestError) return json(error.status, { detail: error.message, hint: error.hint })
    console.error(error)
    return json(500, { detail: `内部错误 / internal error: ${error instanceof Error ? error.message : String(error)}` })
  }
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 255,
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/api/health') return json(200, { ok: true, substrates: SUBSTRATES.map((s) => s.id) })
    const match = /^\/api\/run\/([a-z0-9]+)$/.exec(pathname)
    if (match && request.method === 'POST') return run(match[1]!, request)
    return json(404, {
      detail: `没有这个接口：${request.method} ${pathname} / no such route: ${request.method} ${pathname}`,
      hint: `GET /api/health, or POST /api/run/<substrate> with <substrate> one of ${SUBSTRATES.map((s) => s.id).join(', ')}`,
    })
  },
})

console.log(`strata api: http://${server.hostname}:${server.port}`)
