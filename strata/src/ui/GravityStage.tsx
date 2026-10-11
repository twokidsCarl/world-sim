import { useEffect, useRef } from 'react'
import { fitCanvas, theme } from '../plot/plot'
import { parseHex } from '../render/points'
import { Points3dRenderer } from '../render/points3d'
import type { GravityBackend, GravityCpuBackend, GravityGpuBackend } from '../substrates/gravity/backend'
import { engine } from './engine'
import { useUi } from './store'

/** 视图的半宽，以初始半径为单位。 / Half-width of the view in units of the initial radius. */
const EXTENT = 2.2
/**
 * 视图绕竖直轴缓慢转动，以便看出纵深结构。
 * The view turns slowly about the vertical axis so the depth structure can be read.
 */
const viewAngle = () => performance.now() * 1e-4

function CpuCanvas() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(
    () =>
      engine.onFrame(() => {
        const canvas = ref.current
        if (!canvas || engine.backend.kind !== 'cpu') return
        const s = (engine.backend as GravityCpuBackend).state
        const c = (engine.backend as GravityCpuBackend).centre
        const { ctx, w, h } = fitCanvas(canvas)
        ctx.clearRect(0, 0, w, h)
        ctx.fillStyle = theme().ink
        ctx.globalAlpha = 0.6
        const angle = viewAngle()
        const scale = h / (2 * EXTENT)
        for (let i = 0; i < s.n; i++) {
          const dx = s.pos[3 * i]! - c[0]
          const dz = s.pos[3 * i + 2]! - c[2]
          const x = dx * Math.cos(angle) + dz * Math.sin(angle)
          ctx.fillRect(w / 2 + x * scale - 1, h / 2 - (s.pos[3 * i + 1]! - c[1]) * scale - 1, 2, 2)
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
      const b = engine.backend as GravityGpuBackend
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      renderer.draw(context.getCurrentTexture().createView(), b.pos, b.n, EXTENT, b.centre, viewAngle(), parseHex(theme().ink), [w, h])
    })
  }, [])
  return <canvas ref={ref} className="stage" />
}

export function GravityStage() {
  const kind = useUi((s) => s.backendKind)
  const infoRef = useRef<HTMLSpanElement>(null)
  useEffect(
    () =>
      engine.onFrame(() => {
        const b = engine.backend as GravityBackend
        if (infoRef.current) {
          infoRef.current.textContent = `${b.n} 个天体 · 第 ${b.stepCount} 步 · 三维，视角跟随团块中心并绕竖直轴缓慢转动`
        }
      }),
    [],
  )
  return (
    <section className="stage-wrap">
      <div className="square">{kind === 'gpu' ? <GpuCanvas /> : <CpuCanvas />}</div>
      <span ref={infoRef} className="caption" />
    </section>
  )
}
