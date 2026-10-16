// GPU 求解器的对照与计时（无头 Chrome）：在同一页面里用同样的输入跑 CPU 参考、CPU 镜像和 GPU，比较结点位置和按压结果，
// 写出 data/curated/softbody/gpu-report.json。前臂和全身的笼子在这里（Bun）用界面的同一段代码建好，作为数据送进页面。
// Comparison and timing of the GPU solver (headless Chrome): on one page and from the same inputs it runs the CPU
// reference, the CPU mirror and the GPU, compares node positions and press results, and writes
// data/curated/softbody/gpu-report.json. The forearm and whole-body cages are built here (Bun) by the UI's own code and
// sent to the page as data.
//
//   bun tools/softbody/gpu-check.ts [block] [sphere] [forearm] [posture] [--frames 300] [--cpu-full] [--port 5291]
//
// 需要本机的 Chrome（或环境变量 CHROME）和能用的 WebGPU。/ Needs a local Chrome (or the CHROME environment variable) and working WebGPU.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'vite'
import { SoftEngine } from '../../src/softbody/engine.ts'
import { cageParts, type PartLite } from '../../src/softbody/protocol.ts'
import { buildSiteFrom } from '../../src/softbody/site.ts'
import { ROOT, loadBody, readMaterials, reencode } from './build.ts'
import { launch } from './cdp.ts'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const want = new Set(args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a)))
const all = want.size === 0
const FRAMES = Number(flag('frames') ?? 300)
const log = (s: string): void => console.log(`[gpu-check] ${s}`)

const blobs = new Map<string, Uint8Array | string>()
if (all || want.has('forearm') || want.has('flat') || want.has('flatprofile') || want.has('held') || want.has('posture') || want.has('profile')) {
  const t0 = performance.now()
  const { body, rig, rigBin } = await loadBody('male')
  const skinPart = body.data.parts.filter((p) => p.tissue === 'skin').sort((a, b) => b.triangles - a.triangles)[0]!
  const skin = body.meshes.get(skinPart.id)!
  const parts: PartLite[] = body.data.parts.map((p) => ({ id: p.id, name: p.name, system: p.system, tissue: p.tissue, bbox: p.bbox, centroid: p.centroid, triangles: p.triangles }))
  const e = new SoftEngine()
  e.init({ body: 'male', parts, skin: { id: skinPart.id, positions: skin.positions, indices: skin.indices }, rig, rigBin })
  const ids = cageParts(parts).map((p) => p.id).filter((id) => body.meshes.has(id))
  e.addMeshes(ids.map((id) => ({ id, positions: body.meshes.get(id)!.positions, indices: body.meshes.get(id)!.indices })))
  blobs.set('skin-positions.bin', new Uint8Array(skin.positions.buffer, skin.positions.byteOffset, skin.positions.byteLength))
  blobs.set('skin-indices.bin', new Uint8Array(skin.indices.buffer, skin.indices.byteOffset, skin.indices.byteLength))
  if (all || want.has('forearm') || want.has('held')) {
    // 验证时的前臂近端三分之一（掌侧），与 tests/softbody-ui.test.ts 相同 / the proximal third of the forearm (volar) used in validation, as in tests/softbody-ui.test.ts
    const site: [number, number, number] = [0.26421424746513367, 0.9644516706466675, 0.14539162814617157]
    let vertex = -1, best = Infinity
    for (let i = 0; i < skin.positions.length / 3; i++) {
      const d = Math.hypot(skin.positions[i * 3]! - site[0], skin.positions[i * 3 + 1]! - site[1], skin.positions[i * 3 + 2]! - site[2])
      if (d < best) (best = d), (vertex = i)
    }
    const outward = e.outward({ position: site, vertex })
    const S = buildSiteFrom(readMaterials(), (e as unknown as { body: Parameters<typeof buildSiteFrom>[1] }).body, rig, rigBin, site, outward, 0.005, { inBody: e.ensureInside() })
    const enc = reencode(S.soft, null)
    blobs.set('forearm.json', JSON.stringify({ soft: enc.json, site, outward, radius: 0.005, force: 1 }))
    blobs.set('forearm.bin', enc.bin)
    log(`forearm cage: ${S.stats.nodes} nodes, ${S.stats.tets} tets`)
  }
  if (all || want.has('flat') || want.has('flatprofile')) {
    // 卡片上的平头压头：前臂中段，半径 13 mm，压入 4.5 mm（forearm2026 的做法）/ the card's flat punch: mid-forearm, radius 13 mm, 4.5 mm deep (the forearm2026 protocol)
    const site: [number, number, number] = [0.286526, 0.907817, 0.153696]
    let vertex = -1, best = Infinity
    for (let i = 0; i < skin.positions.length / 3; i++) {
      const d = Math.hypot(skin.positions[i * 3]! - site[0], skin.positions[i * 3 + 1]! - site[1], skin.positions[i * 3 + 2]! - site[2])
      if (d < best) (best = d), (vertex = i)
    }
    const outward = e.outward({ position: site, vertex })
    const S = buildSiteFrom(readMaterials(), (e as unknown as { body: Parameters<typeof buildSiteFrom>[1] }).body, rig, rigBin, site, outward, 0.013, { inBody: e.ensureInside() })
    const enc = reencode(S.soft, null)
    blobs.set('flat.json', JSON.stringify({ soft: enc.json, site, outward, radius: 0.013, depth: 4.5 }))
    blobs.set('flat.bin', enc.bin)
    log(`flat-punch cage: ${S.stats.nodes} nodes, ${S.stats.tets} tets`)
  }
  if (all || want.has('posture') || want.has('profile')) {
    const W = e.wholeCage()
    const enc = reencode(W.soft, null)
    blobs.set('whole.json', JSON.stringify({ soft: enc.json }))
    blobs.set('whole.bin', enc.bin)
    log(`whole-body cage: ${W.soft.data.nodeCount} nodes, ${W.soft.data.tetCount} tets (${W.cageMs} ms)`)
  }
  log(`data prepared in ${Math.round(performance.now() - t0)} ms`)
}

