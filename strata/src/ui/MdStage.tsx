import { useEffect, useRef, useState } from 'react'
import { fitCanvas, theme } from '../plot/plot'
import { PointsRenderer, SPECIES_B, mapTopFor, parseHex, viridis } from '../render/points'
import { Points3dRenderer } from '../render/points3d'
import { psi6 } from '../substrates/md/ref/reducers'
import type { MdBackend, MdCpuBackend } from '../substrates/md/backend-cpu'
import type { MdGpuBackend } from '../substrates/md/backend-gpu'
import { engine } from './engine'
import { useUi } from './store'

/**
 * 三维视图绕竖直轴缓慢转动，以便看出纵深结构。
 * The 3D view turns slowly about the vertical axis so the depth structure can be read.
 */
const viewAngle = () => (engine.view.front ? 0 : performance.now() * 1e-4)

function caption(el: HTMLElement | null): void {
  if (!el) return
  const b = engine.backend as MdBackend
  const box = Array.from(b.box.subarray(0, b.dim), (v) => v.toFixed(1)).join(' × ')
  el.textContent =
    `${b.n} 个粒子 · 第 ${b.stepCount} 步 · 盒子 ${box} σ` +
    (b.dim === 3 ? (engine.view.front ? ' · 正视：x 向右，y 向上' : ' · 视角绕竖直轴缓慢转动') : '') +
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
        canvas.parentElement?.style.setProperty('--aspect', String(s.dim === 3 ? 1 : s.box[0] / s.box[1]))
        const { ctx, w } = fitCanvas(canvas)
        ctx.clearRect(0, 0, w, canvas.clientHeight)
        if (s.dim === 3) {
          // 绕竖直轴旋转之后做正交投影。
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
        // 按填充颜色分批绘制，每批一种颜色：单独一批，或按 |ψ6| 分成 16 档。
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
      canvas.parentElement?.style.setProperty('--aspect', String(b.dim === 3 ? 1 : b.box[0]! / b.box[1]!))
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
          {
            radius: 0.45,
            alpha: 0.8,
            slab: engine.view.slab ? SLAB_HALF : 0,
            second: parseHex(SPECIES_B),
            scalar: engine.view.colour3d ? { buffer: b.q6, mapTop: mapTopFor(theme().paper) } : undefined,
          },
        )
        return
      }
      renderer.draw(context.getCurrentTexture().createView(), b, b.n, b.box, parseHex(theme().ink), [w, h], engine.view.colour ?? 0, mapTopFor(theme().paper))
    })
  }, [])
  return <canvas ref={ref} className="stage" />
}

const COLOURS = ['单色', '局域六角序 |ψ₆|', '粒子种类']
/**
 * 穿过三维盒子中部的薄层的半厚度，以 σ 为单位。
 * Half-thickness, in σ, of the slice through the middle of a 3D box.
 */
const SLAB_HALF = 1.5

/**
 * 鼠标停在 g(r) 图上时，以第 0 号粒子为圆心画出对应半径的圆：图上的峰就是圆上挤着的邻居。
 * While the pointer is over the g(r) plot, draw a circle of that radius around particle 0:
 * a peak in the plot is the neighbours crowding on the circle.
 */
function ShellRing() {
  const ref = useRef<HTMLElement>(null)
  useEffect(
    () =>
      engine.onFrame(() => {
        const el = ref.current
        if (!el) return
        const b = engine.backend as MdBackend
        const r = engine.view.shell ?? 0
        const at = b.tracked
        if (!(r > 0) || !at || b.dim !== 2) {
          el.hidden = true
          return
        }
        el.hidden = false
        el.style.left = `${((at[0]! - r) / b.box[0]!) * 100}%`
        el.style.top = `${((at[1]! - r) / b.box[1]!) * 100}%`
        el.style.width = `${((2 * r) / b.box[0]!) * 100}%`
        el.style.height = `${((2 * r) / b.box[1]!) * 100}%`
      }),
    [],
  )
  return <i ref={ref} className="shell" hidden />
}

/**
 * 在舞台上拖出一个矩形选区；右侧各层会同时画出选区内的取值。仅二维。
 * Drag a rectangle on the stage; the level cards then also draw the values inside it. 2D only.
 */
/** 三维正视图里盒子只占画面的 2/3（见投影的缩放）。 / In the 3D front view the box spans only 2/3 of the picture (see the projection's scale). */
const VIEW3D_SPAN = 1.5

