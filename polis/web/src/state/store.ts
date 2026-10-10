// 全局状态。React 经 useApp 读；舞台渲染器订阅它并镜像到画布。
import { create } from 'zustand'
import type { Manifest, Message, Population, Series } from '../contract/types.gen.ts'
import { assemble, parseEvents, type RunData } from './derive.ts'

export type Theme = 'light' | 'dark'

export interface AppState {
  runs: Manifest[]
  run: RunData | null
  phase: 'loading' | 'ready' | 'error'
  error: string
  /** 回放位置，单位 tick，可以是小数 */
  t: number
  playing: boolean
  /** 每秒走几个 tick */
  speed: number
  selected: number | null
  hovered: number | null
  theme: Theme

  boot: () => Promise<void>
  open: (runId: string) => Promise<void>
  seek: (t: number) => void
  toggle: () => void
  setSpeed: (speed: number) => void
  select: (i: number | null) => void
  hover: (i: number | null) => void
  setTheme: (theme: Theme) => void
}

async function get(path: string): Promise<Response> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res
}

// 主题要在渲染器读取配色之前就写到文档上
const initialTheme: Theme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
document.documentElement.dataset.theme = initialTheme

export const useApp = create<AppState>((set, getState) => ({
  runs: [],
  run: null,
  phase: 'loading',
  error: '',
  t: 0,
  playing: false,
  speed: 4,
  selected: null,
  hovered: null,
  theme: initialTheme,

  boot: async () => {
    try {
      const runs = (await (await get('/api/runs')).json()) as Manifest[]
      set({ runs })
      if (runs[0]) await getState().open(runs[0].run_id)
      else set({ phase: 'error', error: '还没有运行记录。先在 polis/ 下执行 uv run polis run' })
    } catch (e) {
      set({ phase: 'error', error: `连不上 API（${String(e)}）。先在 polis/ 下执行 uv run polis serve` })
    }
  },

  open: async (runId) => {
    set({ phase: 'loading', playing: false })
    try {
      const base = `/api/runs/${runId}`
      const [manifest, population, messages, series, events, frames] = await Promise.all([
        get(`${base}/manifest.json`).then((r) => r.json() as Promise<Manifest>),
        get(`${base}/population.json`).then((r) => r.json() as Promise<Population>),
        get(`${base}/messages.json`).then((r) => r.json() as Promise<Message[]>),
        get(`${base}/series.json`).then((r) => r.json() as Promise<Series>),
        get(`${base}/events.jsonl`).then((r) => r.text()),
        get(`${base}/frames.bin`).then((r) => r.arrayBuffer()),
      ])
      const run = assemble(manifest, population, messages, series, parseEvents(events), new Uint8Array(frames))
      set({ run, phase: 'ready', t: 0, selected: null, hovered: null })
    } catch (e) {
      set({ phase: 'error', error: `读取记录失败：${String(e)}` })
    }
  },

  seek: (t) => {
    const max = getState().run?.manifest.ticks ?? 0
    set({ t: Math.max(0, Math.min(max, t)) })
  },
  toggle: () => {
    const s = getState()
    if (!s.run) return
    // 播到头再按播放，从头开始
    if (!s.playing && s.t >= s.run.manifest.ticks) set({ t: 0, playing: true })
    else set({ playing: !s.playing })
  },
  setSpeed: (speed) => set({ speed }),
  select: (selected) => set({ selected }),
  hover: (hovered) => set({ hovered }),
  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme
    set({ theme })
  },
}))
