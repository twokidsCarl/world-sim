// Plays a scenario against the engine: applies each step's parameters, waits for the
// step counter, then checks the expectation against the recent average of the quantity.

import { SCENARIOS, type Scenario } from '../scenarios'
import { engine } from './engine'

export interface StepResult {
  text: string
  value: number
  pass: boolean
}

export interface ScenarioState {
  id: string
  title: string
  /** Index of the step now running; equals the step count when finished. */
  index: number
  stepText: string
  /** Progress through the current step, 0..1. */
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
    engine.setSubstrate(scenario.substrate)
    // Keep the expected quantities computed even if their cards are not mounted.
    const ids = new Set(scenario.steps.flatMap((s) => (s.expect ? [s.expect.quantity] : [])))
    this.unwatch = [...ids].map((q) => engine.watch(q))
    this.state = { id, title: scenario.title, index: -1, stepText: '', progress: 0, results: [], done: false }
    this.enter(0)
  }

  stop(): void {
    for (const off of this.unwatch) off()
    this.unwatch = []
    this.scenario = null
    this.state = null
    this.emit()
  }

  private enter(index: number): void {
    const step = this.scenario!.steps[index]
    if (!step) {
      this.state = { ...this.state!, index, stepText: '', progress: 1, done: true }
      this.emit()
      return
    }
    // Parameters that rebuild the state reset the step counter, so apply them first.
    const knobs = engine.substrate.knobs
    const entries = Object.entries(step.set ?? {}).sort(
      ([a], [b]) =>
        Number(knobs.find((k) => k.id === b)?.rebuild === 'state') - Number(knobs.find((k) => k.id === a)?.rebuild === 'state'),
    )
    for (const [id, value] of entries) if (engine.params[id] !== value) engine.setParam(id, value)
    this.startedAt = engine.backend.stepCount
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
      const { quantity, min, max, agree } = step.expect
      const trace = engine.scalars.get(quantity)
      const recent = trace ? trace.value.slice(-10) : []
      const value = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : NaN
      const pass = agree
        ? engine.agreements.get(quantity) === 'agree'
        : Number.isFinite(value) && (min === undefined || value >= min) && (max === undefined || value <= max)
      this.state = { ...state, results: [...state.results, { text: step.expect.text, value, pass }] }
    }
    this.enter(state.index + 1)
  }
}

export const scenarioPlayer = new ScenarioPlayer()
