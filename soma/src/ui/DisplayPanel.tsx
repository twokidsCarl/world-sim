import type { AnatomyGraph } from '../anatomy/graph.ts'
import { CONSTRUCTION_COLOR, CONSTRUCTION_LABEL, PROVENANCE_LABEL, provenanceColor } from '../anatomy/labels.ts'
import { skinDrawnOpaque, type SectionAxis } from '../state/display.ts'
import { isSolo, useApp } from '../state/store.ts'
import { DEFAULT_TONE } from '../look/types.ts'
import { LOOK_HIDES_HINT } from '../look/statements.ts'
import { Icon } from './Icon.tsx'
import { SkinMapPanel } from './SkinMapPanel.tsx'
import { LumenPanel } from './LumenPanel.tsx'
import { IRIS_LABELS, IRIS_NAMES, type IrisName } from '../look/types.ts'
import { HairPanel } from './HairPanel.tsx'
import { OUTFITS } from '../cloth/garments.ts'

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
  const skinOpaque = useApp((s) => s.skinOpaque)
  const look = useApp((s) => s.look)
  const tone = useApp((s) => s.tone)
  const sss = useApp((s) => s.sss)
  const toneData = useApp((s) => s.skinUv?.colour?.data.tone)
  const toneDefault = toneData?.default ?? DEFAULT_TONE
  const iris = useApp((s) => s.iris)
  const gaze = useApp((s) => s.gaze)
  const blink = useApp((s) => s.blink)
  const wear = useApp((s) => s.wear)
  const dataset = useApp((s) => s.dataset)
  const outfits = OUTFITS[dataset] ?? []
  const outfit = outfits.find((o) => o.wear.length === wear.length && o.wear.every((g) => wear.includes(g)))?.id ?? (wear.length ? 'custom' : '')
  const mainSkin = graph.mainSkinId()
  const opaqueNow = useApp((s) => skinDrawnOpaque(s, mainSkin))
  const skinHide = useApp((s) => s.skinHide)
  // 管线报告给了清单就用它，否则按名称 / the pipeline report's list when it gives one, else the name rule
  const listed = Array.isArray(skinHide)
  const hiddenNames = (listed ? skinHide : [...graph.unfittedAppendages()]).map((id) => graph.part(id)).filter((p) => !!p).map((p) => ({ zh: graph.partName(p).primary, en: p.name }))
  const pieces = (mainSkin ? graph.part(mainSkin)?.composition : undefined) ?? []
  const constructed = pieces.filter((x) => x.provenance === 'construction')
  // 皮肤有没有真正的开口：表情数据说了算；它还没加载时看皮肤的组成说明 / whether the skin has real openings: the face data says; before it loads, the skin's composition note
  const faceOpenings = useApp((s) => !!s.face?.data.openings)
  const openings = faceOpenings || pieces.some((x) => /real openings/i.test(x.what.en))
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
        {mainSkin && (
          <>
            <label className="check" title="Draw the skin opaque instead of see-through">
              <input type="checkbox" checked={skinOpaque} onChange={(e) => app.setSkinOpaque(e.target.checked)} />
              皮肤不透明 <span className="en">Opaque skin</span>
            </label>
            {skinOpaque && (
              <label className="check" title="Lifelike skin: physically based material and image-based light; off = the anatomical colours">
                <input type="checkbox" checked={look} onChange={(e) => app.setLook(e.target.checked)} />
                写实外观 <span className="en">Lifelike look</span>
              </label>
            )}
            {skinOpaque && look && (
              <p className="hint">
                {LOOK_HIDES_HINT.zh}
                <span className="en"> {LOOK_HIDES_HINT.en}</span>
              </p>
            )}
            {skinOpaque && look && (
              <div className="slider-row" title="Skin tone: epidermal melanin of a two-layer skin model fitted to the NIST skin reflectance data; double-click to reset">
                <span>
                  肤色 <span className="en">Skin tone</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={tone ?? toneDefault}
                  aria-label="肤色（黑色素）/ skin tone (melanin)"
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    app.setTone(v === toneDefault ? null : v)
                  }}
                  onDoubleClick={() => app.setTone(null)}
                />
                <span className="value">{tone ?? toneDefault}</span>
              </div>
            )}
            {skinOpaque && look && (
              <label className="check" title="Screen-space subsurface scattering of the lifelike skin (WebGPU only; WebGL2 keeps the pre-integrated diffuse)">
                <input type="checkbox" checked={sss} onChange={(e) => app.setSss(e.target.checked)} />
                次表面散射（屏幕空间，WebGPU） <span className="en">Subsurface scattering (screen space, WebGPU)</span>
              </label>
            )}
            {skinOpaque && look && toneData && (tone ?? toneDefault) > toneData.nistMax && (
              <p className="hint">
                比 NIST 数据里最深的肤色还深：这一段是模型外推的。
                <span className="en"> Deeper than the deepest skin in the NIST data: this part is extrapolated by the model.</span>
              </p>
            )}
            {skinOpaque && look && openings && (
              <div className="row" title="The lifelike eyes are constructed for display, not anatomy">
                <label>
                  虹膜 <span className="en">Iris</span>{' '}
                  <select value={iris} onChange={(e) => app.setIris(e.target.value as IrisName)}>
                    {IRIS_NAMES.map((n) => (
                      <option key={n} value={n}>
                        {IRIS_LABELS[n].zh} {IRIS_LABELS[n].en}
                      </option>
                    ))}
                  </select>
                </label>{' '}
                <label>
                  注视 <span className="en">Gaze</span>{' '}
                  <select value={gaze === 'camera' ? 'camera' : gaze.yaw === 0 && gaze.pitch === 0 ? 'ahead' : 'fixed'} onChange={(e) => app.setGaze(e.target.value === 'ahead' ? { yaw: 0, pitch: 0 } : 'camera')}>
                    <option value="camera">看着相机 Follow the camera</option>
                    <option value="ahead">正前方 Straight ahead</option>
                    {gaze !== 'camera' && (gaze.yaw !== 0 || gaze.pitch !== 0) && (
                      <option value="fixed">
                        固定 Fixed {gaze.yaw}°, {gaze.pitch}°
                      </option>
                    )}
                  </select>
                </label>{' '}
                <label className="check" title="Spontaneous blinks and microsaccades (blink=0 turns them off)">
                  <input type="checkbox" checked={blink} onChange={(e) => app.setBlink(e.target.checked)} />
                  眨眼 <span className="en">Blinks</span>
                </label>
              </div>
            )}
            {skinOpaque && look && <HairPanel />}
            {outfits.length > 0 && (
              <label className="check" title="Clothes generated from sewing patterns and draped by cloth simulation at rest; in a pose they only follow the skin roughly for now">
                衣服 <span className="en">Clothes</span>{' '}
                <select value={outfit} onChange={(e) => app.setWear(outfits.find((o) => o.id === e.target.value)?.wear ?? [])}>
                  <option value="">不穿 / none</option>
                  {outfits.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.zh} / {o.en}
                    </option>
                  ))}
                  {outfit === 'custom' && <option value="custom">{wear.join(', ')}</option>}
                </select>
              </label>
            )}
            {opaqueNow && hiddenNames.length > 0 && (
              <p className="hint">
                皮肤不透明时暂时隐藏：{hiddenNames.map((n) => n.zh).join('、')}。
                {listed ? '皮肤自己已经有耳廓和嘴唇，再画深部的那一份只会穿出来。' : '这几个网格还没有贴合这张皮肤，会从皮肤里翘出来。'}
                它们仍在结构树里，选中即可单独显示。
                <span className="en">
                  {' '}
                  Hidden while the skin is opaque: {hiddenNames.map((n) => n.en).join(', ')}. {listed ? 'The skin has its own ears and lips; drawing the deep ones as well would only show through.' : 'These meshes are not yet fitted to this skin and would poke out of it.'} They are still in the tree, and selecting one shows it.
                </span>
              </p>
            )}
            {opaqueNow && openings && (
              <p className="hint">
                这张皮肤的眼和口是真正的开口：透过它们看到的眼球、牙、牙龈和舌是解剖部件（不管所在系统开没开都会画出来）；口腔深处近黑色的壁和睑缘向里卷的一圈是为开口构造的，不是解剖。
                <span className="en"> This skin's eyes and mouth are real openings: the eyeballs, teeth, gingiva and tongue seen through them are anatomical parts (drawn whatever their systems' switches say); the near-black wall deep in the mouth and the rim turned in at the lid margins were constructed for the openings and are not anatomy.</span>
              </p>
            )}
          </>
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
          {constructed.length > 0 && (
            <li className="prov-construction">
              <div className="sys-row">
                <span className="sys-name">
                  <span className="swatch swatch-construction" style={{ background: CONSTRUCTION_COLOR }} />
                  <span>
                    {CONSTRUCTION_LABEL.zh} <span className="en">{CONSTRUCTION_LABEL.en}</span>
                  </span>
                </span>
                <span className="count">{constructed.reduce((a, x) => a + x.vertices, 0).toLocaleString()} 顶点</span>
              </div>
              <p className="hint">
                {CONSTRUCTION_LABEL.hint} 不是一种解剖来源，所以不能按它筛选部件：它只是皮肤这一个部件里的几片（见皮肤的结构信息）。
                <span className="en"> Not an anatomical provenance, so parts cannot be filtered by it: it is a few pieces inside the one skin part (see the skin's details).</span>
              </p>
            </li>
          )}
        </ul>
      </section>

      <SkinMapPanel graph={graph} />
      <LumenPanel graph={graph} />

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
