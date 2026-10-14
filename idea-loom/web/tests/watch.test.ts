import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type WatchEnv, watch } from '../src/ui/watch'

// 一个假的浏览器：能切换看得见与否，能触发事件，计时器用 vitest 的假时钟。
// A fake browser: visibility can be switched, events fired, and the timer runs on vitest's fake clock.
function fakeEnv(hidden = false) {
  const state = { hidden }
  const listeners: Record<'focus' | 'visibilitychange', Set<() => void>> = { focus: new Set(), visibilitychange: new Set() }
  const env: WatchEnv = {
    hidden: () => state.hidden,
    listen: (event, fn) => (listeners[event].add(fn), () => listeners[event].delete(fn)),
    every: (fn, ms) => {
      const timer = setInterval(fn, ms)
      return () => clearInterval(timer)
    },
  }
  const fire = (event: 'focus' | 'visibilitychange') => listeners[event].forEach((fn) => fn())
  const setHidden = (h: boolean) => ((state.hidden = h), fire('visibilitychange'))
  return { env, fire, setHidden, listeners }
}

describe('watch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fetches on arrival and then at the interval while visible', () => {
    const tick = vi.fn()
    const { env } = fakeEnv()
    watch(tick, 1000, env)
    expect(tick).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(3000)
    expect(tick).toHaveBeenCalledTimes(4)
  })

  it('does not poll while hidden and catches up on return', () => {
    const tick = vi.fn()
    const f = fakeEnv()
    watch(tick, 1000, f.env)
    f.setHidden(true)
    vi.advanceTimersByTime(10_000)
    expect(tick).toHaveBeenCalledTimes(1)
    f.setHidden(false)
    expect(tick).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1000)
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it('starts hidden without fetching, and fetches on focus', () => {
    const tick = vi.fn()
    const f = fakeEnv(true)
    watch(tick, 1000, f.env)
    vi.advanceTimersByTime(5000)
    expect(tick).not.toHaveBeenCalled()
    f.fire('focus')
    expect(tick).toHaveBeenCalledTimes(1)
    f.fire('focus') // 计时器已经在跑：只补一次，不重复开计时器 / timer already running: one more fetch, no second timer
    vi.advanceTimersByTime(1000)
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it('stops everything when stopped', () => {
    const tick = vi.fn()
    const f = fakeEnv()
    const stop = watch(tick, 1000, f.env)
    stop()
    vi.advanceTimersByTime(5000)
    f.fire('focus')
    expect(tick).toHaveBeenCalledTimes(1)
    expect(f.listeners.focus.size + f.listeners.visibilitychange.size).toBe(0)
  })
})
