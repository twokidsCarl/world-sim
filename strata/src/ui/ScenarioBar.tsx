import { useEffect, useState } from 'react'
import { SCENARIOS } from '../scenarios'
import { scenarioPlayer, type ScenarioState } from './scenario'

export function ScenarioBar() {
  const [state, setState] = useState<ScenarioState | null>(scenarioPlayer.state)
  useEffect(() => scenarioPlayer.subscribe(setState), [])
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('scenario')
    if (id) scenarioPlayer.start(id)
  }, [])

  if (!state) {
    return (
      <footer className="scenario">
        <span className="caption">引导实验</span>
        <div className="segmented">
          {SCENARIOS.map((s) => (
            <button key={s.id} onClick={() => scenarioPlayer.start(s.id)}>
              {s.title}
            </button>
          ))}
        </div>
      </footer>
    )
  }
  const total = SCENARIOS.find((s) => s.id === state.id)!.steps.length
  return (
    <footer className="scenario">
      <div className="scenario-head">
        <strong>{state.title}</strong>
        <span className="caption">{state.done ? '完成' : `第 ${state.index + 1} / ${total} 步`}</span>
        <button onClick={() => scenarioPlayer.stop()}>结束</button>
      </div>
      {!state.done && (
        <>
          <p>{state.stepText}</p>
          <div className="progress">
            <i style={{ width: `${state.progress * 100}%` }} />
          </div>
        </>
      )}
      {state.results.length > 0 && (
        <ul>
          {state.results.map((r, i) => (
            <li key={i} className={r.pass ? 'agree' : 'differ'}>
              {r.pass ? '符合' : '不符'}　{r.text}　实测 {r.value.toFixed(3)}
            </li>
          ))}
        </ul>
      )}
    </footer>
  )
}
