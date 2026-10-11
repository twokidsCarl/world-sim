import { useEffect, useState } from 'react'
import { type CardView, api } from '../api'
import { pick } from '../i18n'
import { useLang, useT } from '../state/store'
import { SimFrame } from '../ui/SimFrame'

// 回答里除了文字还能画的三样东西：图表、表格、一个可以直接玩的模拟。模型写的是一小段 JSON，这里负责画。
// 画不出来（JSON 不对、数据不成形）时照原样显示那段文字，不让整条回答坏掉。
// The three things an answer can draw besides text: a chart, a table and a simulation that can be
// played right there. The model writes a little JSON and this draws it. When it cannot be drawn
// (bad JSON, malformed data) the text is shown as it is, so the answer as a whole never breaks.

type Series = { name?: string; values?: unknown[]; points?: unknown[] }
type ChartSpec = { type?: string; title?: string; x?: unknown[]; series?: Series[]; unit?: string }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const short = (n: number) => (Math.abs(n) >= 10000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : Number(n.toPrecision(4)).toString())

function Raw({ text }: { text: string }) {
  return <pre className="rich-raw">{text}</pre>
}

export function Chart({ text }: { text: string }) {
  let spec: ChartSpec
  try {
    spec = JSON.parse(text) as ChartSpec
  } catch {
    return <Raw text={text} />
  }
  const series = (Array.isArray(spec.series) ? spec.series : []).slice(0, 4)
  const labels = (Array.isArray(spec.x) ? spec.x : []).slice(0, 24).map(String)
  if (series.length === 0) return <Raw text={text} />
  const unit = typeof spec.unit === 'string' ? spec.unit : ''
  const legend = series.length > 1 && (
    <div className="rich-legend">
      {series.map((s, i) => (
        <span key={i} className={`series-${i + 1}`}>
          <i /> {s.name ?? `#${i + 1}`}
        </span>
      ))}
    </div>
  )
  const head = spec.title && <figcaption>{spec.title}{unit && <span className="muted small"> · {unit}</span>}</figcaption>

  if (spec.type === 'scatter') {
    const points = series.flatMap((s, si) => (Array.isArray(s.points) ? s.points : []).slice(0, 400).map((p) => ({ si, p: p as unknown[] })))
      .map(({ si, p }) => ({ si, x: num(p?.[0]), y: num(p?.[1]), label: typeof p?.[2] === 'string' ? p[2] : '' }))
      .filter((p): p is { si: number; x: number; y: number; label: string } => p.x !== null && p.y !== null)
    if (points.length === 0) return <Raw text={text} />
    return <figure className="rich-chart">{head}<Plot points={points} lines={false} labels={[]} unit={unit} />{legend}</figure>
  }

  const rows = series.map((s) => (Array.isArray(s.values) ? s.values : []).slice(0, labels.length || 24).map(num))
  if (rows.every((r) => r.every((v) => v === null))) return <Raw text={text} />

  if (spec.type === 'line') {
    const points = rows.flatMap((r, si) => r.map((y, i) => ({ si, x: i, y, label: labels[i] ?? '' }))).filter((p): p is { si: number; x: number; y: number; label: string } => p.y !== null)
    return <figure className="rich-chart">{head}<Plot points={points} lines labels={labels} unit={unit} />{legend}</figure>
  }

  // 条形：横着画，类别的名字读得全。 / Bars: drawn sideways so category names can be read in full.
  const max = Math.max(...rows.flat().map((v) => Math.abs(v ?? 0)), 1e-12)
  const count = Math.max(labels.length, ...rows.map((r) => r.length))
  return (
    <figure className="rich-chart">
      {head}
      <div className="rich-bars">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="rich-bar-row">
            <span className="rich-bar-label" title={labels[i]}>{labels[i] ?? i + 1}</span>
            <span className="rich-bar-track">
              {rows.map((r, si) => {
                const v = r[i]
                return v == null ? null : (
                  <span key={si} className={`rich-bar series-${si + 1}`} style={{ width: `${(Math.abs(v) / max) * 100}%` }} title={`${series[si]!.name ?? ''} ${short(v)}${unit}`}>
                    {series.length === 1 && <em className="num">{short(v)}</em>}
                  </span>
                )
              })}
            </span>
          </div>
        ))}
      </div>
      {legend}
    </figure>
  )
}

