import type { Mat3 } from '../render/camera'
import type { Bounds } from '../render/Renderer'

export interface Slot {
  /** centre of the panel in view space, Å */
  x: number
  y: number
  halfW: number
  halfH: number
}

export interface Layout {
  mats: Float32Array[]
  slots: Slot[]
  /** width / height of the whole arrangement */
  aspect: number
}

/**
 * Arrange panels in reading order in a grid, for a given viewing rotation.
 * Each panel turns about its own centre and all share one scale, so sizes
 * can be compared. The number of columns is the one whose overall shape is
 * closest to `targetAspect` (width / height).
 */
export function gridLayout(panels: Bounds[], rot: Mat3, targetAspect: number): Layout {
  const ext = panels.map((b) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    const s = b.spheres
    for (let i = 0; i < s.length; i += 4) {
      const dx = s[i]! - b.center[0], dy = s[i + 1]! - b.center[1], dz = s[i + 2]! - b.center[2]
      const x = rot[0]! * dx + rot[3]! * dy + rot[6]! * dz
      const y = rot[1]! * dx + rot[4]! * dy + rot[7]! * dz
      const r = s[i + 3]!
      x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r)
      y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r)
    }
    return { x0, x1, y0, y1 }
  })
  const n = panels.length
  const tallest = Math.max(...ext.map((e) => e.y1 - e.y0))
  const gapX = Math.max(8, tallest * 0.1)
  const gapY = Math.max(14, tallest * 0.22) // room for a caption under each row

  const arrange = (cols: number) => {
    const rows: number[][] = []
    for (let i = 0; i < n; i += cols) rows.push(Array.from({ length: Math.min(cols, n - i) }, (_, k) => i + k))
    const widths = rows.map((r) => r.reduce((s, i) => s + ext[i]!.x1 - ext[i]!.x0, 0) + gapX * (r.length - 1))
    const heights = rows.map((r) => Math.max(...r.map((i) => ext[i]!.y1 - ext[i]!.y0)))
    const W = Math.max(...widths), H = heights.reduce((s, h) => s + h, 0) + gapY * (rows.length - 1)
    return { rows, widths, heights, W, H }
  }
  let best = arrange(n)
  for (let cols = 1; cols < n; cols++) {
    const a = arrange(cols)
    const fit = (x: { W: number; H: number }) => Math.min(x.W / x.H / targetAspect, targetAspect / (x.W / x.H))
    if (fit(a) > fit(best) + 1e-6) best = a
  }

  const mats: Float32Array[] = new Array(n)
  const slots: Slot[] = new Array(n)
  let top = best.H / 2
  best.rows.forEach((row, ri) => {
    const h = best.heights[ri]!
    let left = -best.widths[ri]! / 2
    for (const i of row) {
      const e = ext[i]!
      const w = e.x1 - e.x0
      // where this panel's own centre must sit so that its box fills the cell,
      // standing on the row's baseline
      const cx = left - e.x0
      const cy = top - h - e.y0
      left += w + gapX
      const b = panels[i]!
      // world offset = rot^T * (cx, cy, 0), after moving the panel's centre to the origin
      const ox = rot[0]! * cx + rot[1]! * cy, oy = rot[3]! * cx + rot[4]! * cy, oz = rot[6]! * cx + rot[7]! * cy
      mats[i] = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ox - b.center[0], oy - b.center[1], oz - b.center[2], 1])
      slots[i] = { x: cx + (e.x0 + e.x1) / 2, y: cy + (e.y0 + e.y1) / 2, halfW: w / 2, halfH: (e.y1 - e.y0) / 2 }
    }
    top -= h + gapY
  })
  return { mats, slots, aspect: best.W / best.H }
}
