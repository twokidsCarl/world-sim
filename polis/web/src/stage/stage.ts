// 舞台：把回放位置 t 画成一座城。命令式 Canvas 渲染器，订阅 store，自己不持有业务状态。
import {
  AWARE, BELIEF, FEAR, LOST, QUEUEING, STATUS, STATUS_NAMES, UNAWARE, WITHDREW,
  channel, clock, eventsAt, queueRanks, queueSlot, type RunData,
} from '../state/derive.ts' // prettier-ignore
import { useApp } from '../state/store.ts'

interface Palette {
  paper: string
  ink: string
  ink2: string
  wash: string
  edge: string
  rumor: string
  rebut: string
  withdrew: string
  night: string
  nightAlpha: number
  belief: string[]
}

const SERIF = '"Songti SC", "Noto Serif SC", STSong, serif'
const VENUE_GLYPH: Record<string, string> = {
  bank: '钱', teahouse: '茶', market: '市', temple: '庙', school: '学', salon: '发', shop: '店', station: '站',
} // prettier-ignore

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

/** 信念 0..255 → 颜色：一个色相，由浅到深 */
function beliefRamp(stops: string[]): string[] {
  const rgb = stops.map(hexToRgb)
  return Array.from({ length: 256 }, (_, i) => {
    const x = (i / 255) * (rgb.length - 1)
    const a = rgb[Math.floor(x)]!
    const b = rgb[Math.min(rgb.length - 1, Math.floor(x) + 1)]!
    const f = x - Math.floor(x)
    return `rgb(${a.map((v, c) => Math.round(v + (b[c]! - v) * f)).join(',')})`
  })
}

const ease = (x: number) => x * x * (3 - 2 * x)

export class Stage {
  private ctx: CanvasRenderingContext2D
  private w = 0
  private h = 0
  private dpr = 1
  private scale = 1
  private fit = 1
  private ox = 0
  private oy = 0
  private userView = false
  private pal!: Palette
  private edges: HTMLCanvasElement | null = null
  private run: RunData | null = null
  private ranks = new Map<number, Int32Array>()
  private px = new Float32Array(0)
  private py = new Float32Array(0)
  private dirty = true
  private raf = 0
  private last = 0
  private drag: { x: number; y: number; moved: boolean } | null = null
  private cleanup: (() => void)[] = []

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!
    this.readPalette()

    const ro = new ResizeObserver(() => this.resize())
    ro.observe(canvas)
    this.cleanup.push(() => ro.disconnect())
    this.cleanup.push(
      useApp.subscribe((s, prev) => {
        if (s.run !== prev.run) this.setRun(s.run)
        if (s.theme !== prev.theme) this.readPalette()
        this.dirty = true
      }),
    )
    this.listen('pointerdown', this.onDown)
    this.listen('pointermove', this.onMove)
    this.listen('pointerup', this.onUp)
    this.listen('pointerleave', () => useApp.getState().hover(null))
    this.listen('wheel', this.onWheel, { passive: false })
    this.listen('dblclick', () => {
      this.userView = false
      this.fitView()
    })

