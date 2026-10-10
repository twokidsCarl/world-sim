import { useState, type ReactNode } from 'react'
import { isFmaId, type AnatomyGraph, type DisplayName, type TreeKind } from '../anatomy/graph.ts'
import { PROVENANCE_LABEL, RELATION_LABEL, SIDE_LABEL, TISSUE_LABEL, provenanceColor } from '../anatomy/labels.ts'
import type { Concept, Part, Relation } from '../anatomy/types.ts'
import { useApp } from '../state/store.ts'
import { Icon } from './Icon.tsx'

const TREE_LABEL: Record<TreeKind, string> = { isa: '分类路径 is-a', partOf: '组成路径 part-of' }
const LIST_LIMIT = 30

export function InfoPanel({ graph }: { graph: AnatomyGraph }) {
  const selection = useApp((s) => s.selection)
  const dataset = useApp((s) => s.dataset)

  if (selection.concept) {
    const c = graph.concept(selection.concept.tree, selection.concept.id)
    if (c) return <ConceptInfo graph={graph} tree={selection.concept.tree} concept={c} partIds={selection.ids} />
  }
  if (selection.ids.length === 1) {
    const p = graph.part(selection.ids[0]!)
    if (p) return <PartInfo graph={graph} part={p} />
  }
  if (selection.ids.length > 1) {
    return (
      <div className="panel-body scroll info">
        <h2 className="info-title">已选择 {selection.ids.length} 个结构</h2>
        <Actions />
        <Section title="所选结构" en="Selected">
          <PartList graph={graph} ids={selection.ids} />
        </Section>
      </div>
    )
  }
  return (
    <div className="panel-body scroll info">
      <div className="empty-info">
        <p>在模型上点击一个结构，或通过搜索、结构树选择。</p>
        <p className="en">Click a structure, or pick one from search or the tree.</p>
        <dl className="props">
          <dt>数据集</dt>
          <dd>{dataset}</dd>
          <dt>结构数</dt>
          <dd>{graph.parts.length}</dd>
          <dt>概念数</dt>
          <dd>
            is-a {graph.conceptCount('isa')} · part-of {graph.conceptCount('partOf')}
          </dd>
          <dt>知识层</dt>
          <dd>{graph.hasKnowledge ? `名称 ${Object.keys(graph.names).length} · 关系 ${graph.relations.length}` : '未加载'}</dd>
        </dl>
        <ul className="tips">
          <li>拖动旋转 · 右键 / 双指拖动平移 · 滚轮 / 双指捏合缩放</li>
          <li>双击结构聚焦；Ctrl / ⌘ + 点击可多选；Esc 取消选择</li>
          <li>半透明的结构（如皮肤）不拦截点击，可从结构树或搜索中选取</li>
        </ul>
      </div>
    </div>
  )
}

function Names({ name }: { name: DisplayName }) {
  return (
    <div className="names">
      <h2 className="info-title">
        {name.primary}
        {name.status === 'unreviewed' && (
          <span className="badge badge-review" title="该中文 / 拉丁文名称来自自动对齐，尚未经人工审校">
            待审校
          </span>
        )}
      </h2>
      {name.zh && <div className="name-en">{name.en}</div>}
      {name.la && (
        <div className="name-la" lang="la">
          {name.la}
        </div>
      )}
    </div>
  )
}

function Actions() {
  const adjacentMode = useApp((s) => s.adjacentMode)
  const isolated = useApp((s) => s.isolated)
  const app = useApp.getState()
  return (
    <div className="actions">
      <button onClick={() => app.requestFocus()}>
        <Icon name="target" size={14} /> 聚焦
      </button>
      <button className={isolated ? 'on' : ''} onClick={() => (isolated ? app.clearIsolation() : app.isolateSelection())}>
        {isolated ? '取消隔离' : '隔离'}
      </button>
      <button onClick={() => app.hideSelection()}>
        <Icon name="eyeOff" size={14} /> 隐藏
      </button>
      <button className={adjacentMode ? 'on' : ''} aria-pressed={adjacentMode} onClick={() => app.setAdjacentMode(!adjacentMode)}>
        显示相邻结构
      </button>
      <button onClick={() => app.showAll()}>显示全部</button>
    </div>
  )
}

function Section({ title, en, count, children }: { title: string; en?: string; count?: number; children: ReactNode }) {
  return (
    <section className="info-section">
      <h3>
        {title} {en && <span className="en">{en}</span>}
        {count !== undefined && <span className="count">{count}</span>}
      </h3>
      {children}
    </section>
  )
}

function Chain({ graph, tree, chain }: { graph: AnatomyGraph; tree: TreeKind; chain: Concept[] }) {
  const app = useApp.getState()
  if (chain.length === 0) {
    return <p className="hint">{tree === 'partOf' ? '此结构未收录于 part-of 树（该树本就不完整）。' : '未找到分类路径。'}</p>
  }
  return (
    <ol className="chain">
      {chain.map((c) => (
        <li key={c.id}>
          <button onClick={() => app.selectConcept(tree, c.id, { reveal: true })} title={`${c.name} · ${c.id}`}>
            {graph.conceptName(c).primary}
          </button>
        </li>
      ))}
    </ol>
  )
}

