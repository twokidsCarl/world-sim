// 统计页用的几个小图：横条、热力格、时间条。数字永远用文字墨色写出来，颜色只画图形。
// The few small charts the statistics page uses: bars, a heat grid, a timeline strip.
// Numbers are always written in text ink; colour is for the marks only.
import type { ReactNode } from 'react'
import type { TokenUsage, Tokens } from '../api'
import type { Lang } from '../i18n'

// 项目的颜色按固定顺序分配，跟着项目走，不跟着排名走。第九个以后归到"其它"的灰。
// Project colours are assigned in a fixed order and follow the project, never its rank.
// Anything past the eighth falls back to the grey of "other".
const ORDER = ['strata', 'limn', 'soma', 'mindloop', 'polis', 'idea-loom', 'ideas', 'meta']
export function seriesClass(project: string, extra: string[] = []): string {
  const all = [...ORDER, ...extra.filter((p) => !ORDER.includes(p)).sort()]
  const i = all.indexOf(project)
  return i >= 0 && i < 8 ? `series-${i + 1}` : 'series-other'
}

// 大数的短写法：中文用万、亿，英文用 k、M、B。
// Short forms of large numbers: 万 and 亿 in Chinese, k, M and B in English.
export function compact(n: number, lang: Lang): string {
  // 一百以上取整，否则留一位小数，并去掉多余的 .0。
  // At 100 or more round to a whole number, otherwise keep one decimal and drop a trailing .0.
  const digits = (x: number): string => (x >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10))
  if (lang === 'en') {
    if (n >= 1e12) return `${digits(n / 1e12)}T`
    if (n >= 1e9) return `${digits(n / 1e9)}B`
    if (n >= 1e6) return `${digits(n / 1e6)}M`
    if (n >= 1e3) return `${digits(n / 1e3)}k`
    return n.toLocaleString('en-US')
  }
  if (n >= 1e12) return `${digits(n / 1e12)} 万亿`
  if (n >= 1e8) return `${digits(n / 1e8)} 亿`
  if (n >= 1e4) return `${digits(n / 1e4)} 万`
  return n.toLocaleString('zh-CN')
}

// 一行写完：输入 · 输出 · 缓存（读和写加在一起）；一个都没有时是空串。
// On one line: input · output · cache (read and write together); an empty string when there is none.
export function usageLine(tokens: TokenUsage | null | undefined, lang: Lang): string {
  const n = (x: number | undefined) => x ?? 0
  const input = n(tokens?.input_tokens)
  const output = n(tokens?.output_tokens)
  const cache = n(tokens?.cache_read_input_tokens) + n(tokens?.cache_creation_input_tokens)
  if (input + output + cache === 0) return ''
  return lang === 'en'
    ? `in ${compact(input, lang)} · out ${compact(output, lang)} · cache ${compact(cache, lang)}`
    : `输入 ${compact(input, lang)} · 输出 ${compact(output, lang)} · 缓存 ${compact(cache, lang)}`
}

// 鼠标停上去看的完整数字，缓存分开读和写。 / The full figures shown on hover, with the cache split into read and write.
export function usageTitle(tokens: TokenUsage | null | undefined, lang: Lang): string {
  const n = (x: number | undefined) => (x ?? 0).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN')
  return lang === 'en'
    ? `input ${n(tokens?.input_tokens)} · output ${n(tokens?.output_tokens)} · cache read ${n(tokens?.cache_read_input_tokens)} · cache write ${n(tokens?.cache_creation_input_tokens)} tokens`
    : `输入 ${n(tokens?.input_tokens)} · 输出 ${n(tokens?.output_tokens)} · 缓存读 ${n(tokens?.cache_read_input_tokens)} · 缓存写 ${n(tokens?.cache_creation_input_tokens)} token`
}

// 几份统计里的 token 逐项相加（统计页"模型调用"的合计一行）。 / Add several statistics token counts item by item (the total row of the model calls tab).
export function sumTokens(...parts: Tokens[]): Tokens {
  const total: Tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0, messages: 0 }
  for (const p of parts) for (const k of Object.keys(total) as (keyof Tokens)[]) total[k] += p[k]
  return total
}

export function duration(seconds: number, lang: Lang): string {
  if (lang === 'en') {
    if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} h`
    if (seconds >= 60) return `${Math.round(seconds / 60)} min`
    return `${Math.round(seconds)} s`
  }
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
