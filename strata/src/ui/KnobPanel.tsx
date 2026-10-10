import { useEffect, useRef, type ReactNode } from 'react'
import { TAG_LABEL, type Knob, type Tag } from '../core/params'
import { drawPlot, theme } from '../plot/plot'
import { shiftedPotential } from '../substrates/md/potential'
import { potentialSpec } from '../substrates/md/schema'
import { engine } from './engine'
import { useUi } from './store'

const TAG_ORDER: Tag[] = ['class', 'value', 'state', 'numerical', 'toy']

export function PotentialPreview() {
  const ref = useRef<HTMLCanvasElement>(null)
  const params = useUi((s) => s.params)

  useEffect(() => {
    if (!ref.current) return
    const spec = potentialSpec(params)
    const x: number[] = []
    const y: number[] = []
    for (let r = 0.8; r <= 4; r += 0.01) {
      x.push(r)
      y.push(shiftedPotential(spec, r).u)
    }
    drawPlot(ref.current, [{ x, y, color: theme().data, mark: 'line' }], {
      xLabel: '距离 r / σ',
      yRange: [-1.3, 1.5],
      xRange: [0.8, 4],
    })
  }, [params])

  return (
    <div className="card">
      <h3>两体势 u(r)</h3>
      <canvas ref={ref} className="plot" />
    </div>
  )
}

function KnobControl({ knob }: { knob: Knob }) {
  const value = useUi((s) => s.params[knob.id]!)
  const setParam = (id: string, v: number) => engine.setParam(id, v)
  return (
    <div className="knob">
      <label htmlFor={knob.id}>
        <span>{knob.label}</span>
        {!knob.options && <output>{value}</output>}
      </label>
      {knob.options ? (
        <div className="segmented">
          {knob.options.map((o) => (
            <button key={o.value} aria-pressed={o.value === value} onClick={() => setParam(knob.id, o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <input
          id={knob.id}
          type="range"
          min={knob.min}
          max={knob.max}
          step={knob.step}
          value={value}
          onChange={(e) => setParam(knob.id, Number(e.target.value))}
        />
      )}
      {knob.note && <p className="note">{knob.note}</p>}
      {knob.breaks && value !== knob.default && <p className="note broken">{knob.breaks}</p>}
    </div>
  )
}

export function KnobPanel({ children, footer }: { children?: ReactNode; footer?: ReactNode }) {
  const params = useUi((s) => s.params)
  const knobs = engine.substrate.knobs.filter((k) => !k.when || k.when(params))
  return (
    <aside className="knobs">
      {children}
      {TAG_ORDER.map((tag) => {
        const group = knobs.filter((k) => k.tag === tag)
        if (group.length === 0) return null
        return (
          <section key={tag}>
            <h2>{TAG_LABEL[tag]}</h2>
            {group.map((k) => (
              <KnobControl key={k.id} knob={k} />
            ))}
          </section>
        )
      })}
      {footer && <section>{footer}</section>}
    </aside>
  )
}
