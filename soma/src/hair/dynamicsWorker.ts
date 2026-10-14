// 长发动力学的工作线程：主线程送关节，这里推进 HairSim、送回位移（见 dynamics.ts）。
// The worker for long-hair dynamics: the main thread sends the joints; this advances HairSim and sends back the
// displacement (see dynamics.ts).

import { HairSim, type SimInit, type SkinMode } from './dynamics.ts'

export type SimRequest =
  | { type: 'init'; init: SimInit }
  | { type: 'rest'; rest: Float32Array }
  | { type: 'step'; joints: Float32Array | null; mode: SkinMode; steps: number }

export type SimReply = { type: 'ready'; warmSteps: number } | { type: 'disp'; disp: Float32Array; moving: boolean }

let sim: HairSim | null = null

self.onmessage = (ev: MessageEvent<SimRequest>): void => {
  const m = ev.data
  if (m.type === 'init') {
    sim = new HairSim(m.init)
    const warmSteps = sim.warm()
    ;(self as unknown as Worker).postMessage({ type: 'ready', warmSteps } satisfies SimReply)
  } else if (m.type === 'rest' && sim) sim.setRest(m.rest)
  else if (m.type === 'step' && sim) {
    const moving = sim.step(m.joints, m.mode, m.steps)
    const disp = Float32Array.from(sim.displacement)
    ;(self as unknown as Worker).postMessage({ type: 'disp', disp, moving } satisfies SimReply, [disp.buffer])
  }
}
