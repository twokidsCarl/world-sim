import { useEffect, useRef, useState } from 'react'
import { fitCanvas, theme } from '../plot/plot'
import { PointsRenderer, SPECIES_B, mapTopFor, parseHex, viridis } from '../render/points'
import { Points3dRenderer } from '../render/points3d'
import { psi6 } from '../substrates/md/ref/reducers'
import type { MdBackend, MdCpuBackend } from '../substrates/md/backend-cpu'
import type { MdGpuBackend } from '../substrates/md/backend-gpu'
import { engine } from './engine'
import { useUi } from './store'

/** The 3D view turns slowly about the vertical axis so the depth structure can be read. */
const viewAngle = () => performance.now() * 1e-4

function caption(el: HTMLElement | null): void {
  if (!el) return
  const b = engine.backend as MdBackend
  const box = Array.from(b.box.subarray(0, b.dim), (v) => v.toFixed(1)).join(' × ')
  el.textContent =
    `${b.n} 个粒子 · 第 ${b.stepCount} 步 · 盒子 ${box} σ` +
    (b.dim === 3 ? ' · 视角绕竖直轴缓慢转动' : '') +
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
        canvas.style.aspectRatio = s.dim === 3 ? '1' : `${s.box[0]} / ${s.box[1]}`
        const { ctx, w } = fitCanvas(canvas)
        ctx.clearRect(0, 0, w, canvas.clientHeight)
        if (s.dim === 3) {
          // Orthographic projection after a rotation about the vertical axis.
          const angle = viewAngle()
          const slab = engine.view.slab ? SLAB_HALF : Infinity
          const scale3 = w / (1.5 * s.box[0])
          const r3 = Math.max(0.75, 0.45 * scale3)
          for (let bin = 0; bin < 2; bin++) {
            ctx.fillStyle = bin === 1 ? SPECIES_B : theme().ink
            ctx.globalAlpha = 0.7
            ctx.beginPath()
            for (let i = 0; i < s.n; i++) {
              if (s.species[i] !== bin) continue
              const dx = s.pos[3 * i] - s.box[0] / 2
              const dz = s.pos[3 * i + 2] - s.box[2] / 2
              if (Math.abs(dz * Math.cos(angle) - dx * Math.sin(angle)) > slab) continue
              const x = w / 2 + (dx * Math.cos(angle) + dz * Math.sin(angle)) * scale3
              const y = w / 2 - (s.pos[3 * i + 1] - s.box[1] / 2) * scale3
              ctx.moveTo(x + r3, y)
              ctx.arc(x, y, r3, 0, 2 * Math.PI)
            }
            ctx.fill()
          }
          ctx.globalAlpha = 1
          return
        }
        const scale = w / s.box[0]
        const r = Math.max(0.75, 0.45 * scale)
        // Draw in batches of one fill colour each: a single batch, or 16 bins of |ψ6|.
        const BINS = 16
        const mode = engine.view.colour ?? 0
        const psi = mode === 1 ? psi6(s) : null
        const batches = mode === 1 ? BINS : mode === 2 ? 2 : 1
        for (let bin = 0; bin < batches; bin++) {
          if (psi) {
            const [cr, cg, cb] = viridis(((bin + 0.5) / BINS) * mapTopFor(theme().paper))
            ctx.fillStyle = `rgb(${Math.round(cr * 255)} ${Math.round(cg * 255)} ${Math.round(cb * 255)})`
          } else ctx.fillStyle = bin === 1 ? SPECIES_B : theme().ink
          ctx.beginPath()
          for (let i = 0; i < s.n; i++) {
            if (psi && Math.min(BINS - 1, Math.floor(Math.hypot(psi[2 * i]!, psi[2 * i + 1]!) * BINS)) !== bin) continue
            if (mode === 2 && s.species[i] !== bin) continue
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
    const renderer3d = new Points3dRenderer(gpu.device, gpu.format)
    return engine.onFrame(() => {
      if (engine.backend.kind !== 'gpu') return
      const b = engine.backend as MdGpuBackend
      canvas.style.aspectRatio = b.dim === 3 ? '1' : `${b.box[0]} / ${b.box[1]}`
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      if (b.dim === 3) {
        renderer3d.draw(
          context.getCurrentTexture().createView(),
          b.pos,
          b.n,
          0.75 * b.box[0]!,
          [b.box[0]! / 2, b.box[1]! / 2, b.box[2]! / 2],
          viewAngle(),
          parseHex(theme().ink),
          [w, h],
          { radius: 0.45, alpha: 0.8, slab: engine.view.slab ? SLAB_HALF : 0, second: parseHex(SPECIES_B) },
        )
        return
      }
      renderer.draw(context.getCurrentTexture().createView(), b, b.n, b.box, parseHex(theme().ink), [w, h], engine.view.colour ?? 0, mapTopFor(theme().paper))
    })
  }, [])
  return <canvas ref={ref} className="stage" />
}

const COLOURS = ['单色', '局域六角序 |ψ₆|', '粒子种类']
/** Half-thickness, in σ, of the slice through the middle of a 3D box. */
const SLAB_HALF = 1.5

export function MdStage() {
  const kind = useUi((s) => s.backendKind)
  const [colour, setColour] = useState(engine.view.colour ?? 0)
  const mixture = useUi((s) => s.params.fractionB! > 0)
  const three = useUi((s) => s.params.dim === 3)
  const [slab, setSlab] = useState(engine.view.slab ?? 0)
  // Show the species as soon as there are two of them.
  useEffect(() => {
    const next = mixture ? 2 : engine.view.colour === 2 ? 0 : (engine.view.colour ?? 0)
    engine.view.colour = next
    setColour(next)
  }, [mixture])
  const infoRef = useRef<HTMLSpanElement>(null)
  useEffect(() => engine.onFrame(() => caption(infoRef.current)), [])
  return (
    <section className="stage-wrap">
      {kind === 'gpu' ? <GpuCanvas /> : <CpuCanvas />}
      <span ref={infoRef} className="caption" />
      {three ? (
        <div className="segmented view-options">
          <span className="caption">显示</span>
          {['整个盒子', '中间 3σ 厚的切片'].map((label, i) => (
            <button
              key={label}
              aria-pressed={i === slab}
              onClick={() => {
                engine.view.slab = i
                setSlab(i)
              }}
            >
              {label}
            </button>
          ))}
        </div>
      ) : (
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
      )}
    </section>
  )
}
