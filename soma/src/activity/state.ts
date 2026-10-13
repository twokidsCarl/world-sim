// "肌肉活动"显示的界面状态：模式、重力方向、手持负荷，以及数据加载的状态。独立的小 store，不放进主 store。
// UI state of the muscle-activity display: mode, gravity direction, hand load, and the loading status of its data.
// A small store of its own, kept out of the main store.
//
// 地址参数 / URL parameters（见 README 的参数表 / see the table in the README）
//   act   len | load          长度变化（几何）/ 负荷（估计）   length change (geometry) / load (an estimate)
//   load  2 | 2L | 2R         手持负荷的千克数；L / R 只一只手，省略为两手各持   kilograms held; L / R one hand, both when omitted
//   grav  supine | prone      重力方向；省略为站立   gravity direction; standing when omitted
// 这三个参数不在 urlState.ts 的参数表里，按"其他参数原样保留"的规则走：这里自己解析，并通过 urlSync 的
// setPassthroughParam 写回地址栏。
// These three are not in urlState.ts's table and travel as "other parameters pass through": parsed here and
// written back to the address bar through setPassthroughParam of urlSync.

import { create } from 'zustand'
import type { ActivityMode, GravityMode, HandLoad } from './types.ts'

export type ActivityStatus = 'idle' | 'loading' | 'ready' | 'lines' | 'error'

export interface ActivityState {
  mode: ActivityMode
  gravity: GravityMode
  load: HandLoad | null
  /**
   * ready：两层都可用；lines：只有几何层（没有 activity.json，或它是为另一版绑定生成的）。
   * ready: both layers; lines: geometry only (no activity.json, or one built for another rig).
   */
  status: ActivityStatus
  message: string
  /** 每次有新结果时加一（节流过），面板据此重画 / Bumped (throttled) whenever there is a new result; the panel redraws on it. */
  tick: number
  setMode(mode: ActivityMode): void
  setGravity(gravity: GravityMode): void
  setLoad(load: HandLoad | null): void
}

export function parseLoad(text: string | null): HandLoad | null {
  const m = /^(\d+(?:\.\d+)?)([LRB]?)$/i.exec((text ?? '').trim())
  if (!m) return null
  const kg = Math.min(20, Number(m[1]))
  return kg > 0 ? { kg, side: (m[2]!.toUpperCase() || 'B') as HandLoad['side'] } : null
}

export function formatLoad(load: HandLoad | null): string | null {
  return load && load.kg > 0 ? `${Math.round(load.kg * 10) / 10}${load.side === 'B' ? '' : load.side}` : null
}

/** 从查询串读出初始状态 / The initial state from a query string. */
export function parseActivityParams(search: string): Pick<ActivityState, 'mode' | 'gravity' | 'load'> {
  const q = new URLSearchParams(search)
  const act = q.get('act')
  const grav = q.get('grav')
  return {
    mode: act === 'len' || act === 'load' ? act : 'off',
    gravity: grav === 'supine' || grav === 'prone' ? grav : 'stand',
    load: parseLoad(q.get('load')),
  }
}

let writeParam: ((key: string, value: string | null) => void) | null = null
/** 由 urlSync 注册：把一个参数写回地址栏 / Registered by urlSync: writes one parameter back to the address bar. */
export function registerActivityUrlWriter(fn: (key: string, value: string | null) => void): void {
  writeParam = fn
}

export const useActivity = create<ActivityState>((set) => ({
  ...parseActivityParams(typeof location === 'undefined' ? '' : location.search),
  status: 'idle',
  message: '',
  tick: 0,
  setMode: (mode) => {
    set({ mode })
    writeParam?.('act', mode === 'off' ? null : mode)
  },
  setGravity: (gravity) => {
    set({ gravity })
    writeParam?.('grav', gravity === 'stand' ? null : gravity)
  },
  setLoad: (load) => {
    set({ load })
    writeParam?.('load', formatLoad(load))
  },
}))
