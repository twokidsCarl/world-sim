import { useEffect, useRef, useState } from 'react'
import { dragRotate, fit, type Mat3 } from '../render/camera'
import { Renderer, type View } from '../render/Renderer'
import { buildItem } from '../scene/build'
import { gridLayout, type Slot } from '../scene/layout'
import { useStore, type Look } from '../state/store'
import { atomColors } from '../style/assign'
import { TONE_MOLECULE } from '../style/palettes'

/** The renderer of the visible canvas, shared with export and the review loop. */
export const stage: { renderer: Renderer | null; slots: Slot[] } = { renderer: null, slots: [] }

/**
 * Lay the panels out for this rotation and frame them. Call before every
 * render: the placement of panels depends on the viewing direction and on
 * the shape of the frame.
 */
export function viewFor(r: Renderer, look: Pick<Look, 'rot' | 'zoom' | 'shift'>, aspect: number): View {
  const n = useStore.getState().panels.length
  if (n > 1) {
    const locals = Array.from({ length: n }, (_, i) => r.localBounds(i)!).filter(Boolean)
    if (locals.length === n) {
      const { mats, slots } = gridLayout(locals, look.rot, aspect)
      r.setPlacements(mats)
      stage.slots = slots
    }
  } else stage.slots = []
  const v = fit(r.bounds, look.rot as Mat3, aspect, n > 1 ? 1.16 : 1.1)
  const height = v.height / look.zoom
  const width = height * aspect
  // shift is in shares of the frame; rows of rot are the screen axes in world space
  const dx = -look.shift[0] * width, dy = -look.shift[1] * height
  const rot = look.rot
  return {
    ...v,
    height,
    center: [v.center[0] + dx * rot[0]! + dy * rot[1]!, v.center[1] + dx * rot[3]! + dy * rot[4]!, v.center[2] + dx * rot[6]! + dy * rot[7]!],
  }
}

/** The frame shape that suits the subject: its own proportions, within reason. */
export function figureAspect(r: Renderer, look: Pick<Look, 'rot' | 'zoom' | 'shift'>): number {
  const n = useStore.getState().panels.length
  if (n > 1) {
    const locals = Array.from({ length: n }, (_, i) => r.localBounds(i)!).filter(Boolean)
    let best = 1.5, bestFit = 0
    for (const a of [1, 4 / 3, 1.6, 2, 2.4]) {
      const l = gridLayout(locals, look.rot, a)
      const f = Math.min(l.aspect / a, a / l.aspect)
      if (f > bestFit + 0.02) {
        best = a
        bestFit = f
      }
    }
    return best
  }
  const v = fit(r.bounds, look.rot as Mat3, 1e-6) // height = full width / tiny aspect
  const w = fit(r.bounds, look.rot as Mat3, 1e6) // height = full height
  const ratio = (v.height * 1e-6) / w.height
  return Math.min(1.8, Math.max(0.62, ratio))
}

/** Where each panel's caption goes, in pixels of a w×h frame showing `view`. */
export function panelLabels(view: View, w: number, h: number): { x: number; y: number; text: string }[] {
  const s = useStore.getState()
  const pxPerA = h / view.height
  const r = view.rot, c = view.center
  const vcx = r[0]! * c[0] + r[3]! * c[1] + r[6]! * c[2]
  const vcy = r[1]! * c[0] + r[4]! * c[1] + r[7]! * c[2]
  return stage.slots.map((sl, i) => ({
    x: w / 2 + (sl.x - vcx) * pxPerA,
    y: h / 2 - (sl.y - sl.halfH - vcy) * pxPerA,
    text: s.panels[i]?.spec.label ?? '',
  }))
}

