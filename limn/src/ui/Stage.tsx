import { useEffect, useRef, useState } from 'react'
import { packScene, placedCenter } from '../landscape/build'
import { dragRotate, fit, identity3, type Mat3 } from '../render/camera'
import { Renderer, type View } from '../render/Renderer'
import { buildItem } from '../scene/build'
import { gridLayout, type Slot } from '../scene/layout'
import { MEMBRANE_LCH, useStore, type Look } from '../state/store'
import { atomColors, type Coloring } from '../style/assign'
import { TONE_LANDSCAPE, TONE_MOLECULE, TONE_PAINTED } from '../style/palettes'
import { scaleBar, type ScaleBar } from '../render/scalebar'
import { pick, t, shown } from '../i18n'

/** 双层膜是一片淡黄绿色，如同 Goodsell 画的膜 / The bilayer is one pale yellow-green wash, as in Goodsell's membranes. */
const LIPID_COLORING: Coloring = { roles: ['membrane'], hueShift: [0], nudge: [0], override: [MEMBRANE_LCH] }
/** 生成的 DNA 用核酸的颜色 / generated DNA takes the nucleic-acid colour */
const DNA_COLORING: Coloring = { roles: ['nucleic'], hueShift: [0], nudge: [0], override: [null] }

/** 可见画布的渲染器，与导出和评审循环共用 / The renderer of the visible canvas, shared with export and the review loop. */
export const stage: { renderer: Renderer | null; slots: Slot[] } = { renderer: null, slots: [] }

/**
 * 按这个旋转排布各面板并取景。每次渲染前都要调用：
 * 面板的摆放取决于观察方向和画幅的形状。
 * Lay the panels out for this rotation and frame them. Call before every
 * render: the placement of panels depends on the viewing direction and on
 * the shape of the frame.
 */
export function viewFor(r: Renderer, look: Pick<Look, 'rot' | 'zoom' | 'shift'> & { cut?: number }, aspect: number): View {
  const land = useStore.getState().spec?.landscape
  if (land) {
    // 全景是一块正对着看的固定厚片；画幅裁在它内部，让分子从每条边伸出画外。
    // A landscape is a fixed slab seen face-on; the frame is cropped inside
    // it so that molecules run off every edge.
    stage.slots = []
    const height = Math.min(land.height, land.width / aspect) / look.zoom
    const width = height * aspect
    const cx = Math.max(-(land.width - width) / 2, Math.min((land.width - width) / 2, -look.shift[0] * width))
    const cy = Math.max(-(land.height - height) / 2, Math.min((land.height - height) / 2, -look.shift[1] * height))
    return { rot: identity3(), center: [cx, cy, -land.depth / 2], height, clipFront: Infinity, fogSpan: [-8, -land.depth - 30] }
  }
  const overlay = !!useStore.getState().spec?.overlay
  const n = overlay ? 1 : useStore.getState().panels.length
  if (overlay) r.setPlacements([])
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
  // shift 以画幅的比例计；rot 的各行是屏幕坐标轴在世界空间中的方向
  // shift is in shares of the frame; rows of rot are the screen axes in world space
  const dx = -look.shift[0] * width, dy = -look.shift[1] * height
  const rot = look.rot
  // 剖面：切掉前面的一部分，景深从切面算起 / a cut-away: drop the front part, and let depth fade from the cut face
  const half = v.halfDepth ?? r.bounds.radius
  const cut = look.cut ?? 0
  const clipFront = cut > 0 ? half * (1 - 2 * cut) : Infinity
  // 切片的厚度按画幅高度的比例定，所以放大之后切片也跟着变薄，看到的始终是切面附近的几层
  // the slab's thickness is a share of the frame height, so zooming in thins it too, and what is seen is always the few layers near the cut
  const slab = useStore.getState().style.slab ?? 0
  const clipBack = cut > 0 && slab > 0 ? clipFront - slab * height : undefined
  return {
    ...v,
    clipFront,
    ...(clipBack !== undefined ? { clipBack } : {}),
    fogSpan: cut > 0 ? [clipFront, clipBack ?? -half] : undefined,
    height,
    center: [v.center[0] + dx * rot[0]! + dy * rot[1]!, v.center[1] + dx * rot[3]! + dy * rot[4]!, v.center[2] + dx * rot[6]! + dy * rot[7]!],
  }
}

/** 适合主体的画幅形状：在合理范围内取它自身的比例 / The frame shape that suits the subject: its own proportions, within reason. */
export function figureAspect(r: Renderer, look: Pick<Look, 'rot' | 'zoom' | 'shift'>): number {
  const land = useStore.getState().spec?.landscape
  if (land) return land.width / land.height
  const n = useStore.getState().spec?.overlay ? 1 : useStore.getState().panels.length
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
  const v = fit(r.bounds, look.rot as Mat3, 1e-6) // 高度 = 全宽 ÷ 极小的宽高比 / height = full width / tiny aspect
  const w = fit(r.bounds, look.rot as Mat3, 1e6) // 高度 = 全高 / height = full height
  const ratio = (v.height * 1e-6) / w.height
  return Math.min(1.8, Math.max(0.62, ratio))
}

