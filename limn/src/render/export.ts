import type { Renderer, View } from './Renderer'
import type { Style } from './style'

/** Render at `longSide` pixels with the canvas's aspect ratio and return a PNG. */
export async function exportPng(r: Renderer, view: View, style: Style, longSide: number): Promise<Blob> {
  const aspect = r.canvas.width / r.canvas.height
  const w = Math.round(aspect >= 1 ? longSide : longSide * aspect)
  const h = Math.round(aspect >= 1 ? longSide / aspect : longSide)
  const pixels = r.renderPixels(view, style, w, h)
  const c = new OffscreenCanvas(w, h)
  c.getContext('2d')!.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0)
  return c.convertToBlob({ type: 'image/png' })
}

export function download(blob: Blob, name: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
