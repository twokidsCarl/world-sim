// 信息面板中的体表图区域卡片：区域、支配结构（可点选）、制作方法与来源。
// The skin map region card in the info panel: the region, its supplying structure (clickable),
// and the map's method and sources.

import type { AnatomyGraph } from '../anatomy/graph.ts'
import { regionParts } from '../anatomy/skinmaps.ts'
import { useApp } from '../state/store.ts'

export function SkinRegionInfo({ graph }: { graph: AnatomyGraph }) {
  const mode = useApp((s) => s.skinMapMode)
  const maps = useApp((s) => s.skinMaps)
  const regions = useApp((s) => s.skinRegions)
  const seeThrough = useApp((s) => s.skinSeeThrough)
  const app = useApp.getState()
  const map = mode === 'off' ? undefined : maps?.maps.find((m) => m.id === mode)
  if (!map || regions.length === 0) return null
  return (
    <div className="skin-region">
      <div className="skin-region-kind">
        {map.name.zh} <span className="en">{map.name.en}</span>
        {map.status === 'unreviewed' && (
          <span className="badge badge-review" title="此体表图尚未经临床医师审校 / not reviewed by a clinician">
            待审校
          </span>
        )}
      </div>
      {regions.map((i) => {
        const r = map.regions[i]
        if (!r) return null
        const concept = r.concept
        const ids = regionParts(graph, map, i)
        const c = concept ? (graph.concept('isa', concept) ?? graph.concept('partOf', concept)) : undefined
        const supplier = concept ? graph.nameOf(concept, c?.name ?? graph.partsByFma(concept)[0]?.name ?? concept) : null
        return (
          <div className="skin-region-item" key={i}>
            <h2 className="info-title">
              <span className="swatch" style={{ background: r.color }} />
              {r.name.zh}
            </h2>
            <div className="name-en">{r.name.en}</div>
            <dl className="props">
              <dt>{map.id === 'dermatome' ? '脊神经' : '支配神经'}</dt>
              <dd>
                {supplier && ids.length > 0 ? (
                  <button className="rel-link" title={`${supplier.en} · ${concept} — 选中并让皮肤半透明`} onClick={() => app.showRegionNerve(i) && app.requestFocus()}>
                    {supplier.primary}
                  </button>
                ) : supplier ? (
                  <span title={`${concept}（此模型中无对应结构）`}>{supplier.primary}</span>
                ) : (
                  <span className="hint">模型中没有对应的神经结构 No matching structure in this model</span>
                )}
                {supplier?.zh && <span className="en"> {supplier.en}</span>}
                {ids.length > 0 && <span className="count"> {ids.length} 个结构</span>}
              </dd>
            </dl>
            {ids.length > 0 && (
              <div className="actions">
                <button className={seeThrough ? 'on' : ''} onClick={() => (seeThrough ? app.setSkinSeeThrough(false) : app.showRegionNerve(i) && app.requestFocus())}>
                  {seeThrough ? '恢复不透明皮肤' : '显示支配神经'}
                </button>
              </div>
            )}
          </div>
        )
      })}
      <p className="hint">{map.method.zh}</p>
      <p className="hint en">{map.method.en}</p>
      <ul className="skin-sources">
        {map.sources.map((s) => (
          <li key={s.name + s.url}>
            {s.url ? (
              <a href={s.url} target="_blank" rel="noreferrer noopener">
                {s.name}
              </a>
            ) : (
              s.name
            )}
            {s.license && <span className="tag">{s.license}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 反向入口：所选结构是神经时，提供"显示皮肤分布区"。
 * The reverse entry point: for a selected nerve, offer "show skin territory".
 */
export function ShowSkinTerritory({ graph, partIds, isNerve }: { graph: AnatomyGraph; partIds: readonly string[]; isNerve: boolean }) {
  const maps = useApp((s) => s.skinMaps)
  const status = useApp((s) => s.skinMapsStatus)
  const app = useApp.getState()
  // 已加载：只有确实有对应区域时才显示；未加载：仅对神经类结构提供（点击时再加载）
  // loaded: shown only when a region really matches; not loaded: offered for nerves (loads on click)
  let count: number | null = null
  if (maps) {
    const wanted = new Set(partIds)
    count = 0
    for (const m of maps.maps) for (const r of m.regions) if (r.concept && graph.resolveFma(r.concept).some((id) => wanted.has(id))) count++
    if (count === 0) return null
  } else if (!isNerve || status === 'missing' || status === 'error') return null
  return (
    <div className="actions">
      <button
        title="打开对应的体表图并高亮这条神经的皮肤分布区"
        onClick={async () => {
          const n = await app.showSkinForSelection()
          if (n === 0) app.addNotice('所选结构在体表图中没有对应的分布区。 The selection has no region in the skin maps.')
        }}
      >
        显示皮肤分布区{count ? `（${count}）` : ''}
      </button>
    </div>
  )
}
