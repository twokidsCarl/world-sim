import { useEffect, useRef } from 'react'
import { LEVELS, type QuantityDef } from '../core/quantity'
import { drawPlot, theme, type Series } from '../plot/plot'
import type { Frame } from '../core/substrate'
import { engine } from './engine'

function format(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a === 0) return '0'
  return (a < 1e-3 || a >= 1e4) ? v.toExponential(2) : v.toFixed(4)
}

function Card({ q }: { q: QuantityDef<Frame> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const valueRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const unwatch = engine.watch(q.id)
    const unframe = engine.onFrame(() => {
      const canvas = canvasRef.current
      if (!canvas) return
      const t = theme()
      const series: Series[] = []
      if (q.kind === 'scalar') {
        const trace = engine.scalars.get(q.id)
        if (!trace || trace.step.length === 0) return
        series.push({ x: trace.step, y: trace.value, color: t.data, mark: 'line' })
        series.push({ x: trace.step, y: trace.theory, color: t.muted, mark: 'dash' })
        drawPlot(canvas, series, { xLabel: engine.substrate.stepLabel })
        if (valueRef.current) {
          const last = trace.value.length - 1
          const theory = trace.theory[last]!
          valueRef.current.textContent =
            format(trace.value[last]!) + (Number.isFinite(theory) ? `　理论 ${format(theory)}` : '')
        }
      } else {
        const trace = engine.curves.get(q.id)
        if (!trace) return
        series.push({ x: trace.x, y: trace.y, color: t.data, mark: q.mark ?? 'bars' })
        if (trace.theory) series.push({ x: trace.theory.x, y: trace.theory.y, color: t.ink, mark: 'dash' })
        drawPlot(canvas, series, { xLabel: q.xLabel, yClip: [-6, 6] })
      }
    })
    return () => {
      unwatch()
      unframe()
    }
  }, [q])

  return (
    <div className="card">
      <h3>
        {q.label}
        <span ref={valueRef} className="value" />
      </h3>
      <canvas ref={canvasRef} className="plot" />
      {q.theoryLabel && (
        <p className="note">
          <i className="dash" />
          {q.theoryLabel}
        </p>
      )}
    </div>
  )
}

export function LevelCards() {
  return (
    <aside className="levels">
      {LEVELS.map((level) => {
        const qs = engine.substrate.quantities.filter((q) => q.level === level.id)
        if (qs.length === 0) return null
        return (
          <section key={level.id}>
            <h2>{level.label}</h2>
            {qs.map((q) => (
              <Card key={q.id} q={q} />
            ))}
          </section>
        )
      })}
    </aside>
  )
}
