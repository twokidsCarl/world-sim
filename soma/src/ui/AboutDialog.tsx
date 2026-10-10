import { useMemo } from 'react'
import { useApp } from '../state/store.ts'
import { Icon } from './Icon.tsx'

export function AboutDialog() {
  const open = useApp((s) => s.aboutOpen)
  const graph = useApp((s) => s.graph)
  const setOpen = useApp((s) => s.setAboutOpen)
  const knowledge = useMemo(() => {
    if (!graph) return []
    const m = new Map<string, { name: string; url: string; license: string }>()
    for (const r of graph.relations) if (!m.has(r.source.name)) m.set(r.source.name, r.source)
    return [...m.values()]
  }, [graph])
  const nameSources = useMemo(() => {
    if (!graph) return []
    const s = new Set<string>()
    for (const n of Object.values(graph.names)) if (n.zhSource) s.add(n.zhSource)
    return [...s].sort()
  }, [graph])
  if (!open) return null
  return (
    <div className="dialog-backdrop" onClick={() => setOpen(false)}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="about-title" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2 id="about-title">数据来源与声明 <span className="en">Attribution &amp; disclaimer</span></h2>
          <button className="icon-btn" aria-label="关闭" onClick={() => setOpen(false)}>
            <Icon name="close" />
          </button>
        </header>
        <div className="dialog-body">
          <p className="disclaimer">
            <strong>仅供教学使用，非临床依据。</strong>
            本工具展示的模型、名称与关系用于解剖学学习，可能存在错误或遗漏，不得用于诊断、治疗或手术决策。
            <span className="en"> For education only — not a basis for clinical decisions.</span>
          </p>
          <h3>几何与本体数据 <span className="en">Geometry &amp; ontology</span></h3>
          {graph && graph.data.sources.length > 0 ? (
            <ul className="sources">
              {graph.data.sources.map((s) => (
                <li key={s.name + s.url}>
                  <a href={s.url} target="_blank" rel="noreferrer noopener">
                    {s.name}
                  </a>
                  <span className="tag">{s.license}</span>
                  <p>{s.attribution}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">数据文件未声明来源。</p>
          )}
          <h3>知识层 <span className="en">Knowledge layer</span></h3>
          {graph?.hasKnowledge ? (
            <>
              <p className="hint">
                中文 / 拉丁文名称 {Object.keys(graph.names).length} 条
                {nameSources.length > 0 && <>（来源：{nameSources.join('、')}）</>}，关系 {graph.relations.length} 条。 标有“待审校”的内容尚未经人工核对。
              </p>
              {knowledge.length > 0 && (
                <ul className="sources">
                  {knowledge.map((s) => (
                    <li key={s.name}>
                      <a href={s.url} target="_blank" rel="noreferrer noopener">
                        {s.name}
                      </a>
                      <span className="tag">{s.license}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="hint">未加载知识层文件，仅显示数据源自带的英文名称。</p>
          )}
        </div>
      </div>
    </div>
  )
}