/** 每个面板的图注放在哪里，以显示 `view` 的 w×h 画幅的像素计 / Where each panel's caption goes, in pixels of a w×h frame showing `view`. */
export function panelLabels(view: View, w: number, h: number): { x: number; y: number; text: string }[] {
  const s = useStore.getState()
  const pxPerA = h / view.height
  const r = view.rot, c = view.center
  const vcx = r[0]! * c[0] + r[3]! * c[1] + r[6]! * c[2]
  const vcy = r[1]! * c[0] + r[4]! * c[1] + r[7]! * c[2]
  return stage.slots.map((sl, i) => ({
    x: w / 2 + (sl.x - vcx) * pxPerA,
    y: h / 2 - (sl.y - sl.halfH - vcy) * pxPerA,
    text: pick(s.panels[i]?.spec.label, s.panels[i]?.spec.labelEn),
  }))
}

export function Stage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [info, setInfo] = useState('')
  const [fatal, setFatal] = useState('')
  const [labels, setLabels] = useState<{ x: number; y: number; text: string }[]>([])
  const [bar, setBar] = useState<ScaleBar | null>(null)
  const panels = useStore((s) => s.panels)
  const sceneRev = useStore((s) => s.sceneRev)
  const colorings = useStore((s) => s.colorings)
  const style = useStore((s) => s.style)
  const rot = useStore((s) => s.rot)
  const zoom = useStore((s) => s.zoom)
  const shift = useStore((s) => s.shift)
  const cut = useStore((s) => s.cut)
  const busy = useStore((s) => s.busy)
  const error = useStore((s) => s.error)
  const drawRev = useStore((s) => s.drawRev)
  // 订阅语言，换语言时重新渲染（下面的提示语）/ subscribe to the language so that a change re-renders (the prompt below)
  useStore((s) => s.lang)
  const pending = useRef(0)
  const settle = useRef(0)

  // 现在先快速画一遍，等不再变化后再以完整质量画。
  // Draw quickly now, and at full quality once things stop changing.
  const draw = (fast: boolean) => {
    cancelAnimationFrame(pending.current)
    pending.current = requestAnimationFrame(() => {
      const r = stage.renderer
      const s = useStore.getState()
      if (!r) return
      if (s.panels.length === 0) {
        // 调整画布大小会把它清成黑色；空舞台应当是白纸
        // resizing a canvas clears it to black; an empty stage should be paper
        r.gl.bindFramebuffer(r.gl.FRAMEBUFFER, null)
        r.gl.clearColor(1, 1, 1, 1)
        r.gl.clear(r.gl.COLOR_BUFFER_BIT)
        return
      }
      const aspect = r.canvas.width / r.canvas.height
      const v = viewFor(r, s, aspect)
      const t0 = performance.now()
      r.render(v, s.style, fast)
      const el = r.canvas as HTMLCanvasElement
      setLabels(panelLabels(v, el.clientWidth, el.clientHeight))
      setBar(scaleBar(v.height / el.clientHeight, el.clientWidth, s.spec?.unit ?? 'Å'))
      if (!fast) {
        // 读一个像素是等待 GPU 的唯一可靠办法
        // reading a pixel is the only reliable way to wait for the GPU
        r.gl.readPixels(0, 0, 1, 1, r.gl.RGBA, r.gl.UNSIGNED_BYTE, new Uint8Array(4))
        const ids = s.panels.map((p) => p.mol.id).join(' · '), ms = Math.round(performance.now() - t0)
        // 有网格或圆台时报它们的数目 / with a mesh or cones, report how many of those there are
        if (r.lastTriangles > 0) setInfo(t(r.lastAtoms > 0 ? 'stage.trianglesAtoms' : 'stage.triangles', { ids, n: r.lastTriangles.toLocaleString(), atoms: r.lastAtoms.toLocaleString(), ms }))
        else if (r.lastSegments > 0) setInfo(t('stage.segments', { ids, n: r.lastSegments.toLocaleString(), ms }))
        // 粗粒度的模型画的是球，不是原子 / a coarse model is drawn in spheres, not atoms
        else setInfo(t(s.spec?.kind === 'neuron' || s.panels.every((p) => p.mol.radius) ? 'stage.spheres' : 'stage.atoms', { ids, n: r.lastAtoms.toLocaleString(), ms }))
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

  // 新的原子：重建 GPU 缓冲 / New atoms: rebuild the GPU buffers.
  useEffect(() => {
    const r = stage.renderer
    if (!r || panels.length === 0) return
    const st = useStore.getState()
    const cs = st.colorings
    const land = st.spec?.landscape
    if (land) {
      const packed = packScene(panels.map((p) => ({ mol: p.mol, assembly: p.spec.assembly, membrane: p.membrane })), land, st.lipids, st.seed)
      let molecule = 0
      const items = panels.map((p, i) =>
        buildItem(p.mol, cs[i] ?? p.coloring, TONE_LANDSCAPE, packed.places[i]!.map((matrix) => ({ assembly: p.spec.assembly, matrix, molecule: molecule++, center: placedCenter(matrix, packed.centers[i]!) }))),
      )
      for (const { mol: lm, places } of packed.lipids) {
        // 双层膜画成一整片（所有脂质共用一个编号）；每个脂质各自归入它所在位置的景深层
        // the bilayer is outlined as one sheet (all lipids share an id); each lipid
        // takes the depth layer of its own position
        const lc: [number, number, number] = [0, 0, 0]
        for (let a = 0; a < lm.atomCount; a++) for (let k = 0; k < 3; k++) lc[k]! += lm.pos[a * 3 + k]! / lm.atomCount
        items.push(buildItem(lm, LIPID_COLORING, TONE_LANDSCAPE, places.map((matrix) => ({ assembly: 'asym', matrix, molecule, center: placedCenter(matrix, lc) }))))
      }
      if (packed.dna) {
        // 生成的 DNA：每条一个编号，画成连续的一条 / generated DNA: one id per strand, each drawn as one continuous strand
        const dna = packed.dna
        items.push(buildItem(dna, DNA_COLORING, TONE_LANDSCAPE, dna.assemblies.slice(1).map((a) => ({ assembly: a.id, molecule: ++molecule, strand: true }))))
      }
      r.setScene(items)
      useStore.setState({ placed: packed.places.map((p) => p.length), dnaPairs: packed.dna ? packed.dna.assemblies.slice(1).reduce((s, a) => s + a.groups.reduce((t, g) => t + g.operators.length, 0), 0) : 0 })
    } else if (st.spec?.mesoscale) {
      r.setScene(panels.map((p, i) => buildItem(p.mol, cs[i] ?? p.coloring, TONE_LANDSCAPE, { assembly: p.spec.assembly, molecule: i * 4_000_000, perCopy: true, merge: st.spec?.merge ? new RegExp(st.spec.merge, 'i') : undefined })))
    } else {
      r.setScene(panels.map((p, i) => buildItem(p.mol, cs[i] ?? p.coloring, st.drawing === 'painted' ? TONE_PAINTED : TONE_MOLECULE, { assembly: p.spec.assembly, molecule: i, matrix: p.align ?? undefined, noCut: p.noCut }, p.annotation)))
    }
    draw(false)
  }, [sceneRev])

  // 只是颜色变了 / New colours only.
  useEffect(() => {
    const r = stage.renderer
    if (!r) return
    const sp = useStore.getState().spec
    const tone = sp?.landscape || sp?.mesoscale ? TONE_LANDSCAPE : useStore.getState().drawing === 'painted' ? TONE_PAINTED : TONE_MOLECULE
    panels.forEach((p, i) => colorings[i] && r.setColors(i, atomColors(p.mol, colorings[i]!, tone, p.annotation)))
    draw(false)
  }, [colorings])

  useEffect(() => draw(false), [style, drawRev])
  useEffect(() => draw(true), [rot, zoom, shift, cut])

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
      if (e.shiftKey || s.spec?.landscape) s.setLook({ shift: [s.shift[0] + dx / canvas.clientWidth, s.shift[1] - dy / canvas.clientHeight] })
      else s.setLook({ rot: dragRotate(s.rot, dx, dy, canvas.clientHeight) })
    }
    const up = () => (last = null)
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const s = useStore.getState()
      const min = s.spec?.landscape ? 1 : 0.2 // 全景不能缩小到超出它的厚片 / a landscape cannot be zoomed out past its slab
      s.setLook({ zoom: Math.min(8, Math.max(min, s.zoom * Math.exp(-e.deltaY * 0.0015))) })
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

  // 嵌入模式没有输入框，所以不显示“输入…开始”的提示 / embed mode has no input box, so the prompt to type something is not shown
  const status = fatal || shown(busy) || shown(error) || info || (new URLSearchParams(location.search).get('embed') === '1' ? '' : t('stage.empty'))
  return (
    <div className="stage">
      <canvas ref={canvasRef} />
      {labels.map((l, i) => (
        <div className="panel-label" key={i} style={{ left: l.x, top: l.y + 6 }}>{l.text}</div>
      ))}
      {bar && panels.length > 0 && (
        <div className={'scalebar' + (style.background[0] * 0.3 + style.background[1] * 0.6 + style.background[2] * 0.1 < 0.5 ? ' dark' : '')}>
          {bar.label}
          <div style={{ width: bar.px }} />
        </div>
      )}
      {status && <div className={'status' + (fatal || (error && !busy) ? ' error' : '')}>{status}</div>}
    </div>
  )
}
