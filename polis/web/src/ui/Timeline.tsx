// 时间轴：播放控制 + 宏观曲线。人数四条线共用一根纵轴；钱庄现银是比例，单独一条窄图。
import { useEffect, useRef, useState } from 'react'
import { clock, clockText, dayName, type RunData } from '../state/derive.ts'
import { useApp } from '../state/store.ts'
import { describe } from './Lab.tsx'

const SERIES = [
  { key: 'aware', name: '听说了', color: 'var(--s-aware)' },
  { key: 'believers', name: '相信', color: 'var(--s-believe)' },
  { key: 'queue', name: '在排队', color: 'var(--s-queue)' },
  { key: 'withdrew', name: '已取款', color: 'var(--s-withdrew)' },
] as const

const SPEEDS = [1, 2, 4, 8, 16]
const M = { l: 42, r: 14, t: 16 }
const H1 = 96
const GAP = 14
const H2 = 30
const AXIS = 16

export function Timeline() {
  const run = useApp((s) => s.run)
  const t = useApp((s) => s.t)
  const playing = useApp((s) => s.playing)
  const speed = useApp((s) => s.speed)
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(e!.contentRect.width))
    ro.observe(box.current!)
    return () => ro.disconnect()
  }, [])

  return (
    <footer className="timeline">
      {run && <Controls run={run} t={t} at={hover ?? Math.floor(t)} hovering={hover != null} playing={playing} speed={speed} />}
      <div ref={box}>{run && <Chart run={run} width={width} t={t} hover={hover} setHover={setHover} />}</div>
    </footer>
  )
}

function Controls(props: { run: RunData; t: number; at: number; hovering: boolean; playing: boolean; speed: number }) {
  const { run, t, at, hovering, playing, speed } = props
  const s = run.series
  const reserveFull = run.manifest.params.reserve_ratio ?? 0.3
  return (
      <div className="controls">
        <button className="play" onClick={() => useApp.getState().toggle()}>
          {playing ? '暂停' : '播放'}
        </button>
        <span className="clock num">{clockText(run, t)}</span>
        <select aria-label="速度" value={speed} onChange={(e) => useApp.getState().setSpeed(Number(e.target.value))}>
          {SPEEDS.map((v) => (
            <option key={v} value={v}>
              每秒 {v} 小时
            </option>
          ))}
        </select>
        <div className="series">
          <span className="muted">{hovering ? clockText(run, at) : '此刻'}</span>
          {SERIES.map((d) => (
            <span key={d.key}>
              <i className="key" style={{ borderColor: d.color }} />
              {d.name}
              <b className="num">{s[d.key][at]}</b>
            </span>
          ))}
          <span>
            <i className="key" style={{ borderColor: 'var(--ink)' }} />
            钱庄现银
            <b className="num">{Math.round((s.reserve[at]! / reserveFull) * 100)}%</b>
          </span>
        </div>
      </div>
  )
}