    this.setRun(useApp.getState().run)
    this.resize()
    this.raf = requestAnimationFrame(this.tick)
  }

  destroy(): void {
    cancelAnimationFrame(this.raf)
    this.cleanup.forEach((f) => f())
  }

  private listen<K extends keyof HTMLElementEventMap>(
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void {
    this.canvas.addEventListener(type, fn, opts)
    this.cleanup.push(() => this.canvas.removeEventListener(type, fn))
  }

  private readPalette(): void {
    this.pal = {
      paper: cssVar('--paper'),
      ink: cssVar('--ink'),
      ink2: cssVar('--ink-2'),
      wash: cssVar('--wash'),
      edge: cssVar('--edge'),
      rumor: cssVar('--rumor'),
      rebut: cssVar('--rebut'),
      withdrew: cssVar('--s-withdrew'),
      night: cssVar('--night'),
      nightAlpha: Number(cssVar('--night-alpha')),
      belief: beliefRamp([cssVar('--b0'), cssVar('--b1'), cssVar('--b2'), cssVar('--b3')]),
    }
    this.edges = null
    this.dirty = true
  }

  private setRun(run: RunData | null): void {
    this.run = run
    this.ranks.clear()
    this.edges = null
    if (run) {
      this.px = new Float32Array(run.manifest.n)
      this.py = new Float32Array(run.manifest.n)
    }
    this.userView = false
    this.fitView()
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect()
    this.dpr = window.devicePixelRatio || 1
    this.w = r.width
    this.h = r.height
    this.canvas.width = Math.round(r.width * this.dpr)
    this.canvas.height = Math.round(r.height * this.dpr)
    if (!this.userView) this.fitView()
    this.edges = null
    this.dirty = true
  }

  private fitView(): void {
    const extent = this.run?.population.extent ?? 1000
    this.fit = Math.min(this.w, this.h) / (extent * 0.88)
    this.scale = this.fit
    this.ox = (this.w - extent * this.scale) / 2
    this.oy = (this.h - extent * this.scale) / 2
    this.edges = null
    this.dirty = true
  }

  // ---- 交互 ----

  private onDown = (e: PointerEvent): void => {
    this.drag = { x: e.clientX, y: e.clientY, moved: false }
    this.canvas.setPointerCapture(e.pointerId)
  }

  private onMove = (e: PointerEvent): void => {
    if (this.drag) {
      const dx = e.clientX - this.drag.x
      const dy = e.clientY - this.drag.y
      if (this.drag.moved || Math.hypot(dx, dy) > 3) {
        this.drag = { x: e.clientX, y: e.clientY, moved: true }
        this.ox += dx
        this.oy += dy
        this.userView = true
        this.edges = null
        this.dirty = true
      }
      return
    }
    const hit = this.pick(e)
    if (hit !== useApp.getState().hovered) useApp.getState().hover(hit)
    this.canvas.style.cursor = hit == null ? 'grab' : 'pointer'
  }

  private onUp = (e: PointerEvent): void => {
    if (this.drag && !this.drag.moved) useApp.getState().select(this.pick(e))
    this.drag = null
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const r = this.canvas.getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    const next = Math.max(this.fit * 0.8, Math.min(this.fit * 8, this.scale * Math.exp(-e.deltaY * 0.0015)))
    this.ox = mx - ((mx - this.ox) * next) / this.scale
    this.oy = my - ((my - this.oy) * next) / this.scale
    this.scale = next
    this.userView = true
    this.edges = null
    this.dirty = true
  }

  private pick(e: PointerEvent): number | null {
    const run = this.run
    if (!run) return null
    const r = this.canvas.getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    let best: number | null = null
    let bestD = 12
    for (const p of run.population.persons) {
      // 主角的点大，给它更大的命中范围
      const d = Math.hypot(this.px[p.idx]! - mx, this.py[p.idx]! - my) - (p.protagonist ? 6 : 0)
      if (d < bestD) {
        bestD = d
        best = p.idx
      }
    }
    return best
  }

  // ---- 时钟与绘制 ----

  private tick = (now: number): void => {
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    const s = useApp.getState()
    if (s.playing && s.run) {
      const t = s.t + dt * s.speed
      if (t >= s.run.manifest.ticks) useApp.setState({ t: s.run.manifest.ticks, playing: false })
      else useApp.setState({ t })
    }
    this.raf = requestAnimationFrame(this.tick)
    if (this.dirty && this.w > 0 && this.h > 0) {
      this.dirty = false
      this.draw()
    }
  }

  private sx = (x: number): number => this.ox + x * this.scale
  private sy = (y: number): number => this.oy + y * this.scale

  private rankAt(k: number): Int32Array {
    let r = this.ranks.get(k)
    if (!r) {
      r = queueRanks(this.run!, k)
      this.ranks.set(k, r)
    }
    return r
  }

  private draw(): void {
    const { ctx, pal, run } = this
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.w, this.h)
    if (!run) return

    const s = useApp.getState()
    const ticks = run.manifest.ticks
    const k = Math.min(ticks, Math.floor(s.t))
    const k1 = Math.min(ticks, k + 1)
    const frac = s.t - k
    const pop = run.population
    const bank = pop.venues[pop.bank]!
    const zoom = Math.pow(Math.max(1, this.scale / this.fit), 0.6)

    // 每个人此刻站在哪：在家，或者在钱庄门口的队伍里
    const st0 = channel(run, k, STATUS)
    const st1 = channel(run, k1, STATUS)
    const r0 = this.rankAt(k)
    const r1 = this.rankAt(k1)
    const f = ease(frac)
    for (const p of pop.persons) {
      const i = p.idx
      const a = st0[i] === QUEUEING ? queueSlot(bank.pos, r0[i]!) : p.pos
      const b = st1[i] === QUEUEING ? queueSlot(bank.pos, r1[i]!) : p.pos
      this.px[i] = this.sx(a[0] + (b[0] - a[0]) * f)
      this.py[i] = this.sy(a[1] + (b[1] - a[1]) * f)
    }

    // 街区：一团淡墨
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const d of pop.districts) {
      const x = this.sx(d.pos[0])
      const y = this.sy(d.pos[1])
      const r = d.radius * 1.35 * this.scale
      const g = ctx.createRadialGradient(x, y, r * 0.1, x, y, r)
      g.addColorStop(0, pal.wash)
      g.addColorStop(1, 'transparent')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }

    this.drawEdges()

    // 选中的人：把他的关系描出来
    if (s.selected != null) {
      ctx.strokeStyle = pal.ink
      ctx.globalAlpha = 0.45
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const j of run.neighbors[s.selected]!) {
        ctx.moveTo(this.px[s.selected]!, this.py[s.selected]!)
        ctx.lineTo(this.px[j]!, this.py[j]!)
      }
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // 这一小时里正在传的话
    const kk = frac > 0 ? k1 : k
    const prog = frac > 0 ? frac : 1
    const now = eventsAt(run, kk)
    for (const e of now) {
      if (e.k !== 'tell' || e.a == null || e.b == null) continue
      const rumor = run.messages[e.m!]!.valence === 1
      const x0 = this.px[e.a]!, y0 = this.py[e.a]!, x1 = this.px[e.b]!, y1 = this.py[e.b]! // prettier-ignore
      const head = ease(Math.min(1, prog * 1.25))
      ctx.strokeStyle = rumor ? pal.rumor : pal.rebut
      ctx.globalAlpha = 0.5 * (1 - 0.6 * prog)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x0 + (x1 - x0) * head, y0 + (y1 - y0) * head)
      ctx.stroke()
      if (prog < 1) {
        ctx.globalAlpha = 0.9
        ctx.fillStyle = rumor ? pal.rumor : pal.rebut
        ctx.beginPath()
        ctx.arc(x0 + (x1 - x0) * head, y0 + (y1 - y0) * head, 1.8 * zoom, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1

    // 告示：从钱庄荡开的一圈
    for (const e of now) {
      if (e.k !== 'broadcast' || prog >= 1) continue
      ctx.strokeStyle = pal.rebut
      ctx.lineWidth = 2
      ctx.globalAlpha = 0.6 * (1 - prog)
      ctx.beginPath()
      ctx.arc(this.sx(bank.pos[0]), this.sy(bank.pos[1]), prog * 520 * this.scale, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // 人
    const b0 = channel(run, k, BELIEF)
    const b1 = channel(run, k1, BELIEF)
    const f0 = channel(run, k, FEAR)
    const f1 = channel(run, k1, FEAR)
    const status = frac > 0.5 ? st1 : st0
    const dot = (i: number, big: boolean): void => {
      const x = this.px[i]!
      const y = this.py[i]!
      const belief = Math.round(b0[i]! + (b1[i]! - b0[i]!) * frac)
      const fear = (f0[i]! + (f1[i]! - f0[i]!) * frac) / 255
      const st = status[i]!
      const base = big ? 5.5 : st === UNAWARE ? 1.5 : 2.3 + 1.5 * fear
      const r = base * zoom
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      if (big) {
        // 主角：纸色衬底把它从人群里托出来
        ctx.fillStyle = pal.paper
        ctx.fill()
        ctx.beginPath()
        ctx.arc(x, y, r - 1.5, 0, Math.PI * 2)
      }
      if (st === WITHDREW) {
        ctx.strokeStyle = pal.withdrew
        ctx.lineWidth = big ? 2 : 1.3
        ctx.stroke()
      } else {
        ctx.fillStyle = st === LOST ? pal.ink : st === UNAWARE && !big ? pal.ink2 : pal.belief[belief]!
        ctx.globalAlpha = st === UNAWARE && !big ? 0.38 : 1
        ctx.fill()
        ctx.globalAlpha = 1
      }
      if (big) {
        ctx.strokeStyle = pal.ink
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    for (const p of pop.persons) if (!p.protagonist) dot(p.idx, false)

    // 场所
    for (const v of pop.venues) {
      const x = this.sx(v.pos[0])
      const y = this.sy(v.pos[1])
      const isBank = v.idx === pop.bank
      const size = (isBank ? 13 : 9) * zoom
      ctx.fillStyle = pal.paper
      ctx.strokeStyle = pal.ink
      ctx.lineWidth = isBank ? 1.6 : 1
      ctx.beginPath()
      ctx.rect(x - size, y - size, size * 2, size * 2)
      ctx.fill()
      ctx.stroke()
      const failed = isBank && run.manifest.summary.failed_at != null && s.t >= run.manifest.summary.failed_at
      if (failed) {
        ctx.fillStyle = pal.ink
        ctx.fillRect(x - size, y - size, size * 2, size * 2)
      }
      ctx.fillStyle = failed ? pal.paper : pal.ink
      ctx.font = `${Math.round(size * 1.25)}px ${SERIF}`
      ctx.fillText(VENUE_GLYPH[v.kind] ?? '', x, y + 1)
      if (isBank && !failed) {
        // 钱庄外的一圈：库里还剩多少现银
        const left = run.series.reserve[k]! + (run.series.reserve[k1]! - run.series.reserve[k]!) * frac
        const full = run.manifest.params.reserve_ratio ?? 0.3
        ctx.strokeStyle = pal.ink
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.arc(x, y, size * 1.75, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, left / full))
        ctx.stroke()
      }
    }

    for (const p of pop.persons) if (p.protagonist) dot(p.idx, true)

    // 字：街区名、场所名、主角名
    const label = (text: string, x: number, y: number, font: string, color: string, alpha = 1): void => {
      ctx.font = font
      ctx.lineJoin = 'round'
      ctx.lineWidth = 3.5
      ctx.strokeStyle = pal.paper
      ctx.globalAlpha = alpha
      ctx.strokeText(text, x, y)
      ctx.fillStyle = color
      ctx.fillText(text, x, y)
      ctx.globalAlpha = 1
    }
    for (const d of pop.districts) {
      label(d.name, this.sx(d.pos[0]), this.sy(d.pos[1] - d.radius * 1.08), `600 15px ${SERIF}`, pal.ink2, 0.9)
    }
    for (const v of pop.venues) {
      const size = (v.idx === pop.bank ? 13 : 9) * zoom
      label(v.name, this.sx(v.pos[0]), this.sy(v.pos[1]) + size * (v.idx === pop.bank ? 1.75 : 1) + 11, `12px ${SERIF}`, pal.ink) // prettier-ignore
    }
    ctx.textAlign = 'left'
    for (const p of run.cast) {
      label(p.name, this.px[p.idx]! + 8 * zoom, this.py[p.idx]!, `600 12.5px ${SERIF}`, pal.ink)
    }

    // 选中与悬停
    const ring = (i: number, r: number, width: number): void => {
      ctx.strokeStyle = pal.ink
      ctx.lineWidth = width
      ctx.beginPath()
      ctx.arc(this.px[i]!, this.py[i]!, r * zoom, 0, Math.PI * 2)
      ctx.stroke()
    }
    if (s.selected != null) ring(s.selected, 10, 2)
    if (s.hovered != null && s.hovered !== s.selected) {
      ring(s.hovered, 8, 1.2)
      const p = pop.persons[s.hovered]!
      if (!p.protagonist) {
        const pct = Math.round((b0[p.idx]! / 255) * 100)
        const text = `${p.name} · ${STATUS_NAMES[st0[p.idx]!]}${st0[p.idx] === AWARE ? ` · 信${pct}%` : ''}`
        label(text, this.px[p.idx]! + 12 * zoom, this.py[p.idx]!, `12.5px ${SERIF}`, pal.ink)
      }
    }

    // 夜色
    const c = clock(run, s.t)
    const hour = c.hour + frac
    const night = hour >= 23 || hour < 5 ? 1 : hour >= 21 ? (hour - 21) / 2 : hour < 7 ? (7 - hour) / 2 : 0
    if (night > 0) {
      ctx.fillStyle = pal.night
      ctx.globalAlpha = pal.nightAlpha * night
      ctx.fillRect(0, 0, this.w, this.h)
      ctx.globalAlpha = 1
    }
  }

  /** 关系网几千条线，画一次存起来；视图或主题变了再重画 */
  private drawEdges(): void {
    const run = this.run!
    if (!this.edges) {
      const c = document.createElement('canvas')
      c.width = this.canvas.width
      c.height = this.canvas.height
      const g = c.getContext('2d')!
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      g.strokeStyle = this.pal.edge
      g.lineWidth = 0.6
      g.beginPath()
      const ps = run.population.persons
      for (const t of run.population.ties) {
        const a = ps[t.a]!.pos
        const b = ps[t.b]!.pos
        g.moveTo(this.sx(a[0]), this.sy(a[1]))
        g.lineTo(this.sx(b[0]), this.sy(b[1]))
      }
      g.stroke()
      this.edges = c
    }
    this.ctx.drawImage(this.edges, 0, 0, this.w, this.h)
  }
}
