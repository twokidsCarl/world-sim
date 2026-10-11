import { useEffect, useState, type ReactNode } from 'react'
import { SUBSTRATES } from '../substrates'
import { Bench, lastBench } from './Bench'
import { ConstantsPanel } from './ConstantsPanel'
import { engine } from './engine'
import { GravityStage } from './GravityStage'
import { IsingStage, PottsStage } from './IsingStage'
import { KnobPanel, PotentialPreview } from './KnobPanel'
import { LevelCards } from './LevelCards'
import { MdStage } from './MdStage'
import { PerfHud } from './PerfHud'
import { SOUND_KICK } from './scenario'
import { ScenarioBar } from './ScenarioBar'
import { useUi } from './store'
import { applyTheme, storedTheme, type ThemeChoice } from './theme'
import { applyUrl, EMBED } from './url'

/**
 * 各底座的视图：主画面，以及显示在旋钮上方的内容。
 * Per-substrate views: the stage, and anything shown above the knobs.
 */
const VIEWS: Record<string, { stage: ReactNode; extras?: ReactNode; footer?: ReactNode }> = {
  md: { stage: <MdStage />, extras: <PotentialPreview />, footer: <ConstantsPanel /> },
  ising: { stage: <IsingStage /> },
  potts: { stage: <PottsStage /> },
  gravity: { stage: <GravityStage /> },
}

const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
]

const SHOW_PERF = new URLSearchParams(location.search).has('perf')
const RUN_BENCH = new URLSearchParams(location.search).has('bench')
// 上次基准的结果随时可从控制台读到。 / The last benchmark's results can always be read from the console.
;(globalThis as { __strataLastBench?: unknown }).__strataLastBench = lastBench()

export function App() {
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(storedTheme)
  useEffect(() => applyTheme(themeChoice), [themeChoice])
  const running = useUi((s) => s.running)
  const toggle = useUi((s) => s.toggle)
  const substrateId = useUi((s) => s.substrateId)
  const view = VIEWS[substrateId]!

  // 没有 WebGPU（或拿不到设备）时落到 CPU 参考实现，并在画面上说明。
  // Without WebGPU (or without a device) the CPU reference runs instead, and the page says so.
  const [noGpu, setNoGpu] = useState(false)

  useEffect(() => {
    engine.start()
    void engine.init().then(() => {
      setNoGpu(engine.gpu === null)
      applyUrl()
    })
    return () => engine.stop()
  }, [])

  const notice = noGpu && (
    <p className="notice">这个环境里用不了 WebGPU，现在跑的是 CPU 参考实现：粒子数和晶格都小得多，引导实验会很慢。</p>
  )

  // 嵌入模式：只留舞台、暂停与重置，以及正在播放的引导实验。
  // Embed mode: only the stage, pause and reset, and the guided experiment being played.
  if (EMBED) {
    return (
      <div className="app embed">
        {notice}
        <main key={substrateId}>{view.stage}</main>
        <div className="controls">
          <button onClick={toggle}>{running ? '暂停' : '继续'}</button>
          <button onClick={() => engine.reset()}>重置</button>
        </div>
        <ScenarioBar />
      </div>
    )
  }

  return (
    <div className="app">
      <header>
        <div>
          <h1>strata</h1>
          <p>{engine.substrate.blurb}</p>
        </div>
        <div className="controls">
          <div className="segmented">
            {SUBSTRATES.map((s) => (
              <button key={s.id} aria-pressed={s.id === substrateId} onClick={() => engine.setSubstrate(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          {substrateId === 'md' && (
            <>
              <button
                onClick={() => engine.perturb(SOUND_KICK * Math.sqrt(engine.params.temperature!))}
                title="沿 x 方向激发一列最长的驻波，用来量声速"
              >
                敲一下
              </button>
              <button onClick={() => engine.reverse()} title="把时间方向反过来">
                倒放
              </button>
            </>
          )}
          <button onClick={toggle}>{running ? '暂停' : '继续'}</button>
          <button onClick={() => engine.reset()}>重置</button>
          <button
            title="切换配色"
            onClick={() => setThemeChoice(THEMES[(THEMES.findIndex((t) => t.id === themeChoice) + 1) % THEMES.length]!.id)}
          >
            {THEMES.find((t) => t.id === themeChoice)!.label}
          </button>
        </div>
      </header>
      {notice}
      <main key={substrateId}>
        <KnobPanel footer={view.footer}>{view.extras}</KnobPanel>
        {view.stage}
        <LevelCards />
      </main>
      <ScenarioBar />
      {SHOW_PERF && <PerfHud />}
      {RUN_BENCH && <Bench />}
    </div>
  )
}
