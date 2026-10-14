import { describe, expect, it } from 'vitest'
import { IDLE_MS, isStale, parseRestart, parseVersion, shouldReload } from '../src/version'

// 版本比较的纯逻辑。 / The pure logic of comparing versions.

describe('parseVersion', () => {
  it('reads both marks', () => {
    expect(parseVersion({ ok: true, started: '17', ui: 42 })).toEqual({ started: '17', ui: 42 })
  })
  it('keeps a missing build as null', () => {
    expect(parseVersion({ ok: true, started: '17', ui: null })).toEqual({ started: '17', ui: null })
    expect(parseVersion({ ok: true, started: '17' })).toEqual({ started: '17', ui: null })
  })
  it('rejects replies without the marks', () => {
    expect(parseVersion({ ok: true })).toBeNull()
    expect(parseVersion({ ok: false, started: '17', ui: 42 })).toBeNull()
    expect(parseVersion({ ok: true, started: '', ui: 42 })).toBeNull()
    expect(parseVersion(null)).toBeNull()
    expect(parseVersion('ok')).toBeNull()
  })
})

describe('isStale', () => {
  const first = { started: '17', ui: 42 }
  it('is fresh while nothing changed', () => {
    expect(isStale(first, { started: '17', ui: 42 })).toBe(false)
  })
  it('is stale after a backend restart', () => {
    expect(isStale(first, { started: '18', ui: 42 })).toBe(true)
  })
  it('is stale after a UI rebuild', () => {
    expect(isStale(first, { started: '17', ui: 43 })).toBe(true)
    expect(isStale({ started: '17', ui: null }, first)).toBe(true)
  })
  it('never counts a missing reply', () => {
    expect(isStale(null, first)).toBe(false)
    expect(isStale(first, null)).toBe(false)
    expect(isStale(null, null)).toBe(false)
  })
})

describe('parseRestart', () => {
  it('reads the restart state', () => {
    expect(parseRestart({ ok: true, code_stale: true, self_restart: true, restart_waiting: 'busy' })).toEqual({ needed: true, auto: true, waiting: 'busy' })
  })
  it('treats what an old backend lacks as absent', () => {
    expect(parseRestart({ ok: true, code_stale: true })).toEqual({ needed: true, auto: false, waiting: null })
    expect(parseRestart(null)).toEqual({ needed: false, auto: false, waiting: null })
  })
})

// 过时的页面什么时候自己刷新：不丢正在写的东西。 / When a stale page reloads itself: never losing what is being written.
describe('shouldReload', () => {
  it('reloads a stale page nobody is typing in', () => {
    expect(shouldReload({ stale: true, unsaved: false, sinceInput: Infinity })).toBe(true)
  })
  it('never reloads a current page', () => {
    expect(shouldReload({ stale: false, unsaved: false, sinceInput: Infinity })).toBe(false)
  })
  it('waits while a field holds typed text', () => {
    expect(shouldReload({ stale: true, unsaved: true, sinceInput: Infinity })).toBe(false)
  })
  it('waits until typing has been idle a while', () => {
    expect(shouldReload({ stale: true, unsaved: false, sinceInput: IDLE_MS - 1 })).toBe(false)
    expect(shouldReload({ stale: true, unsaved: false, sinceInput: IDLE_MS })).toBe(true)
  })
})
