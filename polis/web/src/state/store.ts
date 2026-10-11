// 全局状态。React 经 useApp 读；舞台渲染器订阅它并镜像到画布。
// Global state. React reads it through useApp; the stage renderer subscribes to it and mirrors it onto the canvas.
import { create } from 'zustand'
import type { Intervention, Manifest, Message, Population, Series } from '../contract/types.gen.ts'
import { assemble, parseEvents, type RunData } from './derive.ts'

export type Theme = 'light' | 'dark'
export type Tab = 'city' | 'lab'

type Band = { lo: (number | null)[]; mid: (number | null)[]; hi: (number | null)[] }
export interface Ensemble {
  k: number
  failed: number
  bands: { believers: Band; withdrew: Band; reserve: Band }
}

export interface AppState {
  runs: Manifest[]
  run: RunData | null
  phase: 'loading' | 'ready' | 'error'
  error: string
  /** 回放位置，单位 tick，可以是小数 / Replay position in ticks; may be fractional */
  t: number
  playing: boolean
  /** 每秒走几个 tick / Ticks advanced per second */
  speed: number
  selected: number | null
  hovered: number | null
  theme: Theme
  tab: Tab
  /**
   * 分叉记录的父记录，画成虚线作对比
   * Parent of a forked run, drawn dashed for comparison
   */
  compare: { manifest: Manifest; series: Series } | null
  ensemble: Ensemble | null
  /**
   * 实验台里已选好、还没重跑的干预
   * Interventions picked in the lab but not yet re-run
   */
  pending: Intervention[]
  busy: '' | 'branch' | 'ensemble'
  labError: string

  boot: () => Promise<void>
  open: (runId: string, keepTime?: boolean) => Promise<void>
  setTab: (tab: Tab) => void
  addPending: (iv: Intervention) => void
  removePending: (index: number) => void
  branch: () => Promise<void>
  runEnsemble: () => Promise<void>
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
// The theme must be written to the document before the renderer reads the palette
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
  tab: 'city',
  compare: null,
  ensemble: null,
  pending: [],
  busy: '',
  labError: '',

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

  open: async (runId, keepTime = false) => {
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
      const json = <T,>(path: string) => get(path).then((r) => r.json() as Promise<T>)
      const parent = manifest.parent
      const compare = parent
        ? await Promise.all([json<Manifest>(`/api/runs/${parent}/manifest.json`), json<Series>(`/api/runs/${parent}/series.json`)])
            .then(([m, s]) => ({ manifest: m, series: s }))
            .catch(() => null)
        : null
      // 集成结果是按需算的，没算过时接口返回 null
      // Ensemble results are computed on demand; the API returns null until they have been
      const ensemble = await json<Ensemble | null>(`${base}/ensemble.json`).catch(() => null)
      const s = getState()
      set({
        run, compare, ensemble, phase: 'ready', pending: [], labError: '',
        t: keepTime ? Math.min(s.t, manifest.ticks) : 0,
        selected: keepTime ? s.selected : null,
        hovered: null,
      }) // prettier-ignore
    } catch (e) {
      set({ phase: 'error', error: `读取记录失败：${String(e)}` })
    }
  },

  setTab: (tab) => set({ tab }),
  addPending: (iv) => set({ pending: [...getState().pending, iv] }),
  removePending: (index) => set({ pending: getState().pending.filter((_, i) => i !== index) }),

  branch: async () => {
    const s = getState()
    if (!s.run || s.pending.length === 0) return
    set({ busy: 'branch', labError: '' })
    try {
      const res = await fetch(`/api/runs/${s.run.manifest.run_id}/branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interventions: s.pending }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? String(res.status))
      const made = (await res.json()) as Manifest
      set({ runs: (await (await get('/api/runs')).json()) as Manifest[] })
      await getState().open(made.run_id, true)
    } catch (e) {
      set({ labError: `分叉失败：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      set({ busy: '' })
    }
  },

  runEnsemble: async () => {
    const s = getState()
    if (!s.run) return
    const id = s.run.manifest.run_id
    set({ busy: 'ensemble', labError: '' })
    try {
      const res = await fetch(`/api/runs/${id}/ensemble?k=20`, { method: 'POST' })
      if (!res.ok) throw new Error(String(res.status))
      const ensemble = (await res.json()) as Ensemble
      if (getState().run?.manifest.run_id === id) set({ ensemble })
    } catch (e) {
      set({ labError: `集成失败：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      set({ busy: '' })
    }
  },

  seek: (t) => {
    const max = getState().run?.manifest.ticks ?? 0
    set({ t: Math.max(0, Math.min(max, t)) })
  },
  toggle: () => {
    const s = getState()
    if (!s.run) return
    // 播到头再按播放，从头开始 / Pressing play at the end restarts from the beginning
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
