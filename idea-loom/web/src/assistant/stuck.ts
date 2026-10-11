// 卡住了的三条规则。纯函数，不调用模型；这些数是定下的，不做成设置。
// Three rules for "stuck". Pure functions, no model call; the numbers are fixed, not settings.
export type Action = { at: string; kind: 'navigate' | 'filter' | 'click' | 'error' | 'ask' | 'dwell' | 'op'; url: string; text: string; seconds?: number; idea?: string }

export type Stuck = 'bounce' | 'errors' | 'spin' | null

const MIN = 60_000
const ms = (a: Action) => new Date(a.at).getTime()
const path = (url: string) => url.split('?')[0] ?? url

export function stuck(actions: Action[], now: number): Stuck {
  const recent = (span: number, kind: Action['kind']) => actions.filter((a) => a.kind === kind && now - ms(a) <= span)

  // 两页之间来回跳：两分钟内 A→B→A→B→A / bouncing between two pages: A→B→A→B→A within two minutes
  const navs = recent(2 * MIN, 'navigate').map((a) => path(a.url))
  const last = navs.slice(-5)
  if (last.length === 5 && last[0] === last[2] && last[2] === last[4] && last[1] === last[3] && last[0] !== last[1]) return 'bounce'

  // 一分钟内三次接口报错 / three API errors within a minute
  if (recent(MIN, 'error').length >= 3) return 'errors'

  // 三分钟内在同一页点了十二次还没离开 / twelve clicks on one page within three minutes without leaving
  const lastNav = [...actions].reverse().find((a) => a.kind === 'navigate')
  const since = lastNav ? ms(lastNav) : 0
  const clicks = recent(3 * MIN, 'click').filter((a) => ms(a) >= since)
  if (clicks.length >= 12) return 'spin'
  return null
}

// 停留时长：只算窗口在前台、且最近一分钟内有过操作的时间。
// Dwell time: only time with the window in the foreground and some activity in the last minute.
export class Dwell {
  private total = 0
  private last: number
  private lastActive: number
  private visible = true
  static IDLE = 60_000

  constructor(now: number) {
    this.last = now
    this.lastActive = now
  }
  private settle(now: number) {
    if (this.visible) {
      const until = Math.min(now, this.lastActive + Dwell.IDLE)
      if (until > this.last) this.total += until - this.last
    }
    this.last = now
  }
  activity(now: number) {
    this.settle(now)
    this.lastActive = now
  }
  setVisible(visible: boolean, now: number) {
    this.settle(now)
    this.visible = visible
    if (visible) this.lastActive = now
  }
  seconds(now: number): number {
    this.settle(now)
    return Math.round(this.total / 100) / 10
  }
}
