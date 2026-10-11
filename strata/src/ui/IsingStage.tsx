import { useEffect, useRef } from 'react'
import { fitCanvas, theme } from '../plot/plot'
import { LatticeRenderer, type LatticeView } from '../render/lattice'
import { STATE_COLOURS } from '../render/palette'
import { parseHex } from '../render/points'
import type { IsingBackend, IsingCpuBackend, IsingGpuBackend } from '../substrates/ising/backend'
import type { Ising3dCpuBackend, Ising3dGpuBackend } from '../substrates/ising/backend3d'
import type { PottsBackend, PottsCpuBackend, PottsGpuBackend } from '../substrates/potts/backend'
import { engine } from './engine'
import { useUi } from './store'

const SHOWN = 4

/**
 * 被模拟的晶格占满左侧的正方形；其后三级粗粒化叠成一列，
 * 列宽为其边长的三分之一，因此画布是 4:3。
 * The simulated lattice fills a square on the left; the next three coarsenings stack in
 * a column a third of its side, so the canvas is 4:3.
 */
function rects(w: number, h: number): [number, number, number, number][] {
  const small = h / 3
  // 每个图块向内缩进，以免相邻晶格看起来像一幅图。
  // Inset each tile so neighbouring lattices do not read as one image.
  const gap = Math.max(1, Math.round(h / 200))
  const tile = (x: number, y: number, size: number): [number, number, number, number] => [
    x + gap,
    y + gap,
    size - 2 * gap,
    size - 2 * gap,
  ]
  return [tile(0, 0, h), tile(w - small, 0, small), tile(w - small, small, small), tile(w - small, 2 * small, small)]
}

function CpuCanvas({ palette = false }: { palette?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const scratch = document.createElement('canvas')
    return engine.onFrame(() => {
      const canvas = ref.current
      if (!canvas || engine.backend.kind !== 'cpu') return
      const b = engine.backend as IsingCpuBackend | Ising3dCpuBackend | PottsCpuBackend
      const { ctx, w, h } = fitCanvas(canvas)
      ctx.clearRect(0, 0, w, h)
      ctx.imageSmoothingEnabled = false
      const [r, g, bl] = parseHex(theme().ink).map((c) => Math.round(c * 255)) as [number, number, number]
      const layout = rects(w, h)
      b.slices()
        .slice(0, SHOWN)
        .forEach(({ size, cells: spins }, k) => {
          scratch.width = scratch.height = size
          const sctx = scratch.getContext('2d')!
          const image = sctx.createImageData(size, size)
          for (let i = 0; i < size * size; i++) {
            const c = palette ? STATE_COLOURS[spins[i]! & 7]! : [r, g, bl]
            image.data[4 * i] = c[0]!
            image.data[4 * i + 1] = c[1]!
            image.data[4 * i + 2] = c[2]!
            image.data[4 * i + 3] = palette ? 255 : spins[i]! * 255
          }
          sctx.putImageData(image, 0, 0)
          ctx.drawImage(scratch, ...layout[k]!)
        })
    })
  }, [palette])
  return <canvas ref={ref} className="stage wide" />
}

function GpuCanvas({ palette = false }: { palette?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const gpu = engine.gpu
    if (!canvas || !gpu) return
    const context = canvas.getContext('webgpu')!
    context.configure({ device: gpu.device, format: gpu.format, alphaMode: 'premultiplied' })
    const renderer = new LatticeRenderer(gpu.device, gpu.format)
    return engine.onFrame(() => {
      if (engine.backend.kind !== 'gpu') return
      const b = engine.backend as IsingGpuBackend | Ising3dGpuBackend | PottsGpuBackend
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(4, Math.round(canvas.clientWidth * dpr))
      const h = Math.max(3, Math.round(canvas.clientHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      const layout = rects(w, h)
      const views: LatticeView[] = b
        .latticeViews()
        .slice(0, SHOWN)
        .map((v, k) => ({ ...v, rect: layout[k]!.map(Math.floor) as LatticeView['rect'] }))
      const encoder = gpu.device.createCommandEncoder()
      b.encodePyramid(encoder)
      renderer.draw(encoder, context.getCurrentTexture().createView(), views, parseHex(theme().ink), palette)
      gpu.device.queue.submit([encoder.finish()])
    })
  }, [palette])
  return <canvas ref={ref} className="stage wide" />
}

export function IsingStage() {
  const kind = useUi((s) => s.backendKind)
  const infoRef = useRef<HTMLSpanElement>(null)
  useEffect(
    () =>
      engine.onFrame(() => {
        const b = engine.backend as IsingBackend
        if (infoRef.current) {
          infoRef.current.textContent =
            (b.dim === 3 ? `${b.L}³ 个自旋（画的是正中间的截面）` : `${b.L} × ${b.L} 个自旋`) +
            ` · 第 ${b.stepCount} 次扫描 · 左：原始晶格；右：块边长 2、4、8 的多数表决粗粒化`
        }
      }),
    [],
  )
  return (
    <section className="stage-wrap">
      {kind === 'gpu' ? <GpuCanvas /> : <CpuCanvas />}
      <span ref={infoRef} className="caption" />
    </section>
  )
}

export function PottsStage() {
  const kind = useUi((s) => s.backendKind)
  const infoRef = useRef<HTMLSpanElement>(null)
  useEffect(
    () =>
      engine.onFrame(() => {
        const b = engine.backend as PottsBackend
        if (infoRef.current) {
          infoRef.current.textContent = `${b.L} × ${b.L} 个格点，${b.q} 种状态各一种颜色 · 第 ${b.stepCount} 次扫描 · 左：原始晶格；右：块边长 2、4、8 的相对多数粗粒化`
        }
      }),
    [],
  )
  return (
    <section className="stage-wrap">
      {kind === 'gpu' ? <GpuCanvas palette /> : <CpuCanvas palette />}
      <span ref={infoRef} className="caption" />
    </section>
  )
}
