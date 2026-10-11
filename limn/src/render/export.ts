import type { Renderer } from './Renderer'
import type { Look } from '../state/store'
import { figureAspect, panelLabels, viewFor } from '../ui/Stage'
import { useStore } from '../state/store'
import { scaleBar } from './scalebar'

export interface Figure {
  canvas: OffscreenCanvas
  /** the rendered pixels before captions were drawn, for measuring */
  pixels: Uint8ClampedArray
  w: number
  h: number
}

/**
 * Render the scene as a finished figure: framed to the subject's own
 * proportions, with a caption under each panel.
 */
export function renderFigure(r: Renderer, look: Look, longSide: number): Figure {
  const aspect = figureAspect(r, look)
  const w = Math.round(aspect >= 1 ? longSide : longSide * aspect)
  const h = Math.round(aspect >= 1 ? longSide / aspect : longSide)
  const view = viewFor(r, look, w / h)
  const pixels = r.renderPixels(view, look.style, w, h)
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0)
  const size = Math.max(11, Math.round(longSide / 62))
  ctx.font = `${size}px -apple-system, "PingFang SC", "Helvetica Neue", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#26241f'
  for (const l of panelLabels(view, w, h)) ctx.fillText(l.text, l.x, l.y + size * 0.5)
  // 比例尺画在右下角；深色背景上用浅色 / the scale bar goes bottom right, light on a dark background
  const bar = scaleBar(view.height / h, w, useStore.getState().spec?.unit ?? 'Å')
  if (bar) {
    const bg = look.style.background
    const dark = bg[0] * 0.3 + bg[1] * 0.6 + bg[2] * 0.1 < 0.5
    const m = size * 1.4, y = h - m
    ctx.fillStyle = ctx.strokeStyle = dark ? '#f2efe8' : '#26241f'
    ctx.lineWidth = Math.max(2, size * 0.16)
    ctx.beginPath()
    ctx.moveTo(w - m - bar.px, y)
    ctx.lineTo(w - m, y)
    ctx.stroke()
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'
    ctx.fillText(bar.label, w - m, y - size * 0.35)
  }
  return { canvas, pixels, w, h }
}

export function download(blob: Blob, name: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
