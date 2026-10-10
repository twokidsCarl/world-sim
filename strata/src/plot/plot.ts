// Minimal Canvas2D plotting: draws straight from array-likes, no retained scene.
// Callers redraw every frame, so nothing here allocates per point.

export interface Series {
  x: ArrayLike<number>
  y: ArrayLike<number>
  color: string
  mark: 'line' | 'dash' | 'bars'
}

export interface PlotOptions {
  xLabel?: string
  /** Fixed y range; otherwise auto-scaled to the data. */
  yRange?: [number, number]
  xRange?: [number, number]
  /** Clip auto-scaling to this y range (for curves with a divergence). */
  yClip?: [number, number]
}

export interface Theme {
  ink: string
  muted: string
  rule: string
  accent: string
  data: string
}

let cached: Theme | null = null

export function theme(): Theme {
  if (cached) return cached
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  cached = { ink: v('--ink'), muted: v('--muted'), rule: v('--rule'), accent: v('--accent'), data: v('--data') }
  return cached
}

if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => (cached = null))
}

/** Match the backing store to the CSS size; returns a context scaled to CSS pixels. */
export function fitCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { ctx, w, h }
}

/** Round tick spacing: 1, 2 or 5 times a power of ten, giving about `target` ticks. */
export function niceStep(span: number, target: number): number {
  const raw = span / target
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / pow
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow
}

export function formatTick(v: number, step: number): string {
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a < 1e-3 || a >= 1e5) return v.toExponential(1)
  const decimals = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)))
  return v.toFixed(decimals)
}

function extent(series: Series[], pick: 'x' | 'y', clip?: [number, number]): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const s of series) {
    const a = s[pick]
    for (let i = 0; i < a.length; i++) {
      let v = a[i]!
      if (!Number.isFinite(v)) continue
      if (clip) v = Math.min(clip[1], Math.max(clip[0], v))
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  if (!(hi >= lo)) return [0, 1]
  if (hi === lo) {
    const pad = Math.abs(lo) > 0 ? 0.1 * Math.abs(lo) : 1
    return [lo - pad, hi + pad]
  }
  return [lo, hi]
}

export function drawPlot(canvas: HTMLCanvasElement, series: Series[], opts: PlotOptions = {}): void {
  const { ctx, w, h } = fitCanvas(canvas)
  const t = theme()
  ctx.clearRect(0, 0, w, h)
  const left = 46
  const right = 8
  const top = 8
  const bottom = opts.xLabel ? 34 : 20
  const pw = w - left - right
  const ph = h - top - bottom
  if (pw <= 0 || ph <= 0) return

  const [x0, x1] = opts.xRange ?? extent(series, 'x')
  let [y0, y1] = opts.yRange ?? extent(series, 'y', opts.yClip)
  if (!opts.yRange) {
    const pad = 0.06 * (y1 - y0)
    y0 -= pad
    y1 += pad
  }
  const px = (x: number) => left + ((x - x0) / (x1 - x0 || 1)) * pw
  const py = (y: number) => top + ph - ((y - y0) / (y1 - y0 || 1)) * ph

  ctx.font = '11px Inter, "PingFang SC", system-ui, sans-serif'
  ctx.lineWidth = 1
  ctx.strokeStyle = t.rule
  ctx.fillStyle = t.muted

  const ys = niceStep(y1 - y0, 3)
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let v = Math.ceil(y0 / ys) * ys; v <= y1 + 1e-12 * ys; v += ys) {
    const y = Math.round(py(v)) + 0.5
    ctx.beginPath()
    ctx.moveTo(left, y)
    ctx.lineTo(left + pw, y)
    ctx.stroke()
    ctx.fillText(formatTick(Math.abs(v) < 1e-9 * ys ? 0 : v, ys), left - 6, y)
  }
  const xs = niceStep(x1 - x0, 5)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (let v = Math.ceil(x0 / xs) * xs; v <= x1 + 1e-12 * xs; v += xs) {
    ctx.fillText(formatTick(Math.abs(v) < 1e-9 * xs ? 0 : v, xs), px(v), top + ph + 4)
  }
  if (opts.xLabel) ctx.fillText(opts.xLabel, left + pw / 2, top + ph + 18)

  ctx.save()
  ctx.beginPath()
  ctx.rect(left, top, pw, ph)
  ctx.clip()
  for (const s of series) {
    const n = Math.min(s.x.length, s.y.length)
    if (n === 0) continue
    if (s.mark === 'bars') {
      ctx.fillStyle = s.color
      const bw = n > 1 ? Math.abs(px(s.x[1]!) - px(s.x[0]!)) : pw
      const base = py(Math.max(y0, 0))
      for (let i = 0; i < n; i++) {
        const y = py(s.y[i]!)
        ctx.fillRect(px(s.x[i]!) - bw / 2 + 0.5, Math.min(y, base), Math.max(1, bw - 1), Math.abs(base - y))
      }
      continue
    }
    ctx.strokeStyle = s.color
    ctx.lineWidth = 1.5
    ctx.setLineDash(s.mark === 'dash' ? [5, 4] : [])
    ctx.beginPath()
    let pen = false
    for (let i = 0; i < n; i++) {
      const y = s.y[i]!
      if (!Number.isFinite(y)) {
        pen = false
        continue
      }
      if (pen) ctx.lineTo(px(s.x[i]!), py(y))
      else ctx.moveTo(px(s.x[i]!), py(y))
      pen = true
    }
    ctx.stroke()
    ctx.setLineDash([])
  }
  ctx.restore()
}
