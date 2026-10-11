import { useEffect, useRef, useState } from 'react'
import { fitCanvas, theme } from '../plot/plot'
import { parseHex } from '../render/points'
import { Points3dRenderer } from '../render/points3d'
import type { MeshBackend, MeshCpuBackend, MeshGpuBackend } from '../substrates/mesh/backend'
import { engine } from './engine'
import { useUi } from './store'

/** 视图的半宽：盒子边长为 1，占画面的三分之二。 / Half-width of the view: the unit box spans two thirds of the picture. */
const EXTENT = 0.75
/** 薄片的半厚度。 / Half-thickness of the slab. */
const SLAB_HALF = 0.04
const viewAngle = () => (engine.view.meshFront ? 0 : performance.now() * 1e-4)

function CpuCanvas() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(
    () =>
      engine.onFrame(() => {
        const canvas = ref.current
        if (!canvas || engine.backend.kind !== 'cpu') return
        const s = (engine.backend as MeshCpuBackend).state
        const { ctx, w, h } = fitCanvas(canvas)
        ctx.clearRect(0, 0, w, h)
        ctx.fillStyle = theme().ink
        ctx.globalAlpha = 0.5
        const angle = viewAngle()
        const slab = engine.view.meshSlab ? SLAB_HALF : Infinity
        const scale = h / (2 * EXTENT)
        for (let i = 0; i < s.n; i++) {
          const dx = s.pos[3 * i]! - 0.5
          const dz = s.pos[3 * i + 2]! - 0.5
          if (Math.abs(dz * Math.cos(angle) - dx * Math.sin(angle)) > slab) continue
          const x = dx * Math.cos(angle) + dz * Math.sin(angle)
          ctx.fillRect(w / 2 + x * scale - 0.5, h / 2 - (s.pos[3 * i + 1]! - 0.5) * scale - 0.5, 1, 1)
        }
        ctx.globalAlpha = 1
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
    const renderer = new Points3dRenderer(gpu.device, gpu.format)
    return engine.onFrame(() => {
      if (engine.backend.kind !== 'gpu') return
      const b = engine.backend as MeshGpuBackend
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      const slab = engine.view.meshSlab === 1
      renderer.draw(context.getCurrentTexture().createView(), b.pos, b.n, EXTENT, [0.5, 0.5, 0.5], viewAngle(), parseHex(theme().ink), [w, h], {
        radius: slab ? 0.0022 : 0.0016,
        alpha: slab ? 0.85 : 0.3,
        slab: slab ? SLAB_HALF : 0,
      })
    })
  }, [])
  return <canvas ref={ref} className="stage" />
}

export function MeshStage() {
  const kind = useUi((s) => s.backendKind)
  const [front, setFront] = useState(engine.view.meshFront ?? 0)
  const [slab, setSlab] = useState(engine.view.meshSlab ?? 0)
  const infoRef = useRef<HTMLSpanElement>(null)
  useEffect(
    () =>
      engine.onFrame(() => {
        const b = engine.backend as MeshBackend
        if (infoRef.current) {
          infoRef.current.textContent = `${b.n} 个粒子 · ${b.M}³ 的网格 · 第 ${b.stepCount} 步 · 周期盒子，边长 1`
        }
      }),
    [],
  )
  const option = (key: 'meshFront' | 'meshSlab', value: number, set: (v: number) => void, labels: string[]) =>
    labels.map((label, i) => (
      <button
        key={label}
        aria-pressed={i === value}
        onClick={() => {
          engine.view[key] = i
          set(i)
        }}
      >
        {label}
      </button>
    ))
  return (
    <section className="stage-wrap">
      <div className="square">{kind === 'gpu' ? <GpuCanvas /> : <CpuCanvas />}</div>
      <span ref={infoRef} className="caption" />
      <div className="segmented view-options">
        <span className="caption">视角</span>
        {option('meshFront', front, setFront, ['转动', '正视'])}
        <span className="caption">显示</span>
        {option('meshSlab', slab, setSlab, ['整个盒子', '中间的薄片'])}
      </div>
    </section>
  )
}
