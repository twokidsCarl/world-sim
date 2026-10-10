// window.__soma — a handle for driving and inspecting the app from the browser console.

import type { AnatomyGraph } from './anatomy/graph.ts'
import { useApp } from './state/store.ts'
import type { BenchResult, Viewer, ViewerStats } from './viewer/Viewer.ts'

export interface SomaDebug {
  store: typeof useApp
  graph: AnatomyGraph | null
  viewer: Viewer | null
  /** 'webgpu' | 'webgl2' once the renderer is initialised. */
  backend: string | null
  /** Backend, fps counters, draw calls, triangle count, BVH progress. */
  stats(): ViewerStats | null
  /** Force continuous rendering while orbiting for `seconds`; resolves with frame timings. */
  bench(seconds?: number): Promise<BenchResult | null>
  pick(clientX: number, clientY: number): string | null
  screenOf(partId: string): { x: number; y: number } | null
}

declare global {
  interface Window {
    __soma: SomaDebug
  }
}

export const debug: SomaDebug = {
  store: useApp,
  graph: null,
  viewer: null,
  backend: null,
  stats: () => debug.viewer?.stats() ?? null,
  bench: (seconds) => debug.viewer?.bench(seconds) ?? Promise.resolve(null),
  pick: (x, y) => debug.viewer?.pick(x, y) ?? null,
  screenOf: (id) => debug.viewer?.screenOf(id) ?? null,
}

window.__soma = debug
