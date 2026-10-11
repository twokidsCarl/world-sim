import { useEffect, useRef, useState } from 'react'
import type { Agreement, AnalysisDef, AnalysisResult } from '../core/quantity'
import { LEVELS, type QuantityDef } from '../core/quantity'
import { drawPlot, fitCanvas, theme, type Series } from '../plot/plot'
import { viridis } from '../render/points'
import type { Frame } from '../core/substrate'
import { engine } from './engine'
import { useUi } from './store'

function format(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a === 0) return '0'
  return (a < 1e-3 || a >= 1e4) ? v.toExponential(2) : v.toFixed(4)
}

/**
 * 场的热图，在其自身的最小值与最大值之间缩放。返回该范围。
 * Heat map of a field, scaled between its own minimum and maximum. Returns that range.
 */
function drawField(canvas: HTMLCanvasElement, f: { nx: number; ny: number; data: ArrayLike<number>; aspect: number }): [number, number] {
  canvas.style.height = `${Math.min(220, canvas.clientWidth / f.aspect)}px`
  const { ctx, w, h } = fitCanvas(canvas)
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < f.data.length; i++) {
    lo = Math.min(lo, f.data[i]!)
    hi = Math.max(hi, f.data[i]!)
  }
  const image = new ImageData(f.nx, f.ny)
  for (let i = 0; i < f.data.length; i++) {
    const [r, g, b] = viridis(hi > lo ? (f.data[i]! - lo) / (hi - lo) : 0.5)
    image.data.set([r * 255, g * 255, b * 255, 255], 4 * i)
  }
  const scratch = (drawField.scratch ??= document.createElement('canvas'))
  scratch.width = f.nx
  scratch.height = f.ny
  scratch.getContext('2d')!.putImageData(image, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(scratch, 0, 0, w, h)
  return [lo, hi]
}
drawField.scratch = null as HTMLCanvasElement | null

const AGREEMENT_TEXT: Record<Agreement, string> = { agree: '吻合', differ: '偏离', none: '' }

/**
 * 一个层级各量中最差的吻合状态：有任何偏离则取偏离，其次是吻合，最后是无。
 * Worst agreement among a level's quantities: any deviation wins, then agreement, then none.
 */
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
  const voided = useUi((s) => q.voided?.(s.params) ?? null)
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
        const inRegion = engine.scalars.get(`${q.id}@region`)
        if (inRegion) series.push({ x: inRegion.step, y: inRegion.value, color: t.accent, mark: 'line' })
        drawPlot(canvas, series, { xLabel: engine.substrate.stepLabel })
        if (valueRef.current) {
          const last = trace.value.length - 1
          const theory = trace.theory[last]!
          valueRef.current.textContent =
            format(trace.value[last]!) + (Number.isFinite(theory) ? `　理论 ${format(theory)}` : '')
        }
      } else if (q.kind === 'field') {
        const field = engine.fields.get(q.id)
        if (!field) return
        const [lo, hi] = drawField(canvas, field)
        if (valueRef.current) valueRef.current.textContent = `${format(lo)} 到 ${format(hi)}`
      } else {
        const trace = engine.curves.get(q.id)
        if (!trace) return
        series.push({ x: trace.x, y: trace.y, color: t.data, mark: q.mark ?? 'bars' })
        if (trace.theory) series.push({ x: trace.theory.x, y: trace.theory.y, color: t.ink, mark: 'dash' })
        const inRegion = engine.curves.get(`${q.id}@region`)
        if (inRegion) series.push({ x: inRegion.x, y: inRegion.y, color: t.accent, mark: 'line' })
        drawPlot(canvas, series, { xLabel: q.xLabel, yClip: [-6, 6] })
      }
    })
    return () => {
      unwatch()
      unframe()
    }
  }, [q])

  return (
    <div className={voided ? 'card voided' : 'card'}>
      <h3>
        <span>
          <span className="label">{q.label}</span>
          <span ref={chipRef} className="chip" />
        </span>
        <span ref={valueRef} className="value" />
      </h3>
      <canvas ref={canvasRef} className="plot" />
      {voided ? (
        <p className="note broken">{voided}</p>
      ) : (
        q.theoryLabel && (
          <p className="note">
            <i className="dash" />
            {q.theoryLabel}
          </p>
        )
      )}
    </div>
  )
}

/**
 * 大约每秒一次，对已记录的历史重新运行分析。
 * Re-runs an analysis on the recorded history about once a second.
 */
function AnalysisCard({ a }: { a: AnalysisDef }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [have, setHave] = useState(0)

  useEffect(() => {
    const unwatch = engine.watch(a.source)
    let frame = 0
    const unframe = engine.onFrame(() => {
      if (frame++ % 60 !== 0) return
      setHave(engine.histories.get(a.source)?.t.length ?? 0)
      setResult(engine.runAnalysis(a.id))
    })
    return () => {
      unwatch()
      unframe()
    }
  }, [a])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !result?.curve) return
    const t = theme()
    const series: Series[] = [{ x: result.curve.x, y: result.curve.y, color: t.data, mark: 'line' }]
    if (result.theory) series.push({ x: result.theory.x, y: result.theory.y, color: t.ink, mark: 'dash' })
    drawPlot(canvas, series, { xLabel: result.xLabel })
  }, [result])

  return (
    <div className="card">
      <h3>
        <span>
          <span className="label">{a.label}</span>
          {result?.agree !== undefined && (
            <span className="chip" data-state={result.agree ? 'agree' : 'differ'}>
              {result.agree ? '吻合' : '偏离'}
            </span>
          )}
        </span>
      </h3>
      {result ? (
        <>
          <p className="headline">{result.headline}</p>
          {result.detail && <p className="note">{result.detail}</p>}
          {result.curve && <canvas ref={canvasRef} className="plot" />}
          {result.curve && result.theory && result.theoryLabel && (
            <p className="note">
              <i className="dash" />
              {result.theoryLabel}
            </p>
          )}
        </>
      ) : (
        <p className="note">
          正在积累数据：{have} / {a.minSamples} 个样本
        </p>
      )}
    </div>
  )
}

export function LevelCards() {
  const params = useUi((s) => s.params)
  const levels = LEVELS.map((level) => ({
    ...level,
    quantities: engine.substrate.quantities.filter((q) => q.level === level.id && (!q.when || q.when(params))),
    analyses: (engine.substrate.analyses ?? []).filter((a) => a.level === level.id && (!a.when || a.when(params))),
  })).filter((l) => l.quantities.length + l.analyses.length > 0)
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
          {level.analyses.map((a) => (
            <AnalysisCard key={a.id} a={a} />
          ))}
        </section>
      ))}
    </aside>
  )
}
