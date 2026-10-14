import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(<App />)

// 供控制台调试应用的句柄 / Handle for poking at the app from the console.
import { useStore } from './state/store'
import { stage, viewFor } from './ui/Stage'
import { renderFigure } from './render/export'

/** 把当前画面按成品图渲染并存到本地缓存目录 / Render the current scene as a finished figure and save it in the local cache. */
async function snap(name: string, longSide = 1400): Promise<string> {
  if (!stage.renderer) throw new Error('no renderer')
  const fig = renderFigure(stage.renderer, useStore.getState().getLook(), longSide)
  const blob = await fig.canvas.convertToBlob({ type: 'image/png' })
  const image = await new Promise<string>((ok) => {
    const fr = new FileReader()
    fr.onload = () => ok(String(fr.result))
    fr.readAsDataURL(blob)
  })
  const res = await fetch('/api/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, image }) })
  return ((await res.json()) as { path: string }).path
}
import { refine } from './refine/loop'
/**
 * 把 sim.json 里的每张卡片依次载入、各存一张图（名字是 <轮次>-<卡片 id>），用来拼总览（research/goodsell/sheet.py）。
 * 在后台跑，进度写在 limn.sheetState 里。
 * Load every card of sim.json in turn and save a picture of each (named <round>-<card id>), for the
 * contact sheet (research/goodsell/sheet.py). It runs in the background, with progress in limn.sheetState.
 */
const sheetState = { done: 0, total: 0, failed: [] as string[], running: false }
async function sheet(round: string, size = 520, only?: string[], turn = 0): Promise<void> {
  if (sheetState.running) return
  // only：只出这几张卡（卡片 id）/ only: render just these cards (card ids)
  const cards = ((await (await fetch('/sim.json')).json()) as { cards: { id: string; url: string }[] }).cards.filter((c) => !only || only.includes(c.id))
  Object.assign(sheetState, { done: 0, total: cards.length, failed: [], running: true })
  for (const c of cards) {
    const q = new URLSearchParams(c.url.split('?')[1] ?? '')
    const s = useStore.getState()
    const before = s.sceneRev
    useStore.setState({ error: '' })
    if (q.get('model')) void s.loadCatalog(q.get('model')!)
    else if (q.get('neuron')) void s.loadNeuron(q.get('neuron')!)
    else if (q.get('cell')) void s.loadCell(q.get('cell')!)
    else if (q.get('id')) void s.loadId(q.get('id')!)
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 500))
      const now = useStore.getState()
      if ((now.sceneRev !== before && !now.busy) || now.error) break
    }
    await new Promise((r) => setTimeout(r, 1800))
    if (useStore.getState().sceneRev !== before && !useStore.getState().error) {
      await snap(`${round}-${c.id}`, size)
      // turn：再从转过一个角度的方向出一张，用来查“只有正面一个视角对”的毛病 / turn: a second picture from a turned direction, to catch things that are right from the front only
      if (turn) {
        const a = (turn * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a), b = a * 0.6, cb = Math.cos(b), sb = Math.sin(b)
        // 绕 y 转 a，再绕 x 转 0.6a / turned by a about y, then by 0.6a about x
        useStore.setState({ rot: new Float32Array([co, si * sb, -si * cb, 0, cb, sb, si, -co * sb, co * cb]) })
        await new Promise((r) => setTimeout(r, 2500))
        await snap(`${round}-${c.id}-turned`, size)
      }
    }
    else sheetState.failed.push(c.id)
    sheetState.done++
  }
  sheetState.running = false
}

/**
 * 量一帧要多久（毫秒）：把最近一次的视图快速画 n 遍、完整画 n 遍，各取中位数。读一个像素来等 GPU 画完。不依赖页面在不在前台。
 * Measure how long a frame takes (ms): the last view drawn quickly n times and in full n times, the median of each. Reading a pixel waits for the GPU. It does not depend on the page being in front.
 */
function bench(n = 5): { fast: number; full: number } | null {
  const r = stage.renderer
  if (!r) return null
  // 页面在后台时一帧也没画过，用当前的视角现算一个 / when the page is in the background nothing has been drawn, so the view is worked out from the current look
  const s = useStore.getState()
  const view = viewFor(r, s, r.canvas.width / Math.max(1, r.canvas.height))
  const time = (fast: boolean) => {
    const ts: number[] = []
    for (let i = 0; i < n; i++) {
      const t0 = performance.now()
      r.render(view, s.style, fast)
      r.gl.readPixels(0, 0, 1, 1, r.gl.RGBA, r.gl.UNSIGNED_BYTE, new Uint8Array(4))
      ts.push(performance.now() - t0)
    }
    return Math.round(ts.sort((a, b) => a - b)[n >> 1]!)
  }
  return { fast: time(true), full: time(false) }
}

Object.assign(window, { limn: { stage, store: useStore, snap, refine, sheet, sheetState, bench } })
