// 对引擎播放一个场景：应用每一步的参数，等待步数计数器，
// 然后用该量的近期平均检验预期。
// Plays a scenario against the engine: applies each step's parameters, waits for the
// step counter, then checks the expectation against the recent average of the quantity.

import { SCENARIOS, type Scenario } from '../scenarios'
import { engine } from './engine'

/**
 * 声波扰动的速度振幅，以热速度 √T 的分数表示。
 * Velocity amplitude of the sound kick, as a fraction of the thermal speed √T.
 */
export const SOUND_KICK = 0.15

export interface StepResult {
  text: string
  value: number
  pass: boolean
}

export interface ScenarioState {
  id: string
  title: string
  /**
   * 当前正在运行的步骤的索引；结束时等于步骤总数。
   * Index of the step now running; equals the step count when finished.
   */
  index: number
  stepText: string
  /** 当前步骤的进度，0..1。 / Progress through the current step, 0..1. */
  progress: number
  results: StepResult[]
  done: boolean
}

type Listener = (s: ScenarioState | null) => void

class ScenarioPlayer {
  state: ScenarioState | null = null
  private scenario: Scenario | null = null
  private startedAt = 0
  private unwatch: (() => void)[] = []
  private listeners = new Set<Listener>()

  constructor() {
    engine.onFrame(() => this.tick())
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    ;(globalThis as { __strataScenario?: ScenarioState | null }).__strataScenario = this.state
    for (const fn of this.listeners) fn(this.state)
  }

  start(id: string): void {
    const scenario = SCENARIOS.find((s) => s.id === id)
    if (!scenario) return
    this.stop()
    this.scenario = scenario
    // 同一个底座上接着做另一个实验时，先把旋钮恢复成默认值。
    // When another experiment follows on the same substrate, put the knobs back to their defaults first.
    if (engine.substrate.id === scenario.substrate) engine.resetParams()
    else engine.setSubstrate(scenario.substrate)
    // 即使对应的卡片没有挂载，也保持对预期量的计算。
    // Keep the expected quantities computed even if their cards are not mounted.
    const ids = new Set(scenario.steps.flatMap((s) => (s.expect ? [s.expect.quantity] : [])))
    for (const step of scenario.steps) {
      const analysis = engine.substrate.analyses?.find((a) => a.id === step.expect?.analysis)
      for (const q of analysis?.needs ?? []) ids.add(q)
    }
    this.unwatch = [...ids].map((q) => engine.watch(q))
    this.state = { id, title: scenario.title, index: -1, stepText: '', progress: 0, results: [], done: false }
    this.enter(0)
  }

  stop(): void {
    for (const off of this.unwatch) off()
    this.unwatch = []
    engine.stopAt = null
    this.scenario = null
    this.state = null
    this.emit()
  }

  private enter(index: number): void {
    const step = this.scenario!.steps[index]
    if (!step) {
      engine.stopAt = null
      this.state = { ...this.state!, index, stepText: '', progress: 1, done: true }
      this.emit()
      return
    }
    // 会重建状态的参数将重置步数计数器，所以先应用它们。
    // Parameters that rebuild the state reset the step counter, so apply them first.
    const knobs = engine.substrate.knobs
    const entries = Object.entries(step.set ?? {}).sort(
      ([a], [b]) =>
        Number(knobs.find((k) => k.id === b)?.rebuild === 'state') - Number(knobs.find((k) => k.id === a)?.rebuild === 'state'),
    )
    for (const [id, value] of entries) if (engine.params[id] !== value) engine.setParam(id, value)
    if (step.action === 'reverse') engine.reverse()
    if (step.action === 'push') engine.push(step.velocity ?? 0)
    if (step.action === 'perturb') engine.perturb(SOUND_KICK * Math.sqrt(engine.params.temperature ?? 1))
    this.startedAt = engine.backend.stepCount
    // 恰好运行这么多步：反转必须发生在已知的步数上。
    // Run exactly this many steps: reversing must happen at a known step count.
    engine.stopAt = this.startedAt + step.run
    this.state = { ...this.state!, index, stepText: step.text, progress: 0 }
    this.emit()
  }

  private tick(): void {
    const scenario = this.scenario
    const state = this.state
    if (!scenario || !state || state.done) return
    const step = scenario.steps[state.index]!
    const elapsed = engine.backend.stepCount - this.startedAt
    const progress = Math.min(1, Math.max(0, elapsed / step.run))
    if (progress < 1) {
      if (Math.abs(progress - state.progress) >= 0.01) {
        this.state = { ...state, progress }
        this.emit()
      }
      return
    }
    if (step.expect) {
      const { quantity, min, max, agree, latest, analysis } = step.expect
      const trace = engine.scalars.get(quantity)
      // 等待一次在本阶段最后一步之后取得的测量。
      // Wait for a measurement taken after the last step of this stage.
      if (!agree && (!trace || trace.step[trace.step.length - 1]! < engine.backend.stepCount)) return
      const recent = trace ? trace.value.slice(latest ? -1 : -10) : []
      const value = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : NaN
      const pass = analysis
        ? engine.runAnalysis(analysis)?.agree === true
        : agree
          ? engine.agreements.get(quantity) === 'agree'
          : Number.isFinite(value) && (min === undefined || value >= min) && (max === undefined || value <= max)
      this.state = { ...state, results: [...state.results, { text: step.expect.text, value, pass }] }
    }
    this.enter(state.index + 1)
  }
}

export const scenarioPlayer = new ScenarioPlayer()
