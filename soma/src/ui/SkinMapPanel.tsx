// "体表图"控件与图例：关闭 / 皮节 / 皮神经分布区。
// The "Skin maps" control and legend: off / dermatomes / cutaneous nerve territories.

import { useMemo, useState } from 'react'
import type { AnatomyGraph } from '../anatomy/graph.ts'
import { regionVertexCounts, type SkinMapId } from '../anatomy/skinmaps.ts'
import { useApp } from '../state/store.ts'

const MODES: { id: 'off' | SkinMapId; zh: string; en: string }[] = [
  { id: 'off', zh: '关闭', en: 'Off' },
  { id: 'dermatome', zh: '皮节', en: 'Dermatomes' },
  { id: 'cutaneousNerve', zh: '皮神经分布区', en: 'Nerve territories' },
]

/**
 * 网格本身带来的局限（体表图的 method 字段里没有写到的部分）。
 * Limits that come from the skin mesh itself (not covered by the maps' own `method` text).
 */
const MESH_CAVEATS: { zh: string; en: string }[] = [
  { zh: '区域边界沿网格三角形的边，躯干处网格较粗，会有 1–3 厘米的锯齿。', en: 'Boundaries follow mesh triangles; on the trunk the mesh is coarse, so expect 1–3 cm of jaggedness.' },
  { zh: '皮肤网格把上臂与胸壁连在一起，腋窝和上臂内侧的区域几乎看不到。', en: 'The skin mesh fuses the upper arm to the chest wall, so axillary and medial-arm regions are nearly absent.' },
]

const FEMALE_CAVEAT = {
  zh: '女性人体的躯干体表由男性皮肤形变而来，分区较粗略。',
  en: 'The female trunk surface is deformed male skin, so its regions are rough.',
}

export function SkinMapPanel({ graph }: { graph: AnatomyGraph }) {
  const mode = useApp((s) => s.skinMapMode)
  const status = useApp((s) => s.skinMapsStatus)
  const maps = useApp((s) => s.skinMaps)
  const selected = useApp((s) => s.skinRegions)
  const hover = useApp((s) => s.skinHover)
  const [legendOpen, setLegendOpen] = useState(true)
  const [aboutOpen, setAboutOpen] = useState(false)
  const app = useApp.getState()
  const map = mode === 'off' ? undefined : maps?.maps.find((m) => m.id === mode)
  const counts = useMemo(() => (map ? regionVertexCounts(map) : []), [map])
  const caveats = graph.data.body === 'female' ? [...MESH_CAVEATS, FEMALE_CAVEAT] : MESH_CAVEATS

  return (
    <section className="group">
      <h3>
        体表图 <span className="en">Skin maps</span>
      </h3>
      <div className="segmented" role="radiogroup" aria-label="体表图">
        {MODES.map((m) => (
          <button key={m.id} role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'active' : ''} onClick={() => app.setSkinMapMode(m.id)}>
            {m.zh}
            <span className="en">{m.en}</span>
          </button>
        ))}
      </div>
      {mode !== 'off' && status === 'loading' && <p className="hint">正在加载体表图… Loading…</p>}
      {mode !== 'off' && status === 'missing' && <p className="hint">此人体没有体表图数据。 This body has no skin maps.</p>}
      {mode !== 'off' && status === 'error' && <p className="hint">体表图加载失败或与皮肤网格不匹配。 The skin maps failed to load or do not match the skin mesh.</p>}
      {mode !== 'off' && status === 'ready' && !map && <p className="hint">此人体没有这张体表图。 This body lacks this map.</p>}
      {map && (
        <>
          <p className="hint skin-caveat">
            <strong>教学示意图，未经临床审校，不能用于诊断。</strong> Constructed teaching map, not clinically reviewed.
          </p>
          <button className="link-btn" aria-expanded={aboutOpen} onClick={() => setAboutOpen(!aboutOpen)}>
            {aboutOpen ? '收起' : '展开'}制作方法与局限 <span className="en">Method &amp; limits</span>
          </button>
          {aboutOpen && (
            <div className="skin-about">
              <p>{map.method.zh}</p>
              <p className="en">{map.method.en}</p>
              <ul>
                {caveats.map((c) => (
                  <li key={c.en}>
                    {c.zh} <span className="en">{c.en}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="legend-head">
            <button className="link-btn" aria-expanded={legendOpen} onClick={() => setLegendOpen(!legendOpen)}>
              {legendOpen ? '收起' : '展开'}图例（{map.regions.length} 个区域）
            </button>
            {selected.length > 0 && (
              <button className="link-btn" onClick={() => app.selectSkinRegions([])}>
                取消高亮
              </button>
            )}
          </div>
          {legendOpen && (
            <ul className="legend" aria-label={`${map.name.zh} 图例`}>
              {map.regions.map((r, i) => (
                <li key={i} className={`${selected.includes(i) ? 'selected' : ''}${hover === i ? ' hover' : ''}${counts[i] === 0 ? ' empty' : ''}`}>
                  <button
                    onClick={(e) => app.selectSkinRegions([i], { additive: e.ctrlKey || e.metaKey || e.shiftKey })}
                    onPointerEnter={() => app.setSkinHover(i)}
                    onPointerLeave={() => app.setSkinHover(null)}
                    title={counts[i] === 0 ? `${r.name.en} — 在此皮肤网格上没有顶点 / no vertices on this mesh` : r.name.en}
                  >
                    <span className="swatch" style={{ background: r.color }} />
                    <span className="legend-name">
                      {r.name.zh} <span className="en">{r.name.en}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