const server = await createServer({
  configFile: join(ROOT, 'vite.config.ts'),
  root: ROOT,
  logLevel: 'warn',
  server: { port: Number(flag('port') ?? 5291), strictPort: false, host: '127.0.0.1', hmr: false, watch: null },
  plugins: [{
    name: 'gpu-check-data',
    configureServer(s) {
      s.middlewares.use((req, res, next) => {
        const m = /^\/__gpu\/(.+)$/.exec(req.url ?? '')
        if (!m) return next()
        const b = blobs.get(m[1]!)
        if (b === undefined) return ((res.statusCode = 404), res.end())
        res.setHeader('content-type', typeof b === 'string' ? 'application/json' : 'application/octet-stream')
        res.end(typeof b === 'string' ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength))
      })
    },
  }],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
log(`vite on 127.0.0.1:${port}`)
const browser = await launch()
/**
 * 声明的容差（相对 CPU 参考；tests/softbody-gpu.test.ts 拿报告检查）。来源：着色改变了约束的求解顺序，这是顺序带来的差别
 * （f64 的 CPU 镜像按颜色走时差别相同），不是 f32 的。
 * The stated tolerances (relative to the CPU reference; tests/softbody-gpu.test.ts checks the report against them).
 * Their source: colouring changes the order in which constraints are solved; these are differences of order (the f64
 * CPU mirror run by colour shows the same), not of f32.
 */
const TOLERANCE = {
  /** 方块自重：最大结点差 ÷ 最大位移 / block under gravity: largest node difference ÷ largest displacement */
  blockGravityMaxRel: 0.005,
  /** GPU 对同一顺序的 f64 镜像（只差 f32 和求和顺序）/ GPU against the f64 mirror in the same order (f32 and order of sums only) */
  gpuVsMirrorMaxRel: 0.002,
  /** 保持深度的压头：反力 / probe held at a depth: reaction */
  heldForceRel: 0.03,
  /** 保持深度的压头：结点差的 RMS ÷ 最大位移 / probe held at a depth: RMS node difference ÷ largest displacement */
  heldRmsRel: 0.03,
  /** 全身体位：皮肤位移的平均和最大 / whole-body posture: mean and largest skin displacement */
  postureSkinRel: 0.02,
  /** 全身体位：结点差的 RMS ÷ 最大位移 / whole-body posture: RMS node difference ÷ largest displacement */
  postureRmsRel: 0.03,
}

const report: Record<string, unknown> = { tolerance: TOLERANCE, _doc: { zh: 'GPU 求解器与 CPU 参考的对照（bun tools/softbody/gpu-check.ts 生成）。距离是结点位置之差（毫米），只看自由结点；refMaxMm 是 CPU 参考相对参考构形的最大位移。', en: 'The GPU solver against the CPU reference (generated by bun tools/softbody/gpu-check.ts). Distances are differences of node positions (mm), free nodes only; refMaxMm is the CPU reference\'s largest displacement from the reference configuration.' }, date: new Date().toISOString().slice(0, 10) }
let code = 0
try {
  const page = await browser.page(`http://127.0.0.1:${port}/tools/softbody/gpu-check.html`)
  for (let i = 0; i < 300 && !(await page.eval<boolean>('!!window.gpuCheck').catch(() => false)); i++) await Bun.sleep(100)
  report.info = await page.eval('gpuCheck.info()')
  log(JSON.stringify(report.info))
  const run = async (name: string, expr: string): Promise<void> => {
    const t0 = performance.now()
    try {
      report[name] = await page.eval(expr, 3_600_000)
    } catch (err) {
      report[name] = { error: err instanceof Error ? err.message : String(err) }
      code = 1
    }
    log(`${name} (${Math.round((performance.now() - t0) / 1000)} s): ${JSON.stringify(report[name])}`)
  }
  if (all || want.has('block')) await run('blockGravity', 'gpuCheck.blockGravity(400)')
  if (all || want.has('sphere')) await run('blockSphere', 'gpuCheck.blockSphere()')
  if (all || want.has('sphere') || want.has('held')) await run('blockHeld', 'gpuCheck.blockHeld(400)')
  if (all || want.has('forearm') || want.has('held')) await run('forearmHeld', 'gpuCheck.forearmHeld(600)')
  if (all || want.has('forearm')) await run('forearm', 'gpuCheck.forearm()')
  if (want.has('profile')) await run('profile', 'gpuProfile()')
  if (all || want.has('flat')) await run('flat', 'gpuCheck.flat()')
  if (want.has('flatprofile')) await run('flatProfile', 'gpuFlatProfile()')
  if (all || want.has('posture')) await run('posture', `gpuCheck.posture('supine', ${FRAMES}, ${args.includes('--cpu-full')})`)
  if (page.console.length) log(`console:\n${page.console.slice(-20).join('\n')}`)
} finally {
  await browser.close()
  await server.close()
}
const out = flag('out') ?? join(ROOT, 'data', 'curated', 'softbody', 'gpu-report.json')
let prev: Record<string, unknown> = {}
try {
  prev = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>
} catch {}
writeFileSync(out, JSON.stringify({ ...prev, ...report }, null, 1) + '\n')
log(`written ${out}`)
process.exit(code)
