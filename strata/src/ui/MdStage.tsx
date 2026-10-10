import { useEffect, useRef, useState } from 'react'
import { fitCanvas, theme } from '../plot/plot'
import { PointsRenderer, parseHex, viridis } from '../render/points'
import { psi6 } from '../substrates/md/ref/reducers'
import type { MdBackend, MdCpuBackend } from '../substrates/md/backend-cpu'
import type { MdGpuBackend } from '../substrates/md/backend-gpu'
import { engine } from './engine'
import { useUi } from './store'

function caption(el: HTMLElement | null): void {
  if (!el) return
  const b = engine.backend as MdBackend
  el.textContent =
    `${b.n} 个粒子 · 第 ${b.stepCount} 步 · 盒子 ${b.box[0]!.toFixed(1)} × ${b.box[1]!.toFixed(1)} σ` +
    (engine.overflow ? ' · 邻居表溢出，受力不完整' : '')
}

function CpuCanvas() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(
    () =>
      engine.onFrame(() => {
        const canvas = ref.current
        if (!canvas || engine.backend.kind !== 'cpu') return
        const s = (engine.backend as MdCpuBackend).state
        canvas.style.aspectRatio = `${s.box[0]} / ${s.box[1]}`
        const { ctx, w } = fitCanvas(canvas)
        ctx.clearRect(0, 0, w, canvas.clientHeight)
        const scale = w / s.box[0]
        const r = Math.max(0.75, 0.45 * scale)
        // Draw in batches of one fill colour each: a single batch, or 16 bins of |ψ6|.
        const BINS = 16
        const psi = engine.view.colour ? psi6(s) : null
        for (let bin = 0; bin < (psi ? BINS : 1); bin++) {
          if (psi) {
            const [cr, cg, cb] = viridis((bin + 0.5) / BINS)
            ctx.fillStyle = `rgb(${Math.round(cr * 255)} ${Math.round(cg * 255)} ${Math.round(cb * 255)})`
          } else ctx.fillStyle = theme().ink
          ctx.beginPath()
          for (let i = 0; i < s.n; i++) {
            if (psi && Math.min(BINS - 1, Math.floor(Math.hypot(psi[2 * i]!, psi[2 * i + 1]!) * BINS)) !== bin) continue
            const x = s.pos[i * s.dim] * scale
            const y = s.pos[i * s.dim + 1] * scale
            ctx.moveTo(x + r, y)
            ctx.arc(x, y, r, 0, 2 * Math.PI)
          }
          ctx.fill()
        }
      }),
    [],
  )
  return <canvas ref={ref} className="stage" />
}

function GpuCanvas() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const gpu = engine.gpu
    if (!canvas || !gpu) return
    const context = canvas.getContext('webgpu')!
    context.configure({ device: gpu.device, format: gpu.format, alphaMode: 'premultiplied' })
    const renderer = new PointsRenderer(gpu.device, gpu.format)
    return engine.onFrame(() => {
      if (engine.backend.kind !== 'gpu') return
      const b = engine.backend as MdGpuBackend
      canvas.style.aspectRatio = `${b.box[0]} / ${b.box[1]}`
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      renderer.draw(context.getCurrentTexture().createView(), b, b.n, b.box, parseHex(theme().ink), [w, h], engine.view.colour ?? 0)
    })
  }, [])
  return <canvas ref={ref} className="stage" />
}

const COLOURS = ['单色', '局域六角序 |ψ₆|']

export function MdStage() {
  const kind = useUi((s) => s.backendKind)
  const [colour, setColour] = useState(engine.view.colour ?? 0)
  const infoRef = useRef<HTMLSpanElement>(null)
  useEffect(() => engine.onFrame(() => caption(infoRef.current)), [])
  return (
    <section className="stage-wrap">
      {kind === 'gpu' ? <GpuCanvas /> : <CpuCanvas />}
      <span ref={infoRef} className="caption" />
      <div className="segmented view-options">
        <span className="caption">着色</span>
        {COLOURS.map((label, i) => (
          <button
            key={label}
            aria-pressed={i === colour}
            onClick={() => {
              engine.view.colour = i
              setColour(i)
            }}
          >
            {label}
          </button>
        ))}
        {colour === 1 && <span className="colourbar" title="|ψ₆| 从 0 到 1" />}
      </div>
    </section>
  )
}