export function Stage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [info, setInfo] = useState('')
  const [fatal, setFatal] = useState('')
  const [labels, setLabels] = useState<{ x: number; y: number; text: string }[]>([])
  const panels = useStore((s) => s.panels)
  const sceneRev = useStore((s) => s.sceneRev)
  const colorings = useStore((s) => s.colorings)
  const style = useStore((s) => s.style)
  const rot = useStore((s) => s.rot)
  const zoom = useStore((s) => s.zoom)
  const shift = useStore((s) => s.shift)
  const busy = useStore((s) => s.busy)
  const drawRev = useStore((s) => s.drawRev)
  const pending = useRef(0)
  const settle = useRef(0)

  // Draw quickly now, and at full quality once things stop changing.
  const draw = (fast: boolean) => {
    cancelAnimationFrame(pending.current)
    pending.current = requestAnimationFrame(() => {
      const r = stage.renderer
      const s = useStore.getState()
      if (!r || s.panels.length === 0) return
      const aspect = r.canvas.width / r.canvas.height
      const v = viewFor(r, s, aspect)
      const t0 = performance.now()
      r.render(v, s.style, fast)
      const el = r.canvas as HTMLCanvasElement
      setLabels(panelLabels(v, el.clientWidth, el.clientHeight))
      if (!fast) {
        // reading a pixel is the only reliable way to wait for the GPU
        r.gl.readPixels(0, 0, 1, 1, r.gl.RGBA, r.gl.UNSIGNED_BYTE, new Uint8Array(4))
        setInfo(`${s.panels.map((p) => p.mol.id).join(' · ')} · ${r.lastAtoms.toLocaleString()} 个原子 · ${Math.round(performance.now() - t0)} ms`)
      }
    })
    clearTimeout(settle.current)
    if (fast) settle.current = window.setTimeout(() => draw(false), 160)
  }

  useEffect(() => {
    const canvas = canvasRef.current!
    try {
      stage.renderer = new Renderer(canvas)
    } catch (e) {
      setFatal(e instanceof Error ? e.message : String(e))
      return
    }
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        draw(true)
      }
    }
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    resize()
    return () => ro.disconnect()
  }, [])

  // New atoms: rebuild the GPU buffers.
  useEffect(() => {
    const r = stage.renderer
    if (!r || panels.length === 0) return
    const cs = useStore.getState().colorings
    r.setScene(panels.map((p, i) => buildItem(p.mol, cs[i] ?? p.coloring, TONE_MOLECULE, { assembly: p.spec.assembly, molecule: i, matrix: p.align ?? undefined })))
    draw(false)
  }, [sceneRev])

  // New colours only.
  useEffect(() => {
    const r = stage.renderer
    if (!r) return
    panels.forEach((p, i) => colorings[i] && r.setColors(i, atomColors(p.mol, colorings[i]!, TONE_MOLECULE)))
    draw(false)
  }, [colorings])

  useEffect(() => draw(false), [style, drawRev])
  useEffect(() => draw(true), [rot, zoom, shift])

  useEffect(() => {
    const canvas = canvasRef.current!
    let last: { x: number; y: number } | null = null
    const down = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY }
      canvas.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!last) return
      const dx = e.clientX - last.x, dy = e.clientY - last.y
      last = { x: e.clientX, y: e.clientY }
      const s = useStore.getState()
      if (e.shiftKey) s.setLook({ shift: [s.shift[0] + dx / canvas.clientWidth, s.shift[1] - dy / canvas.clientHeight] })
      else s.setLook({ rot: dragRotate(s.rot, dx, dy, canvas.clientHeight) })
    }
    const up = () => (last = null)
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const s = useStore.getState()
      s.setLook({ zoom: Math.min(8, Math.max(0.2, s.zoom * Math.exp(-e.deltaY * 0.0015))) })
    }
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)
    canvas.addEventListener('wheel', wheel, { passive: false })
    return () => {
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
      canvas.removeEventListener('wheel', wheel)
    }
  }, [])

  return (
    <div className="stage">
      <canvas ref={canvasRef} />
      {labels.map((l, i) => (
        <div className="panel-label" key={i} style={{ left: l.x, top: l.y + 6 }}>{l.text}</div>
      ))}
      <div className={'status' + (fatal ? ' error' : '')}>{fatal || busy || info || '输入一个主题或 PDB 编号开始'}</div>
    </div>
  )
}
