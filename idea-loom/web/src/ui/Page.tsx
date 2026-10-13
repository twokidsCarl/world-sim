import { type ReactNode, useEffect } from 'react'
import { useSearchParams } from 'react-router'
import { useStore, useT } from '../state/store'
import { parseTab } from './tabs'

// 每个页面都包在这里面：统一的标题和导语，并把页面身份报给全局状态。
// Every page is wrapped in this: one heading and lead, and it reports the page
// identity to the global store.
export function Page(props: { title: string; lead?: string; idea?: string; actions?: ReactNode; children: ReactNode }) {
  const setPage = useStore((s) => s.setPage)
  const { title, lead = '' } = props
  // 页签标题里的产品名跟着界面语言：中文是「想法经纬」，英文是 idea-loom。
  // The product name in the tab title follows the UI language: 想法经纬 in Chinese, idea-loom in English.
  const brand = useT()('想法经纬', 'idea-loom')
  useEffect(() => {
    setPage({ title, lead, idea: props.idea })
    document.title = `${title} · ${brand}`
  }, [title, lead, props.idea, setPage, brand])
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{title}</h1>
          {lead && <p className="lead">{lead}</p>}
        </div>
        {props.actions && <div className="page-actions">{props.actions}</div>}
      </header>
      {props.children}
    </div>
  )
}

export function Section(props: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="section" aria-label={props.title}>
      <div className="section-head">
        <h2>{props.title}</h2>
        {props.note && <span className="muted small">{props.note}</span>}
      </div>
      {props.children}
    </section>
  )
}

// 当前 tab 存在地址的 ?tab= 里：刷新和分享都不丢；只改 tab，别的参数保留，也不往历史里加记录。
// The current tab lives in ?tab= of the address, so refresh and sharing keep it; only tab changes, other params stay, and no history entry is added.
export function useTab<T extends string>(allowed: readonly T[]): [T, (tab: T) => void] {
  const [params, setParams] = useSearchParams()
  const tab = parseTab(params.get('tab'), allowed)
  const setTab = (next: T) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        if (next === allowed[0]) p.delete('tab')
        else p.set('tab', next)
        return p
      },
      { replace: true },
    )
  return [tab, setTab]
}

// 一排 tab，样式沿用地图页原来的分段按钮。
// A row of tabs, in the segmented-button style the map page already used.
export function Tabs<T extends string>(props: { label: string; value: T; onChange: (tab: T) => void; items: { id: T; label: string }[] }) {
  return (
    <div className="seg" role="tablist" aria-label={props.label}>
      {props.items.map((it) => (
        <button key={it.id} role="tab" aria-selected={props.value === it.id} onClick={() => props.onChange(it.id)}>
          {it.label}
        </button>
      ))}
    </div>
  )
}

export function Empty(props: { children: ReactNode }) {
  return <p className="empty">{props.children}</p>
}