function RegionBrush({ three = false }: { three?: boolean }) {
  type Rect = { x0: number; y0: number; x1: number; y1: number }
  const [drag, setDragState] = useState<Rect | null>(null)
  // 拖动的当前值另存一份在 ref 里：事件可能在下一次渲染之前接连到来，闭包里的 state 会是旧的。
  // The live drag is also kept in a ref: events can arrive back to back before the next
  // render, when the state captured by the handlers would be stale.
  const live = useRef<Rect | null>(null)
  const setDrag = (r: Rect | null) => {
    live.current = r
    setDragState(r)
  }
  const hasRegion = useUi((s) => s.hasRegion)
  const ref = useRef<HTMLDivElement>(null)
  // 鼠标位置换成 0..1 的相对坐标 / Pointer position as fractions 0..1 of the stage
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }
  const box = () => (engine.backend as MdBackend).box
  // 画面上的相对坐标与盒子坐标互换。二维：画面就是盒子，y 向下。三维正视：盒子居中、占 2/3，y 向上。
  // Between fractions of the picture and box coordinates. 2D: the picture is the box, y downwards.
  // 3D front view: the box is centred, spans 2/3, and y points up.
  const toBox = (fx: number, fy: number): [number, number] => {
    const [lx, ly] = [box()[0]!, box()[1]!]
    if (!three) return [fx * lx, fy * ly]
    const clamp = (v: number, L: number) => Math.min(L, Math.max(0, v))
    return [clamp(lx / 2 + (fx - 0.5) * VIEW3D_SPAN * lx, lx), clamp(ly / 2 - (fy - 0.5) * VIEW3D_SPAN * lx, ly)]
  }
  const toPicture = (x: number, y: number): [number, number] => {
    const [lx, ly] = [box()[0]!, box()[1]!]
    if (!three) return [x / lx, y / ly]
    return [0.5 + (x - lx / 2) / (VIEW3D_SPAN * lx), 0.5 - (y - ly / 2) / (VIEW3D_SPAN * lx)]
  }
  // 已定下的选区，换回相对坐标来画 / The committed region, back in fractions for drawing
  const committed = (() => {
    if (!engine.region) return null
    const [x0, y0] = toPicture(engine.region[0], engine.region[1])
    const [x1, y1] = toPicture(engine.region[2], engine.region[3])
    return { x0, y0, x1, y1 }
  })()
  const shown = drag ?? (hasRegion ? committed : null)
  return (
    <div
      ref={ref}
      className="brush"
      onPointerDown={(e) => {
        const p = at(e)
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
      }}
      onPointerMove={(e) => {
        if (!live.current) return
        const p = at(e)
        setDrag({ ...live.current, x1: p.x, y1: p.y })
      }}
      onPointerUp={(e) => {
        if (!live.current) return
        const end = at(e)
        const d = { ...live.current, x1: end.x, y1: end.y }
        const x0 = Math.min(d.x0, d.x1)
        const x1 = Math.max(d.x0, d.x1)
        const y0 = Math.min(d.y0, d.y1)
        const y1 = Math.max(d.y0, d.y1)
        setDrag(null)
        // 太小的拖动当作点击：清除选区 / A tiny drag is a click: clear the region
        if (x1 - x0 < 0.01 || y1 - y0 < 0.01) engine.setRegion(null)
        else {
          const a = toBox(x0, y0)
          const b = toBox(x1, y1)
          const region: [number, number, number, number] = [
            Math.min(a[0], b[0]),
            Math.min(a[1], b[1]),
            Math.max(a[0], b[0]),
            Math.max(a[1], b[1]),
          ]
          // 拖在盒子外面：选区是空的，当作清除。 / Dragged outside the box: an empty region, treated as a clear.
          engine.setRegion(region[2] > region[0] && region[3] > region[1] ? region : null)
        }
      }}
    >
      {shown && (
        <i
          style={{
            left: `${Math.min(shown.x0, shown.x1) * 100}%`,
            top: `${Math.min(shown.y0, shown.y1) * 100}%`,
            width: `${Math.abs(shown.x1 - shown.x0) * 100}%`,
            height: `${Math.abs(shown.y1 - shown.y0) * 100}%`,
          }}
        />
      )}
    </div>
  )
}

export function MdStage() {
  const kind = useUi((s) => s.backendKind)
  const [colour, setColour] = useState(engine.view.colour ?? 0)
  const mixture = useUi((s) => s.params.fractionB! > 0)
  const three = useUi((s) => s.params.dim === 3)
  const hasRegion = useUi((s) => s.hasRegion)
  const [slab, setSlab] = useState(engine.view.slab ?? 0)
  const [colour3d, setColour3d] = useState(engine.view.colour3d ?? 0)
  const [front, setFront] = useState(engine.view.front ?? 0)
  // 一旦有两种粒子就显示粒子种类。 / Show the species as soon as there are two of them.
  useEffect(() => {
    const next = mixture ? 2 : engine.view.colour === 2 ? 0 : (engine.view.colour ?? 0)
    engine.view.colour = next
    setColour(next)
  }, [mixture])
  const infoRef = useRef<HTMLSpanElement>(null)
  useEffect(() => engine.onFrame(() => caption(infoRef.current)), [])
  return (
    <section className="stage-wrap">
      <div className="stage-frame">
        {kind === 'gpu' ? <GpuCanvas /> : <CpuCanvas />}
        {(!three || front === 1) && <RegionBrush three={three} key={three ? 'front' : 'flat'} />}
        {!three && <ShellRing />}
      </div>
      <span ref={infoRef} className="caption" />
      {(!three || front === 1) && (
        <span className="caption">
          {hasRegion ? '橙色线是选区内的取值；在舞台上单击可清除选区。' : '在舞台上拖出一个矩形，可单独统计那一块区域。'}
          {three && '三维里选区是这个矩形沿视线方向贯穿整个盒子的柱体。'}
        </span>
      )}
      {three ? (
        <div className="segmented view-options">
          <span className="caption">着色</span>
          {['单色', '键取向序 q̄₆'].map((label, i) => (
            <button
              key={label}
              aria-pressed={i === colour3d}
              onClick={() => {
                engine.view.colour3d = i
                setColour3d(i)
              }}
            >
              {label}
            </button>
          ))}
          {colour3d === 1 && <span className="colourbar" title="q̄₆ 从 0 到 0.6" />}
          <span className="caption">视角</span>
          {['转动', '正视（可框选区）'].map((label, i) => (
            <button
              key={label}
              aria-pressed={i === front}
              onClick={() => {
                engine.view.front = i
                setFront(i)
                // 选区只在正视图里看得见，转动时清掉。 / The region is visible only in the front view; clear it when rotating.
                if (i === 0) engine.setRegion(null)
              }}
            >
              {label}
            </button>
          ))}
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
