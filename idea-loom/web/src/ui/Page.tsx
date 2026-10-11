import { type ReactNode, useEffect } from 'react'
import { useStore } from '../state/store'

// 每个页面都包在这里面：统一的标题和导语，并把页面身份报给全局状态。
// Every page is wrapped in this: one heading and lead, and it reports the page
// identity to the global store.
export function Page(props: { title: string; lead?: string; idea?: string; actions?: ReactNode; children: ReactNode }) {
  const setPage = useStore((s) => s.setPage)
  const { title, lead = '' } = props
  useEffect(() => {
    setPage({ title, lead, idea: props.idea })
    document.title = `${title} · idea-loom`
  }, [title, lead, props.idea, setPage])
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

export function Empty(props: { children: ReactNode }) {
  return <p className="empty">{props.children}</p>
}