function PartList({ graph, ids }: { graph: AnatomyGraph; ids: readonly string[] }) {
  const [all, setAll] = useState(false)
  const app = useApp.getState()
  const shown = all ? ids : ids.slice(0, LIST_LIMIT)
  return (
    <>
      <ul className="part-list">
        {shown.map((id) => {
          const p = graph.part(id)
          if (!p) return null
          const n = graph.partName(p)
          return (
            <li key={id}>
              <button
                onClick={() => app.selectParts([id])}
                onPointerEnter={() => app.setHover(id)}
                onPointerLeave={() => app.setHover(null)}
                title={`${p.name} · ${p.fma}`}
              >
                <span className="swatch" style={{ background: graph.data.systems.find((s) => s.id === p.system)?.color }} />
                {n.primary}
              </button>
            </li>
          )
        })}
      </ul>
      {ids.length > LIST_LIMIT && (
        <button className="link-btn" onClick={() => setAll(!all)}>
          {all ? '收起' : `显示全部 ${ids.length} 个`}
        </button>
      )}
    </>
  )
}

const REL_LIMIT = 6

function IdRows({ id }: { id: string }) {
  return isFmaId(id) ? (
    <>
      <dt>FMA 编号</dt>
      <dd className="mono">{id}</dd>
    </>
  ) : (
    <>
      <dt>概念 ID</dt>
      <dd>
        <span className="mono">{id}</span>{' '}
        <span className="tag" title="该结构在 FMA 中没有对应条目，使用数据管线生成的标识">
          非 FMA
        </span>
      </dd>
    </>
  )
}

function RelationGroup({ graph, kind, list }: { graph: AnatomyGraph; kind: Relation['kind']; list: Relation[] }) {
  const [all, setAll] = useState(false)
  const app = useApp.getState()
  const label = (r: Relation) => r.objectLabel.zh ?? r.objectLabel.en
  // every part any target of this group resolves to, for "select all"
  const union: string[] = []
  const seen = new Set<string>()
  let resolvable = 0
  for (const r of list) {
    const ids = r.object ? graph.resolveFma(r.object) : []
    if (ids.length) resolvable++
    for (const id of ids) if (!seen.has(id)) (seen.add(id), union.push(id))
  }
  const shown = all ? list : list.slice(0, REL_LIMIT)
  return (
    <div className="rel-group">
      <h4>
        {RELATION_LABEL[kind]?.zh ?? kind} <span className="en">{RELATION_LABEL[kind]?.en}</span>
        <span className="count">{list.length}</span>
        {resolvable >= 2 && (
          <button
            className="link-btn"
            title="在模型中选中这一组里所有能对应到的结构"
            onClick={() => {
              app.selectParts(union)
              app.requestFocus()
            }}
          >
            全选 {union.length} 个结构
          </button>
        )}
      </h4>
      <ul>
        {shown.map((r, i) => {
          const targets = r.object ? graph.resolveFma(r.object) : []
          return (
            <li key={i}>
              {targets.length > 0 ? (
                <button
                  className="rel-link"
                  onClick={() => {
                    if (app.selectFma(r.object!)) app.requestFocus()
                  }}
                  title={`${r.objectLabel.en} · ${r.object} — 点击在模型中选中${targets.length > 1 ? `（${targets.length} 个结构）` : ''}`}
                >
                  {label(r)}
                </button>
              ) : (
                <span className="rel-text" title={r.object ? `${r.object}（此模型中无对应结构）` : '未解析到具体结构'}>
                  {label(r)}
                </span>
              )}
              {r.objectLabel.zh && <span className="en"> {r.objectLabel.en}</span>}
              {r.status === 'unreviewed' && <span className="badge badge-review">待审校</span>}
              <a className="src" href={r.source.url} target="_blank" rel="noreferrer noopener" title={`来源：${r.source.name}（${r.source.license}）`}>
                {r.source.name}
              </a>
            </li>
          )
        })}
      </ul>
      {list.length > REL_LIMIT && (
        <button className="link-btn" onClick={() => setAll(!all)}>
          {all ? '收起' : `显示全部 ${list.length} 条`}
        </button>
      )}
    </div>
  )
}

function Relations({ graph, fma }: { graph: AnatomyGraph; fma: string }) {
  const groups = graph.relationsByKind(fma)
  if (groups.length === 0) return null
  return (
    <Section title="知识关系" en="Relations">
      {groups.map(([kind, list]) => (
        <RelationGroup key={`${fma}:${kind}`} graph={graph} kind={kind} list={list} />
      ))}
    </Section>
  )
}

