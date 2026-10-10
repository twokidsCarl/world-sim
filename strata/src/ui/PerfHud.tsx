import { useEffect, useState } from 'react'
import { engine, type PerfSummary } from './engine'

/** Frame pacing readout, shown with ?perf. The same numbers are in window.__strataPerf. */
export function PerfHud() {
  const [perf, setPerf] = useState<PerfSummary | null>(null)
  useEffect(() => {
    const timer = setInterval(() => {
      const next = engine.perf()
      ;(globalThis as { __strataPerf?: PerfSummary }).__strataPerf = next
      setPerf(next)
    }, 500)
    return () => clearInterval(timer)
  }, [])
  if (!perf) return null
  return (
    <aside className="perf">
      <dl>
        <dt>帧率</dt>
        <dd>{perf.fps.toFixed(0)} fps</dd>
        <dt>帧间隔 中位 / 95%</dt>
        <dd>
          {perf.frameMs.toFixed(1)} / {perf.frameMsP95.toFixed(1)} ms
        </dd>
        <dt>主线程每帧</dt>
        <dd>{perf.mainMs.toFixed(2)} ms</dd>
        <dt>每帧步数</dt>
        <dd>{perf.stepsPerFrame}</dd>
        <dt>每秒步数</dt>
        <dd>{perf.stepsPerSecond.toFixed(0)}</dd>
        <dt>GPU 每批</dt>
        <dd>{perf.gpuStepMs === null ? '—' : `${perf.gpuStepMs.toFixed(2)} ms`}</dd>
      </dl>
      {!perf.visible && <p className="note broken">页面在后台，浏览器已降低帧率，读数无效。</p>}
    </aside>
  )
}
