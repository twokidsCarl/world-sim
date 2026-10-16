// 界面里的软组织物理：GPU 对 CPU（地址参数 pgpu=0）的计时、结果对照和截图（无头 Chrome，真实的应用和卡片）。
// 测：体位走到结果的时间、每帧毫秒、按压的时间、主线程的帧间隔和长任务；结果写进 data/curated/softbody/gpu-report.json 的 app 一节，
// 截图写到 data/raw/pipeline-scratch/softbody-gpu/。
// The soft-tissue physics in the UI: timing, comparison of results and screenshots of GPU against CPU (URL parameter
// pgpu=0) in headless Chrome, with the real app and its cards. Measured: posture time to result, ms per frame, press
// time, main-thread frame intervals and long tasks; results go to the `app` section of
// data/curated/softbody/gpu-report.json, screenshots to data/raw/pipeline-scratch/softbody-gpu/.
//
//   bun tools/softbody/gpu-app.ts [press] [flat] [posture] [--gpu-only] [--port 5294]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'vite'
import { ROOT } from './build.ts'
import { launch } from './cdp.ts'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const want = new Set(args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a)))
const all = want.size === 0
const SHOTS = join(ROOT, 'data', 'raw', 'pipeline-scratch', 'softbody-gpu')
mkdirSync(SHOTS, { recursive: true })
const log = (s: string): void => console.log(`[gpu-app] ${s}`)

// 主线程计时：每帧的间隔和长任务（PerformanceObserver），从页面开始就记 / main-thread timing: every frame interval and the long tasks, recorded from the start
const INIT = `(() => {
  const j = (window.__jank = { frames: [], long: [], mark: 0 })
  let last = performance.now()
  const tick = (t) => { j.frames.push([t, t - last]); last = t; requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) j.long.push([e.startTime, e.duration]) }).observe({ type: 'longtask', buffered: true }) } catch {}
})()`

interface Case {
  name: string
  url: string
  kind: 'press' | 'posture'
}
// 前臂近端三分之一（掌侧）上半径 5 mm 的球，1 N（验证时的那一行）；卡片上的平头压头；仰卧卡片
// a 5 mm sphere at 1 N on the proximal third of the forearm (volar; the validated row); the card's flat punch; the supine card
const CASES: Case[] = ([
  { name: 'press-sphere', kind: 'press', url: '/?embed=1&sys=int&skin=1&phys=sphere,5,1N@p264.214,964.452,145.392&cam=0.33,1.0,0.36,0.2642,0.9645,0.1454' },
  { name: 'press-flat', kind: 'press', url: '/?embed=1&sys=int&skin=1&phys=flat,13,4.5mm@p286.526,907.817,153.696&cam=0.36,0.95,0.36,0.2865,0.9078,0.1537' },
  { name: 'posture-supine', kind: 'posture', url: '/?embed=1&sys=int&skin=1&phys=1&grav=supine&cam=1.45,1.05,0.05,0,1.05,0.05' },
] as Case[]).filter((c) => all || want.has(c.kind) || want.has(c.name) || (c.name === 'press-flat' && want.has('flat')))

const server = await createServer({ configFile: join(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'warn', server: { port: Number(flag('port') ?? 5294), strictPort: false, host: '127.0.0.1', hmr: false, watch: null } })
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
log(`vite on 127.0.0.1:${port}`)
const browser = await launch()
const out: Record<string, unknown> = {}
try {
  for (const c of CASES) for (const gpu of args.includes('--gpu-only') ? [true] : [true, false]) {
    const key = `${c.name}-${gpu ? 'gpu' : 'cpu'}`
    const page = await browser.page(`http://127.0.0.1:${port}${c.url}${gpu ? '' : '&pgpu=0'}`, [1280, 800], INIT)
    const t0 = performance.now()
    for (let i = 0; i < 600 && !(await page.eval<boolean>('!!window.__somaSoft').catch(() => false)); i++) await Bun.sleep(200)
    // 等结果（体位最多 20 分钟，按压最多 10 分钟）/ wait for the result (posture at most 20 min, press 10 min)
    const done = c.kind === 'press' ? `['done','error'].includes(window.__somaSoft.useSoft.getState().pressStatus)` : `['done','error'].includes(window.__somaSoft.useSoft.getState().postureStatus)`
    const started = c.kind === 'press' ? `window.__somaSoft.useSoft.getState().pressStatus !== 'idle'` : `window.__somaSoft.useSoft.getState().postureStatus !== 'idle'`
    let tStart = 0
    for (let i = 0; i < 6000; i++) {
      if (!tStart && (await page.eval<boolean>(started).catch(() => false))) {
        tStart = performance.now()
        await page.eval('window.__jank.mark = performance.now()')
      }
      if (await page.eval<boolean>(done).catch(() => false)) break
      await Bun.sleep(200)
    }
    const wall = performance.now() - (tStart || t0)
    await Bun.sleep(1500)
    const r = await page.eval<Record<string, unknown>>(`(() => {
      const s = window.__somaSoft.useSoft.getState(), j = window.__jank
      const iv = j.frames.filter((f) => f[0] >= j.mark).map((f) => f[1]).sort((a, b) => a - b)
      const q = (p) => iv.length ? Math.round(iv[Math.min(iv.length - 1, Math.floor(p * iv.length))] * 10) / 10 : null
      const long = j.long.filter((l) => l[0] >= j.mark)
      return { pressStatus: s.pressStatus, pressMessage: s.pressMessage, pressResult: s.pressResult, pressTiming: s.pressTiming, postureStatus: s.postureStatus, postureStats: s.postureStats, backend: { press: s.pressBackend, posture: s.postureBackend, reason: s.gpuReason },
        frameIntervalMs: { n: iv.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: iv.length ? Math.round(iv[iv.length - 1]) : null }, longTasks: { n: long.length, totalMs: Math.round(long.reduce((a, l) => a + l[1], 0)), maxMs: Math.round(long.reduce((a, l) => Math.max(a, l[1]), 0)) }, debug: window.__somaSoft.softDebug() }
    })()`)
    r.wallSeconds = Math.round(wall / 100) / 10
    out[key] = r
    log(`${key}: ${JSON.stringify(r).slice(0, 1500)}`)
    await Bun.sleep(1000)
    await page.screenshot(join(SHOTS, `${c.name}-${gpu ? 'gpu' : 'cpu'}.png`))
    const errs = page.console.filter((l) => /error|exception/i.test(l))
    if (errs.length) log(`console: ${errs.slice(-5).join(' | ')}`)
  }
} finally {
  await browser.close()
  await server.close()
}
const file = join(ROOT, 'data', 'curated', 'softbody', 'gpu-report.json')
let prev: Record<string, unknown> = {}
try {
  prev = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
} catch {}
writeFileSync(file, JSON.stringify({ ...prev, app: { ...((prev.app as Record<string, unknown>) ?? {}), ...out } }, null, 1) + '\n')
log(`written ${file}`)
process.exit(0)
