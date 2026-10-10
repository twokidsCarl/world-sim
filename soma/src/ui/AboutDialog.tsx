import { useMemo } from 'react'
import { PROVENANCE_LABEL } from '../anatomy/labels.ts'
import { useApp } from '../state/store.ts'
import { CautionList } from './CautionsDialog.tsx'
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
  // which provenance and how many parts each declared source contributes
  const usage = useMemo(() => {
    const m = new Map<string, { count: number; provenance: Set<string> }>()
    if (graph) {
      for (const g of graph.provenanceGroups()) {
        for (const src of g.sources) {
          const e = m.get(src.info.name) ?? { count: 0, provenance: new Set<string>() }
          e.count += src.count
          e.provenance.add(PROVENANCE_LABEL[g.provenance]?.zh ?? g.provenance)
          m.set(src.info.name, e)
        }
      }
    }
    return m
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
          {graph && graph.cautions.length > 0 && (
            <>
              <h3>此人体模型的注意事项 <span className="en">Known limitations</span></h3>
              <CautionList items={graph.cautions} />
            </>
          )}
          <h3>几何与本体数据 <span className="en">Geometry &amp; ontology</span></h3>
          {graph && graph.data.sources.length > 0 ? (
            <ul className="sources">
              {graph.data.sources.map((s) => (
                <li key={s.name + s.url}>
                  <a href={s.url} target="_blank" rel="noreferrer noopener">
                    {s.name}
                  </a>
                  <span className="tag">{s.license}</span>
                  {usage.get(s.name) ? (
                    <span className="src-use">
                      {usage.get(s.name)!.count} 个结构 · {[...usage.get(s.name)!.provenance].join(' / ')}
                    </span>
                  ) : (
                    <span className="src-use">本体 / 参考数据</span>
                  )}
                  <p>{s.attribution}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">数据文件未声明来源。</p>
          )}
          <h3>几何来源的三种类型 <span className="en">Provenance</span></h3>
          <dl className="prov-legend">
            {(['scanned', 'warped', 'curated'] as const).map((k) => (
              <div key={k}>
                <dt>
                  <span className={`badge badge-${k}`}>{PROVENANCE_LABEL[k].zh}</span>
                </dt>
                <dd>{PROVENANCE_LABEL[k].hint}</dd>
              </div>
            ))}
          </dl>
          <p className="hint">在“显示”面板中可按来源着色，或隐藏某一类来源的结构。</p>
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
