import { useEffect, useRef } from 'react'
import type { Agreement } from '../core/quantity'
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

const AGREEMENT_TEXT: Record<Agreement, string> = { agree: '吻合', differ: '偏离', none: '' }

/** Worst agreement among a level's quantities: any deviation wins, then agreement, then none. */
function levelAgreement(ids: string[]): Agreement {
  let out: Agreement = 'none'
  for (const id of ids) {
    const a = engine.agreements.get(id) ?? 'none'
    if (a === 'differ') return 'differ'
    if (a === 'agree') out = 'agree'
  }
  return out
}

function setChip(el: HTMLElement | null, a: Agreement): void {
  if (!el || el.dataset.state === a) return
  el.dataset.state = a
  el.textContent = AGREEMENT_TEXT[a]
}

function Card({ q }: { q: QuantityDef<Frame> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const valueRef = useRef<HTMLSpanElement>(null)
  const chipRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const unwatch = engine.watch(q.id)
    const unframe = engine.onFrame(() => {
      const canvas = canvasRef.current
      if (!canvas) return
      setChip(chipRef.current, engine.agreements.get(q.id) ?? 'none')
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
        <span>
          {q.label}
          <span ref={chipRef} className="chip" />
        </span>
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
  const levels = LEVELS.map((level) => ({
    ...level,
    quantities: engine.substrate.quantities.filter((q) => q.level === level.id),
  })).filter((l) => l.quantities.length > 0)
  const ladderRef = useRef<HTMLElement>(null)

  useEffect(
    () =>
      engine.onFrame(() => {
        ladderRef.current?.querySelectorAll<HTMLElement>('[data-level]').forEach((el) => {
          const level = levels.find((l) => l.id === el.dataset.level)!
          setChip(el.querySelector<HTMLElement>('.chip'), levelAgreement(level.quantities.map((q) => q.id)))
        })
      }),
    [levels],
  )

  return (
    <aside className="levels">
      <nav ref={ladderRef} className="ladder">
        {levels.map((level) => (
          <a key={level.id} href={`#level-${level.id}`} data-level={level.id}>
            {level.label}
            <span className="chip" />
          </a>
        ))}
      </nav>
      {levels.map((level) => (
        <section key={level.id} id={`level-${level.id}`}>
          <h2>{level.label}</h2>
          {level.quantities.map((q) => (
            <Card key={q.id} q={q} />
          ))}
        </section>
      ))}
    </aside>
  )
}
