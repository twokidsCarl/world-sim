import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(<App />)

// 供控制台调试应用的句柄 / Handle for poking at the app from the console.
import { useStore } from './state/store'
import { stage } from './ui/Stage'
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
async function sheet(round: string, size = 520): Promise<void> {
  if (sheetState.running) return
  const cards = ((await (await fetch('/sim.json')).json()) as { cards: { id: string; url: string }[] }).cards
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
    if (useStore.getState().sceneRev !== before && !useStore.getState().error) await snap(`${round}-${c.id}`, size)
    else sheetState.failed.push(c.id)
    sheetState.done++
  }
  sheetState.running = false
}

Object.assign(window, { limn: { stage, store: useStore, snap, refine, sheet, sheetState } })