function Chart(props: {
  run: RunData
  width: number
  t: number
  hover: number | null
  setHover: (k: number | null) => void
}) {
  const { run, width, t, hover, setHover } = props
  const { n, ticks } = run.manifest
  const s = run.series
  const iw = Math.max(50, width - M.l - M.r)
  const x = (k: number) => M.l + (k / ticks) * iw
  const y1 = (v: number) => M.t + H1 - (v / n) * H1
  const top2 = M.t + H1 + GAP
  const full = run.manifest.params.reserve_ratio ?? 0.3
  const y2 = (v: number) => top2 + H2 - (v / full) * H2
  const height = top2 + H2 + AXIS
  const line = (vals: number[], y: (v: number) => number) => vals.map((v, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join('') // prettier-ignore

  // 夜里（23 点到 6 点）与每天的零点
  const nights: [number, number][] = []
  const days: { k: number; day: number }[] = []
  let from: number | null = null
  for (let k = 0; k <= ticks; k++) {
    const c = clock(run, k)
    if (c.night && from == null) from = k
    if ((!c.night || k === ticks) && from != null) {
      nights.push([from, k])
      from = null
    }
    if (c.hour === 0) days.push({ k, day: c.day })
  }

  const compare = useApp((st) => st.compare)
  const ensemble = useApp((st) => st.ensemble)
  const marks: { k: number; text: string }[] = (run.manifest.params.interventions ?? []).map((iv) => ({
    k: iv.t,
    text: iv.kind === 'broadcast' ? (iv.valence === 1 ? '新谣言' : (iv.strength ?? 0) >= 2.5 ? '担保' : '告示') : describe(run, iv).split('，')[0]!.slice(0, 5),
  })) // prettier-ignore
  if (run.manifest.summary.failed_at != null) marks.push({ k: run.manifest.summary.failed_at, text: '倒闭' })

  // 集成的中间八成：上沿从左到右，下沿从右到左，围成一条带；倒闭后没有值的时刻断开
  const band = (b: { lo: (number | null)[]; hi: (number | null)[] }, y: (v: number) => number): string => {
    let d = ''
    let from = -1
    const close = (to: number) => {
      if (from < 0) return
      for (let k = from; k <= to; k++) d += `${k === from ? 'M' : 'L'}${x(k).toFixed(1)},${y(b.hi[k]!).toFixed(1)}`
      for (let k = to; k >= from; k--) d += `L${x(k).toFixed(1)},${y(b.lo[k]!).toFixed(1)}`
      d += 'Z'
      from = -1
    }
    for (let k = 0; k <= ticks; k++) {
      if (b.lo[k] == null) close(k - 1)
      else if (from < 0) from = k
    }
    close(ticks)
    return d
  }

  const scrub = (e: React.PointerEvent<SVGSVGElement>): number => {
    const r = e.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(ticks, ((e.clientX - r.left - M.l) / iw) * ticks))
  }

  return (
    <svg
      className="chart"
      width={width}
      height={height}
      role="img"
      aria-label="各时刻听说、相信、排队、取款的人数，以及钱庄现银"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        useApp.setState({ playing: false })
        useApp.getState().seek(scrub(e))
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) useApp.getState().seek(scrub(e))
        setHover(Math.round(scrub(e)))
      }}
      onPointerLeave={() => setHover(null)}
    >
      {nights.map(([a, b]) => (
        <rect key={a} x={x(a)} y={M.t} width={x(b) - x(a)} height={height - AXIS - M.t} fill="var(--band)" />
      ))}
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={M.l} x2={M.l + iw} y1={y1(n * f)} y2={y1(n * f)} stroke="var(--line)" strokeWidth={f ? 0.6 : 1} />
          <text x={M.l - 6} y={y1(n * f) + 4} textAnchor="end">
            {Math.round(n * f)}
          </text>
        </g>
      ))}
      <line x1={M.l} x2={M.l + iw} y1={y2(0)} y2={y2(0)} stroke="var(--line)" />
      <text x={M.l - 6} y={y2(full) + 9} textAnchor="end">
        现银
      </text>
      {days.map((d) => (
        <text key={d.k} x={x(d.k) + 4} y={height - 3}>
          {dayName(d.day)}
        </text>
      ))}
      {days.map((d) => (
        <line key={d.k} x1={x(d.k)} x2={x(d.k)} y1={height - AXIS} y2={height - 2} stroke="var(--line)" />
      ))}

      {ensemble && (
        <g opacity={0.16}>
          <path d={band(ensemble.bands.believers, y1)} fill="var(--s-believe)" />
          <path d={band(ensemble.bands.withdrew, y1)} fill="var(--s-withdrew)" />
          <path d={band(ensemble.bands.reserve, y2)} fill="var(--ink)" />
        </g>
      )}
      {compare && (
        <g strokeDasharray="5 4" opacity={0.75} fill="none" strokeWidth={1.5}>
          <path d={line(compare.series.reserve, y2)} stroke="var(--ink)" />
          {SERIES.map((d) => (
            <path key={d.key} d={line(compare.series[d.key], y1)} stroke={d.color} />
          ))}
        </g>
      )}
      <path d={line(s.reserve, y2)} fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinejoin="round" />
      {SERIES.map((d) => (
        <path key={d.key} d={line(s[d.key], y1)} fill="none" stroke={d.color} strokeWidth={2} strokeLinejoin="round" />
      ))}

      {marks.map((m, i) => (
        <g key={i}>
          <line x1={x(m.k)} x2={x(m.k)} y1={M.t - 2} y2={height - AXIS} stroke="var(--ink-2)" strokeDasharray="3 3" />
          <text className="mark-label" x={x(m.k)} y={M.t - 5} textAnchor={i > 0 && x(m.k) - x(marks[i - 1]!.k) < 44 ? 'start' : 'middle'}>
            {m.text}
          </text>
        </g>
      ))}

      {hover != null && (
        <g pointerEvents="none">
          <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={height - AXIS} stroke="var(--ink-3)" />
          {SERIES.map((d) => (
            <circle key={d.key} cx={x(hover)} cy={y1(s[d.key][hover]!)} r={4} fill={d.color} stroke="var(--paper)" strokeWidth={2} />
          ))}
          <circle cx={x(hover)} cy={y2(s.reserve[hover]!)} r={4} fill="var(--ink)" stroke="var(--paper)" strokeWidth={2} />
        </g>
      )}

      <g pointerEvents="none">
        <line x1={x(t)} x2={x(t)} y1={M.t - 2} y2={height - AXIS} stroke="var(--ink)" strokeWidth={1.5} />
        <circle cx={x(t)} cy={M.t - 2} r={4.5} fill="var(--ink)" />
      </g>
    </svg>
  )
}
