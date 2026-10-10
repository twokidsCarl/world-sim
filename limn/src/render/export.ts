import type { Renderer } from './Renderer'
import type { Look } from '../state/store'
import { figureAspect, panelLabels, viewFor } from '../ui/Stage'

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
  return { canvas, pixels, w, h }
}

export function download(blob: Blob, name: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
