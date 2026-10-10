import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AnatomyGraph, TreeKind } from '../anatomy/graph.ts'
import type { Concept } from '../anatomy/types.ts'
import { useApp } from '../state/store.ts'
import { Icon } from './Icon.tsx'

const ROW = 30
const OVERSCAN = 8

interface Row {
  concept: Concept
  depth: number
  hasChildren: boolean
}

function flatten(graph: AnatomyGraph, tree: TreeKind, expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = []
  const stack: [Concept, number][] = []
  const roots = graph.roots(tree)
  for (let i = roots.length - 1; i >= 0; i--) stack.push([roots[i]!, 0])
  const seen = new Set<string>()
  while (stack.length) {
    const [c, depth] = stack.pop()!
    if (seen.has(c.id)) continue
    seen.add(c.id)
    const kids = graph.children(tree, c.id)
    rows.push({ concept: c, depth, hasChildren: kids.length > 0 })
    if (kids.length && expanded.has(c.id)) for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, depth + 1])
  }
  return rows
}

export function TreePanel({ graph }: { graph: AnatomyGraph }) {
  const tree = useApp((s) => s.treeTab)
  const expanded = useApp((s) => s.expanded[s.treeTab])
  const hidden = useApp((s) => s.hidden)
  const selection = useApp((s) => s.selection)
  const reveal = useApp((s) => s.reveal)
  const app = useApp.getState()

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(400)
  const rows = useMemo(() => flatten(graph, tree, expanded), [graph, tree, expanded])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = 0
    setScrollTop(0)
  }, [tree])

  useEffect(() => {
    if (!reveal || reveal.tree !== tree) return
    const i = rows.findIndex((r) => r.concept.id === reveal.id)
    const el = scrollRef.current
    if (i < 0 || !el) return
    const top = i * ROW
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - ROW) el.scrollTop = Math.max(0, top - el.clientHeight / 2)
    // rows is intentionally read at reveal time only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal])

  // concepts on the path to a single selected part, to orient the reader
  const onPath = useMemo(() => {
    const ids = new Set<string>()
    if (selection.ids.length === 1) for (const c of graph.partChain(tree, selection.ids[0]!)) ids.add(c.id)
    return ids
  }, [graph, tree, selection])

  const start = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN)
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN)
  const covered = graph.coverage(tree)
  const total = graph.parts.length

  const eyeState = (id: string): 'on' | 'off' | 'partial' => {
    if (hidden.size === 0) return 'on'
    const parts = graph.descendantParts(tree, id)
    let off = 0
    for (const p of parts) if (hidden.has(p)) off++
    return off === 0 ? 'on' : off === parts.length ? 'off' : 'partial'
  }

  return (
    <div className="panel-body tree-panel">
      <div className="segmented tree-tabs" role="tablist">
        <button role="tab" aria-selected={tree === 'isa'} className={tree === 'isa' ? 'active' : ''} onClick={() => app.setTreeTab('isa')}>
          分类 <span className="en">is-a</span>
        </button>
        <button role="tab" aria-selected={tree === 'partOf'} className={tree === 'partOf' ? 'active' : ''} onClick={() => app.setTreeTab('partOf')}>
          组成 <span className="en">part-of</span>
        </button>
      </div>
      <p className="hint tree-note">
        {tree === 'isa'
          ? `按类型归类，覆盖全部 ${total} 个结构（${graph.conceptCount('isa')} 个概念）。`
          : `按部位归属组织。此树在数据源中本就不完整：仅覆盖 ${covered} / ${total} 个结构，未收录的结构请用“分类”树或搜索查找。`}
      </p>
      <div className="tree-scroll" ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} role="tree">
        <div style={{ height: rows.length * ROW, position: 'relative' }}>
          {rows.slice(start, end).map((r, k) => {
            const i = start + k
            const c = r.concept
            const name = graph.conceptName(c)
            const count = graph.partCount(tree, c.id)
            const open = expanded.has(c.id)
            const selected = selection.concept?.tree === tree && selection.concept.id === c.id
            const eye = count > 0 ? eyeState(c.id) : null
            return (
              <div
                key={c.id}
                role="treeitem"
                aria-expanded={r.hasChildren ? open : undefined}
                aria-selected={selected}
                className={`tree-row${selected ? ' selected' : ''}${onPath.has(c.id) ? ' on-path' : ''}${count === 0 ? ' empty' : ''}`}
                style={{ top: i * ROW, height: ROW, paddingLeft: 6 + r.depth * 14 }}
                data-concept={c.id}
              >
                {r.hasChildren ? (
                  <button className={`twisty${open ? ' open' : ''}`} aria-label={open ? '折叠' : '展开'} onClick={() => app.toggleExpanded(tree, c.id)}>
                    <Icon name="chevron" size={12} />
                  </button>
                ) : (
                  <span className="twisty-gap" />
                )}
                <button
                  className="tree-label"
                  title={`${name.en} · ${c.id}`}
                  onClick={() => app.selectConcept(tree, c.id)}
                  onDoubleClick={() => app.requestFocus()}
                >
                  <span className="tl-name">{name.primary}</span>
                  {name.zh && <span className="tl-en">{name.en}</span>}
                </button>
                <span className="count">{count}</span>
                {eye ? (
                  <button
                    className={`eye ${eye}`}
                    aria-label={eye === 'on' ? '隐藏' : '显示'}
                    title={eye === 'on' ? '隐藏此概念下的结构' : '显示此概念下的结构'}
                    onClick={() => {
                      const ids = graph.descendantParts(tree, c.id)
                      if (eye === 'on') app.hideParts(ids)
                      else app.showParts(ids)
                    }}
                  >
                    <Icon name={eye === 'off' ? 'eyeOff' : 'eye'} size={14} />
                  </button>
                ) : (
                  <span className="eye-gap" />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
