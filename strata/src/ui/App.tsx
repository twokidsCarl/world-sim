import { useEffect, type ReactNode } from 'react'
import { SUBSTRATES } from '../substrates'
import { engine } from './engine'
import { IsingStage } from './IsingStage'
import { KnobPanel, PotentialPreview } from './KnobPanel'
import { LevelCards } from './LevelCards'
import { MdStage } from './MdStage'
import { ScenarioBar } from './ScenarioBar'
import { useUi } from './store'

/** Per-substrate views: the stage, and anything shown above the knobs. */
const VIEWS: Record<string, { stage: ReactNode; extras?: ReactNode }> = {
  md: { stage: <MdStage />, extras: <PotentialPreview /> },
  ising: { stage: <IsingStage /> },
}

export function App() {
  const running = useUi((s) => s.running)
  const toggle = useUi((s) => s.toggle)
  const substrateId = useUi((s) => s.substrateId)
  const view = VIEWS[substrateId]!

  useEffect(() => {
    engine.start()
    void engine.init()
    return () => engine.stop()
  }, [])

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
          <button onClick={toggle}>{running ? '暂停' : '继续'}</button>
          <button onClick={() => engine.reset()}>重置</button>
        </div>
      </header>
      <main key={substrateId}>
        <KnobPanel>{view.extras}</KnobPanel>
        {view.stage}
        <LevelCards />
      </main>
      <ScenarioBar />
    </div>
  )
}
