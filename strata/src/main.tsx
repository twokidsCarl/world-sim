import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './ui/app.css'

const root = document.getElementById('root')!

if (new URLSearchParams(location.search).has('harness')) {
  const { runHarness, renderHarness } = await import('./harness/harness')
  root.textContent = '正在运行交叉校验…'
  renderHarness(root, await runHarness())
} else {
  const { App } = await import('./ui/App')
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
