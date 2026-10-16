// 一个最小的无头 Chrome 驱动（Chrome DevTools 协议，WebSocket），给 GPU 的对照和计时脚本用：起一个独立的 Chrome
// （自己的临时配置目录、自己的端口），打开一页，执行脚本，截图，结束时关掉并删掉配置目录。不依赖 puppeteer。
// A minimal headless Chrome driver (Chrome DevTools Protocol over WebSocket) for the GPU comparison and timing scripts:
// starts a Chrome of its own (its own temporary profile and port), opens a page, evaluates scripts, takes screenshots,
// and on close shuts it down and deletes the profile. No puppeteer.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 找 Chrome：环境变量 CHROME，否则 macOS 的标准位置 / finds Chrome: the CHROME environment variable, else the standard macOS location */
export function chromePath(): string {
  const env = process.env.CHROME
  if (env && existsSync(env)) return env
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (existsSync(mac)) return mac
  throw new Error('cdp: 找不到 Chrome，请用环境变量 CHROME 指定 / Chrome not found; set the CHROME environment variable')
}

export interface Page {
  eval<T = unknown>(expr: string, timeoutMs?: number): Promise<T>
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  screenshot(file: string): Promise<void>
  console: string[]
}

export interface Browser {
  page(url: string, size?: [number, number], init?: string): Promise<Page>
  close(): Promise<void>
}

export async function launch(o: { port?: number; flags?: string[] } = {}): Promise<Browser> {
  const port = o.port ?? 9300 + Math.floor(Math.random() * 500)
  const profile = mkdtempSync(join(tmpdir(), 'soma-cdp-'))
  const proc = Bun.spawn([chromePath(), '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', ...(o.flags ?? []), 'about:blank'], { stdout: 'ignore', stderr: 'ignore' })
  let ws = ''
  for (let i = 0; i < 100 && !ws; i++) {
    await Bun.sleep(100)
    try {
      const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }
      ws = v.webSocketDebuggerUrl
    } catch {}
  }
  if (!ws) {
    proc.kill()
    rmSync(profile, { recursive: true, force: true })
    throw new Error('cdp: Chrome 没有起来 / Chrome did not start')
  }
  const pages: WebSocket[] = []
  return {
    async page(url: string, size: [number, number] = [1280, 800], init?: string): Promise<Page> {
      const t = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()) as { webSocketDebuggerUrl: string }
      const sock = new WebSocket(t.webSocketDebuggerUrl)
      pages.push(sock)
      await new Promise<void>((res, rej) => ((sock.onopen = () => res()), (sock.onerror = () => rej(new Error('cdp: websocket')))))
      let id = 0
      const wait = new Map<number, { res: (v: Record<string, unknown>) => void; rej: (e: Error) => void }>()
      const log: string[] = []
      sock.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown> }
        if (m.id !== undefined) {
          const w = wait.get(m.id)
          wait.delete(m.id)
          if (m.error) w?.rej(new Error(m.error.message))
          else w?.res(m.result ?? {})
        } else if (m.method === 'Runtime.consoleAPICalled') {
          const args = (m.params!.args as { value?: unknown; description?: string }[]).map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? '')))
          log.push(`[${String(m.params!.type)}] ${args.join(' ')}`)
        } else if (m.method === 'Runtime.exceptionThrown') log.push(`[exception] ${JSON.stringify(m.params).slice(0, 500)}`)
      }
      const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
        new Promise((res, rej) => {
          const k = ++id
          wait.set(k, { res, rej })
          sock.send(JSON.stringify({ id: k, method, params }))
        })
      await send('Runtime.enable')
      await send('Page.enable')
      await send('Emulation.setDeviceMetricsOverride', { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false })
      // 在页面的脚本之前运行（计时用）/ runs before the page's scripts (for timing)
      if (init) await send('Page.addScriptToEvaluateOnNewDocument', { source: init })
      await send('Page.navigate', { url })
      return {
        console: log,
        send,
        async eval<T>(expr: string, timeoutMs = 600000): Promise<T> {
          const r = await Promise.race([send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), Bun.sleep(timeoutMs).then(() => ({ timeout: true }))])
          if ('timeout' in r) throw new Error(`cdp: 超时 / timed out: ${expr.slice(0, 80)}`)
          const ex = r.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined
          if (ex) throw new Error(`cdp: ${ex.exception?.description ?? ex.text}`)
          return (r.result as { value: T }).value
        },
        async screenshot(file: string): Promise<void> {
          const r = await send('Page.captureScreenshot', { format: 'png' })
          await Bun.write(file, Buffer.from(String(r.data), 'base64'))
        },
      }
    },
    async close(): Promise<void> {
      for (const p of pages) p.close()
      proc.kill()
      await proc.exited
      rmSync(profile, { recursive: true, force: true })
    },
  }
}
