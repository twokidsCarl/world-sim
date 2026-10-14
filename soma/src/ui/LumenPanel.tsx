// "显示"页的"腔"一节：模式开关、充盈滑块、只看消化道、内镜漫游的入口；以及选中一个腔时详情里的体积读数。
// The "Lumina" section of the Display tab: the mode switch, the filling slider, the alimentary-canal view and
// the way into the fly-through; and the volume readout shown in the details when a lumen is selected.

import type { AnatomyGraph } from '../anatomy/graph.ts'
import type { Part } from '../anatomy/types.ts'
import { partFilling } from '../lumen/core.ts'
import { canalShown, fillingOf, lumenCandidates, lumenVolume, realLumina, showCanal, useLumen } from '../lumen/state.ts'
import { FLY_RULE, LUMEN_FEMALE_NOTE, LUMEN_STATEMENT } from '../lumen/statements.ts'
import { useApp } from '../state/store.ts'
import './lumen.css'

export function LumenPanel({ graph }: { graph: AnatomyGraph }) {
  const mode = useLumen((s) => s.mode)
  const fill = useLumen((s) => s.fill)
  const fly = useLumen((s) => s.fly)
  const data = useLumen((s) => s.data)
  const status = useLumen((s) => s.status)
  const message = useLumen((s) => s.message)
  const overrides = useLumen((s) => s.overrides)
  const isolated = useApp((s) => s.isolated)
  const lumen = useLumen.getState()
  const derived = data ? data.derived.length : lumenCandidates(graph).length
  const real = data ? data.real.length : realLumina(graph, null).length
  if (derived + real === 0) return null
  const canFly = !!data?.path
  const canal = canalShown(isolated)
  const overridden = Object.keys(overrides).length
  return (
    <section className="group lumen-panel">
      <h3>
        腔 <span className="en">Lumina</span>
      </h3>
      <label className="check">
        <input type="checkbox" checked={mode} onChange={(e) => lumen.setMode(e.target.checked)} />
        <span>
          显示空腔器官的腔 <span className="en">Show the lumina of the hollow organs</span>
        </span>
      </label>
      <p className="hint">
        壁画成半透明，腔用单独的颜色。平时腔藏在不透明的壁里；把系统调成半透明，或在结构树、搜索里选中一个腔，它也会显示。
        <span className="en"> Walls go see-through and lumina take a colour of their own. Otherwise a lumen stays hidden inside its opaque wall; it also shows when its system is made see-through or when it is selected from the tree or the search.</span>
      </p>
      {derived === 0 && (
        <p className="hint lumen-warn">
          {LUMEN_FEMALE_NOTE.zh} <span className="en">{LUMEN_FEMALE_NOTE.en}</span>
        </p>
      )}
      {status === 'error' && (
        <p className="hint lumen-warn">
          腔的数据没有加载成功：{message} <span className="en">The lumen data failed to load.</span>
        </p>
      )}
      {derived > 0 && (
        <>
          <label className="slider-row">
            <span>
              充盈 <span className="en">Filling</span>
            </span>
            <input type="range" min={0} max={1} step={0.01} value={fill} aria-label="充盈：静止到充盈 / filling: resting to distended" onChange={(e) => lumen.setFill(Number(e.target.value))} />
            <span className="value">{fill === 0 ? '静止' : fill.toFixed(2)}</span>
          </label>
          <p className="hint">
            0 是出厂的静止状态（食管和胃塌陷、小肠很细、升结肠和横结肠充气），1 是壁允许的最大；每个腔的充盈度 f = 静止值 + 滑块 ×（1 − 静止值）。选中一个腔可以单独调它。
            <span className="en"> 0 is the resting state as shipped (oesophagus and stomach collapsed, small bowel thin, ascending and transverse colon gas-filled), 1 as full as the wall allows; each lumen's filling is f = rest + slider × (1 − rest). Select a lumen to set it on its own.</span>
            {overridden > 0 && (
              <button className="link-btn" onClick={() => Object.keys(overrides).forEach((id) => lumen.setOverride(id, null))}>
                取消 {overridden} 个单独设定 <span className="en">clear per-organ values</span>
              </button>
            )}
          </p>
          <div className="row-btns">
            <button className={`mini-btn${canal ? ' on' : ''}`} disabled={!data} onClick={() => (canal ? useApp.getState().clearIsolation() : data && showCanal(graph, data))}>
              {canal ? '取消只看消化道' : '只看消化道'} <span className="en">Alimentary canal</span>
            </button>
            <button className={`mini-btn${fly ? ' on' : ''}`} disabled={!canFly && !fly} onClick={() => (fly ? lumen.stopFly() : lumen.startFly(0))} title={`${FLY_RULE.zh} / ${FLY_RULE.en}`}>
              {fly ? '退出漫游' : '内镜漫游'} <span className="en">{fly ? 'Leave fly-through' : 'Fly through'}</span>
            </button>
          </div>
          {!data && status !== 'error' && (
            <p className="hint">
              打开开关后加载腔的数据。 <span className="en">The lumen data loads once the switch is on.</span>
            </p>
          )}
        </>
      )}
      <ul className="lumen-statement">
        {LUMEN_STATEMENT.map((x) => (
          <li key={x.en}>
            {x.zh} <span className="en">{x.en}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** 详情里一个腔的读数：此刻的体积、静止和充满时的体积、它自己的充盈滑块 / A lumen's readout in the details: volume now, at rest and full, and its own filling slider. */
export function LumenPartInfo({ part }: { part: Part }) {
  const data = useLumen((s) => s.data)
  const fill = useLumen((s) => s.fill)
  const overrides = useLumen((s) => s.overrides)
  useLumen((s) => s.geometryTick)
  const entry = data?.entries.get(part.id)
  if (!data || !entry) return null
  const f = fillingOf({ fill, overrides }, entry)
  const v = lumenVolume(data, part.id, f)
  const own = overrides[part.id] !== undefined
  const lumen = useLumen.getState()
  const cm3 = (x: number): string => (x >= 10 ? x.toFixed(0) : x.toFixed(1))
  return (
    <>
      <dt>
        腔的体积 <span className="en">Lumen volume</span>
      </dt>
      <dd className="lumen-info">
        {v ? (
          <>
            <strong>约 {cm3(v.now)} cm³</strong>（充盈度 f = {f.toFixed(2)}） <span className="en">approx., at filling f = {f.toFixed(2)}</span>
            <p className="hint">
              静止（f = {entry.rest}）约 {cm3(v.rest)} cm³，充满（f = 1）约 {cm3(v.full)} cm³{v.fixed ? '；这个腔没有充盈位移，体积不变' : ''}。
              <span className="en">
                {' '}
                At rest (f = {entry.rest}) about {cm3(v.rest)} cm³, full (f = 1) about {cm3(v.full)} cm³{v.fixed ? '; this lumen has no filling displacement, so its volume does not change' : ''}.
              </span>
            </p>
            <p className="hint">
              近似值：由网格的有符号体积算出{v.capped ? '；这一段两端开口（与邻段共用一圈顶点），用端圈的质心扇形虚拟封口' : ''}。它是推导出来的腔的体积，不是测量值。
              <span className="en">
                {' '}
                An approximation: the signed volume of the mesh{v.capped ? '; this stretch is open at its ends (rings shared with its neighbours) and is closed virtually with centroid fans over the end rings' : ''}. It is the volume of a derived lumen, not a measurement.
              </span>
            </p>
          </>
        ) : (
          <span className="hint">几何加载后显示。 Shown once the geometry is loaded.</span>
        )}
        {!v?.fixed && (
          <label className="slider-row">
            <span>
              单独充盈 <span className="en">This lumen</span>
            </span>
            <input type="range" min={0} max={1} step={0.01} value={f} aria-label="这个腔的充盈度 / filling of this lumen" onChange={(e) => lumen.setOverride(part.id, Number(e.target.value))} />
            {own ? (
              <button className="link-btn" onClick={() => lumen.setOverride(part.id, null)}>
                跟随全局
              </button>
            ) : (
              <span className="value">{partFilling(fill, entry.rest).toFixed(2)}</span>
            )}
          </label>
        )}
        <p className="hint">
          器官的壁不随充盈移动。 <span className="en">The organ wall does not move with filling.</span>
        </p>
      </dd>
    </>
  )
}
