import { useEffect, useRef, useState } from 'react'
import { dragRotate, fit, pan } from '../render/camera'
import { Renderer, type View } from '../render/Renderer'
import { buildItem } from '../scene/build'
import { useStore } from '../state/store'
import { atomColors } from '../style/assign'
import { TONE_MOLECULE } from '../style/palettes'

/** The renderer of the visible canvas, for export and for the debug handle. */
export const stage: { renderer: Renderer | null; view: View | null } = { renderer: null, view: null }

export function Stage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [info, setInfo] = useState('')
  const [fatal, setFatal] = useState('')
  const mol = useStore((s) => s.mol)
  const assembly = useStore((s) => s.assembly)
  const sceneRev = useStore((s) => s.sceneRev)
  const coloring = useStore((s) => s.coloring)
  const style = useStore((s) => s.style)
  const view = useStore((s) => s.view)
  const busy = useStore((s) => s.busy)
  const pending = useRef(0)
  const settle = useRef(0)

  // Draw quickly now, and at full quality once things stop changing.
  const draw = (fast: boolean) => {
    cancelAnimationFrame(pending.current)
    pending.current = requestAnimationFrame(() => {
      const r = stage.renderer
      const s = useStore.getState()
      if (!r || !s.mol) return
      const v = s.view ?? fit(r.bounds, undefined, r.canvas.width / r.canvas.height)
      stage.view = v
      const t0 = performance.now()
      r.render(v, s.style, fast)
      if (!fast) {
        // reading a pixel is the only reliable way to wait for the GPU
        r.gl.readPixels(0, 0, 1, 1, r.gl.RGBA, r.gl.UNSIGNED_BYTE, new Uint8Array(4))
        setInfo(`${s.mol.id} · ${r.lastAtoms.toLocaleString()} 个原子 · ${Math.round(performance.now() - t0)} ms`)
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

  useEffect(() => {
    const r = stage.renderer
    if (!r || !mol || !coloring) return
    r.setScene([buildItem(mol, coloring, TONE_MOLECULE, { assembly, molecule: 0 })])
    draw(false)
    // coloring is applied by the effect below; rebuilding here is for new atoms only
  }, [mol, assembly, sceneRev])

  useEffect(() => {
    const r = stage.renderer
    if (!r || !mol || !coloring) return
    r.setColors(0, atomColors(mol, coloring, TONE_MOLECULE))
    draw(false)
  }, [coloring])

  useEffect(() => draw(false), [style])
  useEffect(() => draw(true), [view])

  useEffect(() => {
    const canvas = canvasRef.current!
    let last: { x: number; y: number } | null = null
    const current = (): View | null => {
      const r = stage.renderer
      return r ? (useStore.getState().view ?? fit(r.bounds, undefined, r.canvas.width / r.canvas.height)) : null
    }
    const down = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY }
      canvas.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      const v = current()
      if (!last || !v) return
      const dx = e.clientX - last.x, dy = e.clientY - last.y
      last = { x: e.clientX, y: e.clientY }
      if (e.shiftKey || e.button === 2) {
        const aPerPx = v.height / canvas.clientHeight
        useStore.getState().setView({ ...v, center: pan(v, dx * aPerPx, -dy * aPerPx) })
      } else {
        useStore.getState().setView({ ...v, rot: dragRotate(v.rot, dx, dy, canvas.clientHeight) })
      }
    }
    const up = () => (last = null)
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const v = current()
      if (v) useStore.getState().setView({ ...v, height: v.height * Math.exp(e.deltaY * 0.0015) })
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
      <div className={'status' + (fatal ? ' error' : '')}>{fatal || busy || info || '输入 PDB 编号开始'}</div>
    </div>
  )
}