function PartInfo({ graph, part }: { graph: AnatomyGraph; part: Part }) {
  const name = graph.partName(part)
  const sys = graph.data.systems.find((s) => s.id === part.system)
  const layer = graph.data.layers[part.depth]
  const prov = PROVENANCE_LABEL[part.provenance]
  const source = graph.sourceOf(part)
  const adjacent = graph.adjacentParts(part.id)
  const wikidata = graph.names[part.fma]?.wikidata
  // the chain ends at the part's own concept; show only its ancestors there
  const chainOf = (tree: TreeKind) => {
    const chain = graph.partChain(tree, part.id)
    return chain.length && chain[chain.length - 1]!.id === part.fma ? chain.slice(0, -1) : chain
  }
  return (
    <div className="panel-body scroll info">
      <Names name={name} />
      <Actions />
      <dl className="props">
        <IdRows id={part.fma} />
        <dt>部件 ID</dt>
        <dd className="mono">{part.id}</dd>
        <dt>系统</dt>
        <dd>
          <span className="swatch" style={{ background: sys?.color }} />
          {sys ? `${sys.name.zh} ${sys.name.en}` : part.system}
        </dd>
        <dt>组织</dt>
        <dd>
          {TISSUE_LABEL[part.tissue]?.zh ?? part.tissue} <span className="en">{TISSUE_LABEL[part.tissue]?.en}</span>
        </dd>
        <dt>侧别</dt>
        <dd>
          {SIDE_LABEL[part.side]?.zh ?? part.side} <span className="en">{SIDE_LABEL[part.side]?.en}</span>
        </dd>
        <dt>层次</dt>
        <dd>{layer ? `${layer.name.zh} ${layer.name.en}` : `第 ${part.depth} 层`}</dd>
        <dt>几何来源</dt>
        <dd className="prov">
          <span className="swatch" style={{ background: provenanceColor(part.provenance, graph.sourceOrdinal(part)) }} />
          <span className={`badge badge-${part.provenance}`}>
            {prov?.zh ?? part.provenance} {prov?.en}
          </span>
          <span className="prov-src">
            {source.url ? (
              <a href={source.url} target="_blank" rel="noreferrer noopener">
                {source.name}
              </a>
            ) : (
              source.name
            )}
            {source.license && <span className="tag">{source.license}</span>}
          </span>
          {prov && <span className="hint">{prov.hint}</span>}
        </dd>
        <dt>体积</dt>
        <dd>{part.volume !== undefined ? `${formatVolume(part.volume)} cm³` : '—'}</dd>
        <dt>三角形</dt>
        <dd>{part.triangles.toLocaleString()}</dd>
        {wikidata && (
          <>
            <dt>Wikidata</dt>
            <dd>
              <a href={`https://www.wikidata.org/wiki/${wikidata}`} target="_blank" rel="noreferrer noopener">
                {wikidata}
              </a>
            </dd>
          </>
        )}
      </dl>
      {(['isa', 'partOf'] as const).map((tree) => (
        <Section key={tree} title={TREE_LABEL[tree]}>
          <Chain graph={graph} tree={tree} chain={chainOf(tree)} />
        </Section>
      ))}
      <Relations graph={graph} fma={part.fma} />
      <Section title="相邻结构" en="Adjacent" count={adjacent.length}>
        {adjacent.length ? <PartList graph={graph} ids={adjacent.map((p) => p.id)} /> : <p className="hint">没有记录相邻结构。</p>}
      </Section>
    </div>
  )
}

function ConceptInfo({ graph, tree, concept, partIds }: { graph: AnatomyGraph; tree: TreeKind; concept: Concept; partIds: readonly string[] }) {
  const other: TreeKind = tree === 'isa' ? 'partOf' : 'isa'
  const inOther = graph.concept(other, concept.id)
  return (
    <div className="panel-body scroll info">
      <Names name={graph.conceptName(concept)} />
      <Actions />
      <dl className="props">
        <IdRows id={concept.id} />
        <dt>类型</dt>
        <dd>概念（{tree === 'isa' ? '分类 is-a' : '组成 part-of'}）</dd>
        <dt>包含结构</dt>
        <dd>{partIds.length} 个</dd>
      </dl>
      <Section title={TREE_LABEL[tree]}>
        {concept.parent === null ? (
          <p className="hint">顶层概念。</p>
        ) : (
          <Chain graph={graph} tree={tree} chain={graph.ancestors(tree, concept.id).reverse()} />
        )}
      </Section>
      {inOther && (
        <Section title={TREE_LABEL[other]}>
          <Chain graph={graph} tree={other} chain={graph.path(other, concept.id)} />
        </Section>
      )}
      <Relations graph={graph} fma={concept.id} />
      <Section title="包含的结构" en="Parts" count={partIds.length}>
        {partIds.length ? <PartList graph={graph} ids={partIds} /> : <p className="hint">此概念在当前人体模型中没有对应的几何结构。</p>}
      </Section>
    </div>
  )
}

function formatVolume(v: number): string {
  if (v >= 100) return v.toFixed(0)
  if (v >= 1) return v.toFixed(1)
  return v.toFixed(2)
}
