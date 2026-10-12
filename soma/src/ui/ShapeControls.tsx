// "体型"控件：身高、BMI、腿长比例、躯干体格四个滑块，复位，以及这副身体上的限制与模型的局限。
// The body-shape controls: four sliders (stature, BMI, leg length, central build), a reset, and
// the limits on this body and of the model.

import { useState } from 'react'
import type { ShapeControl } from '../shape/types.ts'
import { useApp } from '../state/store.ts'
import { CautionList } from './CautionsDialog.tsx'

function step(c: ShapeControl): number {
  return c.id === 'stature' ? 0.005 : c.id === 'bmi' ? 0.25 : 0.1
}

function format(c: ShapeControl, v: number): string {
  if (c.id === 'stature') return `${(v * 100).toFixed(1)} cm`
  if (c.id === 'bmi') return v.toFixed(1)
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)} SD`
}

/** 一个控制量的滑块。滑块跨越模型的整个范围，取值被限制在这副身体的可用范围内。 */
/** One control's slider. It spans the model's whole range; the value is kept within the range valid on this body. */
export function ShapeSlider({ control, compact = false }: { control: ShapeControl; compact?: boolean }) {
  const value = useApp((s) => s.shapeControls[control.id] ?? control.default)
  const limit = useApp((s) => s.shapeLimit)
  const app = useApp.getState()
  const hit = limit?.id === control.id
  const narrowed = control.valid.min > control.min || control.valid.max < control.max
  const input = (
    <input
      type="range"
      min={control.min}
      max={control.max}
      step={step(control)}
      value={value}
      aria-label={`${control.name.zh} / ${control.name.en}`}
      onChange={(e) => app.setShapeControl(control.id, Number(e.target.value))}
    />
  )
  if (compact) {
    return (
      <label className="embed-slider" title={`${control.name.en}\n${control.valid.why.zh}\n${control.valid.why.en}`}>
        <span>
          {control.name.zh} {format(control, value)}
        </span>
        {input}
      </label>
    )
  }
  return (
    <div className="dof-row">
      <label title={`${control.name.en}\n可用范围 / valid range: ${format(control, control.valid.min)} … ${format(control, control.valid.max)}`}>
        <span className="dof-name">
          {control.name.zh} <span className="en">{control.name.en}</span>
        </span>
        <span className="value">
          {format(control, value)}
        </span>
      </label>
      {input}
      {(hit || narrowed) && (
        <p className={`hint${hit ? ' shape-limit' : ''}`}>
          {hit ? (
            <>
              已到这副身体的极限：{control.valid.why.zh} <span className="en">{control.valid.why.en}</span>
            </>
          ) : (
            <>
              这副身体上可用 {format(control, control.valid.min)} … {format(control, control.valid.max)}。<span className="en"> Valid on this body: {format(control, control.valid.min)} … {format(control, control.valid.max)}.</span>
            </>
          )}
        </p>
      )}
    </div>
  )
}

export function ShapeControls() {
  const shape = useApp((s) => s.shape)
  const status = useApp((s) => s.shapeStatus)
  const message = useApp((s) => s.shapeMessage)
  const changed = useApp((s) => Object.keys(s.shapeControls).length > 0)
  const posed = useApp((s) => !!s.jointScales)
  const rigStatus = useApp((s) => s.rigStatus)
  const [open, setOpen] = useState(false)
  const app = useApp.getState()
  return (
    <section className="group">
      <h3>
        体型 <span className="en">Body shape</span>
        <button className="link-btn" disabled={!changed} onClick={() => app.resetShape()}>
          复位
        </button>
      </h3>
      {!shape && (status === 'idle' || status === 'loading') && <p className="hint">正在加载体型数据… Loading the shape data…</p>}
      {!shape && (status === 'missing' || status === 'error') && (
        <p className="hint">
          <strong>此人体暂时没有体型控制。</strong> No body-shape controls for this body.
          <br />
          {message}
        </p>
      )}
      {shape && (
        <>
          {shape.data.controls.map((c) => (
            <ShapeSlider key={c.id} control={c} />
          ))}
          {posed && rigStatus !== 'ready' && <p className="hint">身高和比例通过关节缩放实现，正在加载骨架绑定… Stature and proportions act through the rig, which is loading…</p>}
          <button className="chip chip-warn chip-button" aria-expanded={open} onClick={() => setOpen(!open)}>
            体型模型的 {shape.data.cautions.length + 2} 条局限
          </button>
          {open && (
            <>
              <CautionList
                items={[
                  { zh: '缩短身高或改变比例时，皮下脂肪最多会穿出皮肤约 12 毫米。', en: 'When the body is shortened or re-proportioned, subcutaneous fat comes through the skin by up to about 12 mm.' },
                  { zh: '“躯干体格”这一项的效果很弱。', en: 'The "central build" control has only a weak effect.' },
                  ...shape.data.cautions,
                ]}
              />
              <ul className="skin-sources">
                {shape.data.rules.map((r) => (
                  <li key={r.en}>
                    {r.zh} <span className="en">{r.en}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}
