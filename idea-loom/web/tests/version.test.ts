import { describe, expect, it } from 'vitest'
import { isStale, parseVersion } from '../src/version'

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
