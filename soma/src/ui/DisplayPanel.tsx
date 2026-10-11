import type { AnatomyGraph } from '../anatomy/graph.ts'
import { PROVENANCE_LABEL, provenanceColor } from '../anatomy/labels.ts'
import type { SectionAxis } from '../state/display.ts'
import { isSolo, useApp } from '../state/store.ts'
import { Icon } from './Icon.tsx'
import { SkinMapPanel } from './SkinMapPanel.tsx'

const AXES: { id: SectionAxis; zh: string; en: string }[] = [
  { id: 'axial', zh: '横断面', en: 'Axial' },
  { id: 'coronal', zh: '冠状面', en: 'Coronal' },
  { id: 'sagittal', zh: '矢状面', en: 'Sagittal' },
]

export function DisplayPanel({ graph }: { graph: AnatomyGraph }) {
  const systems = useApp((s) => s.systems)
  const peel = useApp((s) => s.peel)
  const explode = useApp((s) => s.explode)
  const explodeSelectionOnly = useApp((s) => s.explodeSelectionOnly)
  const section = useApp((s) => s.section)
  const selectionCount = useApp((s) => s.selection.ids.length)
  const colorMode = useApp((s) => s.colorMode)
  const provenanceHidden = useApp((s) => s.provenanceHidden)
  const nerveBoost = useApp((s) => s.nerveBoost)
  const hasNerves = graph.parts.some((p) => p.tissue === 'nerve')
  const app = useApp.getState()
  const layers = graph.data.layers
  const maxPeel = Math.max(0, layers.length - 1)

  return (
    <div className="panel-body scroll">
      <section className="group">
        <h3>
          系统 <span className="en">Systems</span>
          <button className="link-btn" onClick={() => app.showAll()}>
            全部显示
          </button>
        </h3>
        <ul className="systems">
          {graph.data.systems
            .filter((sys) => sys.partCount > 0)
            .map((sys) => {
              const st = systems[sys.id] ?? { visible: true, opacity: 1 }
              const solo = isSolo(systems, sys.id)
              return (
                <li key={sys.id} className={st.visible ? '' : 'off'}>
                  <div className="sys-row">
                    <label className="sys-name">
                      <input type="checkbox" checked={st.visible} onChange={(e) => app.setSystemVisible(sys.id, e.target.checked)} />
                      <span className="swatch" style={{ background: sys.color }} />
                      <span>
                        {sys.name.zh} <span className="en">{sys.name.en}</span>
                      </span>
                    </label>
                    <span className="count">{sys.partCount}</span>
                    <button className={`mini-btn${solo ? ' on' : ''}`} onClick={() => app.soloSystem(sys.id)} title={solo ? '恢复显示全部系统' : '只看此系统'}>
                      {solo ? '取消只看' : '只看'}
                    </button>
                  </div>
                  <div className="sys-opacity">
                    <span className="en">不透明度</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round(st.opacity * 100)}
                      disabled={!st.visible}
                      aria-label={`${sys.name.zh} 不透明度`}
                      onChange={(e) => app.setSystemOpacity(sys.id, Number(e.target.value) / 100)}
                    />
                    <span className="value">{Math.round(st.opacity * 100)}%</span>
                  </div>
                </li>
              )
            })}
        </ul>
        {hasNerves && (
          <label className="check" title="神经很细，在全身视图下几乎看不见。开启后神经至少按固定的屏幕宽度绘制，放大后恢复真实粗细。">
            <input type="checkbox" checked={nerveBoost} onChange={(e) => app.setNerveBoost(e.target.checked)} />
            加粗神经（远看时保持可见）
          </label>
        )}
      </section>

      <section className="group">
        <h3>
          数据来源 <span className="en">Provenance</span>
          <label className="switch">
            <input type="checkbox" checked={colorMode === 'source'} onChange={(e) => app.setColorMode(e.target.checked ? 'source' : 'tissue')} />
            按来源着色
          </label>
        </h3>
        <ul className="prov-list">
          {graph.provenanceGroups().map((g) => {
            const label = PROVENANCE_LABEL[g.provenance]
            const visible = !provenanceHidden.has(g.provenance)
            return (
              <li key={g.provenance} className={visible ? '' : 'off'}>
                <div className="sys-row">
                  <label className="sys-name">
                    <input type="checkbox" checked={visible} onChange={(e) => app.setProvenanceVisible(g.provenance, e.target.checked)} />
                    <span className="swatch" style={{ background: provenanceColor(g.provenance, 0) }} />
                    <span>
                      {label?.zh ?? g.provenance} <span className="en">{label?.en}</span>
                    </span>
                  </label>
                  <span className="count">{g.count}</span>
                </div>
                <p className="hint">{label?.hint}</p>
                <ul className="prov-sources">
                  {g.sources.map((src) => (
                    <li key={src.info.name}>
                      <span className="swatch" style={{ background: provenanceColor(g.provenance, src.ordinal) }} />
                      <span className="src-name">{src.info.name}</span>
                      {src.info.license && (
                        <span className="tag" title={src.info.license}>
                          {src.info.license}
                        </span>
                      )}
                      <span className="count">{src.count}</span>
                    </li>
                  ))}
                </ul>
              </li>
            )
          })}
        </ul>
      </section>

      <SkinMapPanel graph={graph} />

      <section className="group">
        <h3>
          逐层剥离 <span className="en">Peel</span>
        </h3>
        <input type="range" min={0} max={maxPeel} step={1} value={Math.min(peel, maxPeel)} aria-label="剥离层数" onChange={(e) => app.setPeel(Number(e.target.value))} />
        <ol className="layers">
          {layers.map((l, i) => (
            <li key={i} className={i < peel ? 'peeled' : ''}>
              <button onClick={() => app.setPeel(i)} title={`剥离到“${l.name.zh}”`}>
                <span className="dot" />
                {l.name.zh} <span className="en">{l.name.en}</span>
              </button>
            </li>
          ))}
        </ol>
        <p className="hint">由浅入深隐藏图层；被选中的结构始终显示。</p>
      </section>

      <section className="group">
        <h3>
          爆炸视图 <span className="en">Explode</span>
        </h3>
        <div className="slider-row">
          <input type="range" min={0} max={100} step={1} value={Math.round(explode * 100)} aria-label="爆炸程度" onChange={(e) => app.setExplode(Number(e.target.value) / 100)} />
          <span className="value">{Math.round(explode * 100)}%</span>
        </div>
        <label className="check">
          <input type="checkbox" checked={explodeSelectionOnly} onChange={(e) => app.setExplodeSelectionOnly(e.target.checked)} />
          仅展开所选结构（以其中心为原点）
        </label>
        {explodeSelectionOnly && selectionCount < 2 && <p className="hint">需选择包含多个部件的结构（如在结构树中点选一个概念）；否则按全身展开。</p>}
      </section>

      <section className="group">
        <h3>
          剖切 <span className="en">Section</span>
          <label className="switch">
            <input type="checkbox" checked={section.enabled} onChange={(e) => app.setSection({ enabled: e.target.checked })} />
            启用
          </label>
        </h3>
        <div className="segmented" role="radiogroup" aria-label="剖切方向">
          {AXES.map((a) => (
            <button
              key={a.id}
              role="radio"
              aria-checked={section.axis === a.id}
              className={section.axis === a.id ? 'active' : ''}
              onClick={() => app.setSection({ axis: a.id, enabled: true })}
            >
              {a.zh}
              <span className="en">{a.en}</span>
            </button>
          ))}
        </div>
        <div className="slider-row">
          <input
            type="range"
            min={0}
            max={1000}
            step={1}
            value={Math.round(section.position * 1000)}
            aria-label="剖切位置"
            onChange={(e) => app.setSection({ position: Number(e.target.value) / 1000, enabled: true })}
          />
          <button className="mini-btn" onClick={() => app.setSection({ flip: !section.flip, enabled: true })} title="翻转保留的一侧">
            <Icon name="flip" size={14} /> 翻转
          </button>
        </div>
        <p className="hint">切面以该组织的纯色填充显示；半透明结构不填充。</p>
      </section>
    </div>
  )
}
