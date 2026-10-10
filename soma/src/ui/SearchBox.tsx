import { useEffect, useMemo, useRef, useState } from 'react'
import type { AnatomyGraph, SearchResult } from '../anatomy/graph.ts'
import { useApp } from '../state/store.ts'
import { Icon } from './Icon.tsx'

export function SearchBox({ graph }: { graph: AnatomyGraph }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const results = useMemo(() => graph.search(query, 40), [graph, query])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [])
  useEffect(() => {
    listRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (r: SearchResult) => {
    const app = useApp.getState()
    if (r.kind === 'part') app.selectParts([r.id])
    else app.selectConcept(r.tree ?? 'isa', r.id)
    app.requestFocus()
    app.setLeftOpen(false)
    setOpen(false)
  }

  return (
    <div className="search" ref={boxRef}>
      <Icon name="search" />
      <input
        type="search"
        value={query}
        placeholder="搜索结构：中文 / English / Latina / FMA 编号"
        aria-label="搜索解剖结构"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
            setActive((a) => Math.min(results.length - 1, a + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => Math.max(0, a - 1))
          } else if (e.key === 'Enter') {
            const r = results[active]
            if (r) choose(r)
          } else if (e.key === 'Escape') {
            setOpen(false)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      {open && query.trim() !== '' && (
        <ul className="search-results" ref={listRef} role="listbox">
          {results.length === 0 && <li className="empty">没有匹配的结构 No matches</li>}
          {results.map((r, i) => (
            <li
              key={`${r.kind}:${r.id}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onPointerEnter={() => setActive(i)}
              onClick={() => choose(r)}
            >
              <span className="sr-main">
                <span className="sr-name">{r.name.primary}</span>
                {r.name.zh && <span className="sr-en">{r.name.en}</span>}
                {r.name.la && <span className="sr-la">{r.name.la}</span>}
              </span>
              <span className="sr-meta">
                {r.kind === 'concept' && <span className="tag">{r.partCount} 个结构</span>}
                <span className="mono">{r.fma}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