function Plot({ points, lines, labels, unit }: { points: { si: number; x: number; y: number; label: string }[]; lines: boolean; labels: string[]; unit: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 320, H = 180, L = 40, R = 10, T = 10, B = 24
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y)
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  const y0 = Math.min(0, ...ys), y1 = Math.max(...ys)
  const px = (x: number) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R)
  const py = (y: number) => H - B - ((y - y0) / (y1 - y0 || 1)) * (H - T - B)
  const groups = [...new Set(points.map((p) => p.si))]
  const tick = (i: number) => (labels.length ? labels[i] ?? '' : short(x0 + ((x1 - x0) * i) / 2))
  const ticks = labels.length ? [0, Math.floor((labels.length - 1) / 2), labels.length - 1].filter((v, i, a) => a.indexOf(v) === i) : [0, 1, 2]
  const at = hover === null ? null : points[hover]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="rich-plot" role="img" onMouseLeave={() => setHover(null)}>
      {[0, 0.5, 1].map((f) => {
        const y = y0 + (y1 - y0) * f
        return (
          <g key={f}>
            <line x1={L} x2={W - R} y1={py(y)} y2={py(y)} className="rich-grid" />
            <text x={L - 5} y={py(y) + 3} textAnchor="end" className="rich-tick">{short(y)}</text>
          </g>
        )
      })}
      {ticks.map((i, n) => (
        <text key={i} x={labels.length ? px(i) : L + ((W - L - R) * n) / 2} y={H - 7} textAnchor={n === 0 ? 'start' : n === ticks.length - 1 ? 'end' : 'middle'} className="rich-tick">{tick(i)}</text>
      ))}
      {lines && groups.map((si) => (
        <polyline key={si} className={`rich-line series-${si + 1}`} points={points.filter((p) => p.si === si).map((p) => `${px(p.x)},${py(p.y)}`).join(' ')} />
      ))}
      {points.map((p, i) => (
        <circle key={i} cx={px(p.x)} cy={py(p.y)} r={hover === i ? 5 : lines ? 2.5 : 4} className={`rich-dot series-${p.si + 1}`} onMouseEnter={() => setHover(i)} />
      ))}
      {at && (
        <text x={Math.min(Math.max(px(at.x), L + 4), W - R - 4)} y={Math.max(py(at.y) - 9, 10)} textAnchor={px(at.x) > W / 2 ? 'end' : 'start'} className="rich-tip">
          {at.label && `${at.label}: `}{short(at.y)}{unit}
        </text>
      )}
    </svg>
  )
}

export function DataTable({ text }: { text: string }) {
  let spec: { columns?: unknown[]; rows?: unknown[][] }
  try {
    spec = JSON.parse(text)
  } catch {
    return <Raw text={text} />
  }
  const columns = Array.isArray(spec.columns) ? spec.columns.slice(0, 8).map(String) : []
  const rows = Array.isArray(spec.rows) ? spec.rows.slice(0, 60).filter(Array.isArray) : []
  if (columns.length === 0 || rows.length === 0) return <Raw text={text} />
  return (
    <div className="rich-table">
      <table>
        <thead><tr>{columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{columns.map((_, j) => <td key={j} className={typeof r[j] === 'number' ? 'num r' : ''}>{r[j] == null ? '' : String(r[j])}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

let cardsOnce: Promise<CardView[]> | null = null

export function LiveCard({ text }: { text: string }) {
  const lang = useLang()
  const t = useT()
  const [card, setCard] = useState<CardView | null | undefined>(undefined)
  let spec: { card?: string; note?: string } = {}
  try {
    spec = JSON.parse(text)
  } catch {
    /* 下面按找不到处理 / handled below as not found */
  }
  useEffect(() => {
    cardsOnce ??= api.play().then((v) => v.cards, () => [])
    void cardsOnce.then((all) => setCard(all.find((c) => c.key === spec.card) ?? null))
  }, [spec.card])
  if (card === undefined) return <p className="muted small">{t('正在找这张卡…', 'Looking for the card…')}</p>
  if (card === null) return <p className="muted small">{t(`没有 ${spec.card ?? ''} 这张卡。`, `There is no card ${spec.card ?? ''}.`)}</p>
  return (
    <figure className="rich-card">
      <figcaption>
        <strong>{pick(lang, card.title.zh, card.title.en)}</strong> {spec.note && <span className="muted small">{spec.note}</span>}{' '}
        <a href={`/play?card=${encodeURIComponent(card.key)}`} className="small">{t('放大看', 'Open larger')}</a>
      </figcaption>
      <SimFrame card={card} className="rich-card-frame" />
    </figure>
  )
}
