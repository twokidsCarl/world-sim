// 统计页用的几个小图：横条、热力格、时间条。数字永远用文字墨色写出来，颜色只画图形。
// The few small charts the statistics page uses: bars, a heat grid, a timeline strip.
// Numbers are always written in text ink; colour is for the marks only.
import type { ReactNode } from 'react'

// 项目的颜色按固定顺序分配，跟着项目走，不跟着排名走。第九个以后归到"其它"的灰。
// Project colours are assigned in a fixed order and follow the project, never its rank.
// Anything past the eighth falls back to the grey of "other".
const ORDER = ['strata', 'limn', 'soma', 'mindloop', 'polis', 'idea-loom', 'ideas', 'meta']
export function seriesClass(project: string, extra: string[] = []): string {
  const all = [...ORDER, ...extra.filter((p) => !ORDER.includes(p)).sort()]
  const i = all.indexOf(project)
  return i >= 0 && i < 8 ? `series-${i + 1}` : 'series-other'
}

export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} 十亿`
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(n >= 1e6 ? 0 : 1)} 万`
  return n.toLocaleString('zh-CN')
}

export function duration(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} 小时`
  if (seconds >= 60) return `${Math.round(seconds / 60)} 分钟`
  return `${Math.round(seconds)} 秒`
}

export function Tile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value num">{value}</div>
      {note && <div className="muted small">{note}</div>}
    </div>
  )
}

export function Bar({ value, max, className = '', title }: { value: number; max: number; className?: string; title?: string }) {
  return (
    <span className="vbar" title={title}>
      <span className={className} style={{ width: `${max > 0 ? Math.max(value > 0 ? 1.5 : 0, (value / max) * 100) : 0}%` }} />
    </span>
  )
}

export function Legend({ items }: { items: { label: string; className: string }[] }) {
  return (
    <div className="legend-row">
      {items.map((i) => (
        <span key={i.label}>
          <span className={`swatch ${i.className}`} aria-hidden="true" /> {i.label}
        </span>
      ))}
    </div>
  )
}

// 一种颜色由浅到深的五档，0 是空。 / Five steps of one hue from light to dark; 0 is empty.
export function heat(value: number, max: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (value <= 0 || max <= 0) return 0
  return Math.min(5, Math.max(1, Math.ceil((value / max) * 5))) as 1 | 2 | 3 | 4 | 5
}
