import { useEffect, useState } from 'react'
import { engine, type PerfSummary } from './engine'

// 帧率基准：依次跑几种负载，各自预热后取一段时间的帧节奏。必须在前台标签页上跑，
// 后台时浏览器会降帧，所以页面不可见时计时暂停。结果写入 window.__strataBench 和 localStorage。
// Frame-rate benchmark: run several loads in turn, warm each up, then record its frame
// pacing. It has to run in a foreground tab; a hidden tab has its frames throttled, so
// the clock pauses while the page is not visible. Results go to window.__strataBench and
// to localStorage.

interface Load {
  name: string
  substrate: string
  params: Record<string, number>
}

const LOADS: Load[] = [
  { name: '分子动力学 二维，约 10 万粒子', substrate: 'md', params: { dim: 2, nx: 296, density: 0.6, temperature: 1 } },
  { name: '分子动力学 三维，约 13 万粒子', substrate: 'md', params: { dim: 3, nx: 128, density: 0.8, temperature: 1.5 } },
  { name: 'Ising 1024 × 1024', substrate: 'ising', params: { L: 10, T: 2.27 } },
  { name: '引力 16384 个天体', substrate: 'gravity', params: { n: 14, initial: 1 } },
]

const WARMUP_MS = 3000
const MEASURE_MS = 6000
const KEY = 'strata-bench'

export interface BenchRow extends PerfSummary {
  name: string
}

/** 等待若干毫秒的“可见时间” / Wait for this many milliseconds of visible time */
async function visibleDelay(ms: number): Promise<void> {
  let left = ms
  while (left > 0) {
    const t0 = performance.now()
    await new Promise((r) => setTimeout(r, 100))
    if (document.visibilityState === 'visible') left -= performance.now() - t0
  }
}

export function Bench() {
  const [rows, setRows] = useState<BenchRow[]>([])
  const [status, setStatus] = useState('等待后端就绪…')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await engine.init()
      const out: BenchRow[] = []
      for (const load of LOADS) {
        if (cancelled) return
        setStatus(`正在跑：${load.name}（页面须在前台）`)
        engine.setSubstrate(load.substrate)
        for (const [k, v] of Object.entries(load.params)) if (engine.params[k] !== v) engine.setParam(k, v)
        await visibleDelay(WARMUP_MS)
        await visibleDelay(MEASURE_MS)
        out.push({ ...engine.perf(), name: load.name })
        setRows([...out])
      }
      const result = { at: new Date().toISOString(), userAgent: navigator.userAgent, rows: out }
      ;(globalThis as { __strataBench?: typeof result }).__strataBench = result
      try {
        localStorage.setItem(KEY, JSON.stringify(result))
      } catch {
        // 存不了也没关系，结果仍在页面上。 / If storage fails the results are still on the page.
      }
      setStatus('完成。结果已保存。')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <aside className="perf bench">
      <strong>帧率基准</strong>
      <p className="note">{status}</p>
      <table>
        <thead>
          <tr>
            <th>负载</th>
            <th>帧率</th>
            <th>帧间隔 中位 / 95%</th>
            <th>主线程</th>
            <th>每秒步数</th>
            <th>GPU 每批</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td>{r.fps.toFixed(0)}</td>
              <td>
                {r.frameMs.toFixed(1)} / {r.frameMsP95.toFixed(1)} ms
              </td>
              <td>{r.mainMs.toFixed(2)} ms</td>
              <td>{r.stepsPerSecond.toFixed(0)}</td>
              <td>{r.gpuStepMs === null ? '—' : `${r.gpuStepMs.toFixed(2)} ms`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </aside>
  )
}

/** 上一次基准的结果（若有）。 / The results of the last benchmark run, if any. */
export function lastBench(): unknown {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null')
  } catch {
    return null
  }
}
