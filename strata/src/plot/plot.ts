// 极简的 Canvas2D 绘图：直接从类数组对象绘制，不保留场景。
// 调用方每帧重绘，因此这里不做任何逐点的内存分配。
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
  /** 固定的 y 范围；否则按数据自动缩放。 / Fixed y range; otherwise auto-scaled to the data. */
  yRange?: [number, number]
  xRange?: [number, number]
  /**
   * 把自动缩放限制在这个 y 范围内（用于有发散的曲线）。
   * Clip auto-scaling to this y range (for curves with a divergence).
   */
  yClip?: [number, number]
}

export interface Theme {
  paper: string
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
  cached = { paper: v('--paper'), ink: v('--ink'), muted: v('--muted'), rule: v('--rule'), accent: v('--accent'), data: v('--data') }
  return cached
}

/** 清除缓存的颜色；主题切换后调用。 / Forget the cached colours; call after the theme changes. */
export function invalidateTheme(): void {
  cached = null
}

if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', invalidateTheme)
}

/**
 * 使后备存储的尺寸与 CSS 尺寸匹配；返回已缩放到 CSS 像素的上下文。
 * Match the backing store to the CSS size; returns a context scaled to CSS pixels.
 */
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

/**
 * 取整的刻度间隔：10 的幂的 1、2 或 5 倍，给出大约 `target` 个刻度。
 * Round tick spacing: 1, 2 or 5 times a power of ten, giving about `target` ticks.
 */
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

/**
 * 画布横向像素与数据 x 值之间的换算，供悬停时反查。
 * The mapping between horizontal canvas pixels and data x values, for looking up what is under the pointer.
 */
export interface PlotScale {
  left: number
  width: number
  x0: number
  x1: number
}

export function drawPlot(canvas: HTMLCanvasElement, series: Series[], opts: PlotOptions = {}): PlotScale | null {
  const { ctx, w, h } = fitCanvas(canvas)
  const t = theme()
  ctx.clearRect(0, 0, w, h)
  const left = 46
  const right = 8
  const top = 8
  const bottom = opts.xLabel ? 34 : 20
  const pw = w - left - right
  const ph = h - top - bottom
  if (pw <= 0 || ph <= 0) return null

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
  return { left, width: pw, x0, x1 }
}
