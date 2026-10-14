// window.__soma：在浏览器控制台里驱动和检查应用用的句柄。
// window.__soma — a handle for driving and inspecting the app from the browser console.

import type { AnatomyGraph } from './anatomy/graph.ts'
import { lastSaySample, sayClip, sayTime, seekSay } from './face/say.ts'
import { lastSpeechSample, speechTrack } from './face/speech.ts'
import { applyStimulus, seekStimulus, stimClock } from './pain/stim.ts'
import { useApp } from './state/store.ts'
import { useLumen } from './lumen/state.ts'
import type { BenchResult, Viewer, ViewerStats } from './viewer/Viewer.ts'

export interface SomaDebug {
  store: typeof useApp
  /** "腔"显示的状态（模式、充盈、漫游）/ The state of the lumina display (mode, filling, fly-through). */
  lumen: typeof useLumen
  graph: AnatomyGraph | null
  viewer: Viewer | null
  /** 对照视图打开时的第二个渲染器。 */
  /** The second renderer while the compare view is open. */
  compareViewer: Viewer | null
  /** 渲染器初始化之后为 webgpu 或 webgl2。 */
  /** 'webgpu' | 'webgl2' once the renderer is initialised. */
  backend: string | null
  /** 后端、帧率、绘制次数、三角形数、BVH 进度。 */
  /** Backend, fps counters, draw calls, triangle count, BVH progress. */
  stats(): ViewerStats | null
  /** 在环绕相机的同时强制连续渲染若干秒，返回帧时间。 */
  /** Force continuous rendering while orbiting for `seconds`; resolves with frame timings. */
  bench(seconds?: number): Promise<BenchResult | null>
  pick(clientX: number, clientY: number): string | null
  screenOf(partId: string): { x: number; y: number } | null
  /** 刺激时钟（验证用）：读、拨、施加 / The stimulus clock (verification): read, seek, apply. */
  stim: { clock(): number; seek(seconds: number, freeze?: boolean): void; apply: typeof applyStimulus }
  /** 由音频带动口形（验证用）：整条轨迹、最近用过的一帧 / Speaking from audio (verification): the whole track and the frame last used. */
  speech: { track: typeof speechTrack; last: typeof lastSpeechSample }
  /** 由音素带动口形（验证用）：装着的时间线、播放头、最近用过的一帧、把播放头定在某一时刻 / Phoneme-driven speech (verification): the loaded timeline, the playhead, the frame last used, and holding the playhead at a time. */
  say: { clip: typeof sayClip; time: typeof sayTime; last: typeof lastSaySample; seek: typeof seekSay }
}

declare global {
  interface Window {
    __soma: SomaDebug
  }
}

export const debug: SomaDebug = {
  store: useApp,
  lumen: useLumen,
  graph: null,
  viewer: null,
  compareViewer: null,
  backend: null,
  stats: () => debug.viewer?.stats() ?? null,
  bench: (seconds) => debug.viewer?.bench(seconds) ?? Promise.resolve(null),
  pick: (x, y) => debug.viewer?.pick(x, y) ?? null,
  screenOf: (id) => debug.viewer?.screenOf(id) ?? null,
  stim: { clock: stimClock, seek: seekStimulus, apply: applyStimulus },
  speech: { track: speechTrack, last: lastSpeechSample },
  say: { clip: sayClip, time: sayTime, last: lastSaySample, seek: seekSay },
}

window.__soma = debug
