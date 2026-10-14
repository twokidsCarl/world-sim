// 左侧栏的数这类东西要跟上后端：进来时取一次，窗口回到前台或重新拿到焦点时再取，看得见的时候隔一会儿取一次。
// 页面藏起来（换了标签页、最小化）时不取，回来时先补一次再接着按间隔取。
// Things like the counts in the navigation have to keep up with the backend: fetched once on arrival, again when the
// window comes back to the front or regains focus, and every so often while it is visible. Nothing is fetched while the
// page is hidden (another tab, minimised); on return it catches up once and then goes on at the interval.

export const WATCH_EVERY = 15_000

// 浏览器里用到的那几样，测试时换成假的。 / The few browser pieces used, replaced by fakes in tests.
export type WatchEnv = {
  hidden: () => boolean
  listen: (event: 'focus' | 'visibilitychange', fn: () => void) => () => void
  every: (fn: () => void, ms: number) => () => void
}

export const browserEnv = (): WatchEnv => ({
  hidden: () => document.visibilityState === 'hidden',
  listen: (event, fn) => {
    const target: EventTarget = event === 'focus' ? window : document
    target.addEventListener(event, fn)
    return () => target.removeEventListener(event, fn)
  },
  every: (fn, ms) => {
    const timer = setInterval(fn, ms)
    return () => clearInterval(timer)
  },
})

// 开始盯着：返回停下来的函数。 / Start watching; returns the function that stops it.
export function watch(tick: () => void, ms = WATCH_EVERY, env: WatchEnv = browserEnv()): () => void {
  let stopTimer: (() => void) | null = null
  const run = () => {
    if (stopTimer) return
    tick()
    stopTimer = env.every(tick, ms)
  }
  const pause = () => {
    stopTimer?.()
    stopTimer = null
  }
  const onVisibility = () => (env.hidden() ? pause() : run())
  // 拿到焦点时页面一定看得见；计时器在跑的话不重排，只补取一次。 / A focused page is visible; with the timer running, only fetch once more.
  const onFocus = () => (stopTimer ? tick() : run())
  const offs = [env.listen('visibilitychange', onVisibility), env.listen('focus', onFocus)]
  if (!env.hidden()) run()
  return () => {
    pause()
    offs.forEach((off) => off())
  }
}
