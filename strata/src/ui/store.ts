import { create } from 'zustand'
import type { Params } from '../core/params'
import { engine } from './engine'

interface UiState {
  substrateId: string
  params: Params
  running: boolean
  /**
   * 实际在运行的是哪个后端；没有可用 GPU 时可能与旋钮不同。
   * Which backend is actually running; may differ from the knob when no GPU is available.
   */
  backendKind: 'cpu' | 'gpu'
  toggle(): void
}

/**
 * 镜像 React 树渲染所依据的引擎状态。
 * Mirrors the engine state that the React tree renders from.
 */
export const useUi = create<UiState>((set) => ({
  substrateId: engine.substrate.id,
  params: engine.params,
  running: engine.running,
  backendKind: engine.backend.kind,
  toggle() {
    engine.running = !engine.running
    set({ running: engine.running })
  },
}))

engine.onChange(() =>
  useUi.setState({ substrateId: engine.substrate.id, params: engine.params, backendKind: engine.backend.kind }),
)
