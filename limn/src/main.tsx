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
Object.assign(window, { limn: { stage, store: useStore, snap, refine } })
