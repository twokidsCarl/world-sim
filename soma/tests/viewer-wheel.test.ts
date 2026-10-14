import { describe, expect, it } from 'vitest'
import { isTrackpadScroll } from '../src/viewer/wheel.ts'

// 触控板双指滑动平移、鼠标滚轮缩放的判断 / telling a trackpad swipe (pan) from a mouse wheel (zoom)
describe('isTrackpadScroll', () => {
  it('takes a trackpad swipe in Chrome / Safari as a pan (wheelDeltaY = −3 × deltaY)', () => {
    expect(isTrackpadScroll({ deltaX: 0, deltaY: 7, deltaMode: 0, wheelDeltaY: -21 })).toBe(true)
    expect(isTrackpadScroll({ deltaX: 0, deltaY: -2, deltaMode: 0, wheelDeltaY: 6 })).toBe(true)
  })
  it('takes any sideways component as a pan', () => {
    expect(isTrackpadScroll({ deltaX: 3, deltaY: 0, deltaMode: 0, wheelDeltaY: 0 })).toBe(true)
    expect(isTrackpadScroll({ deltaX: -1.5, deltaY: 4, deltaMode: 0 })).toBe(true)
  })
  it('leaves a mouse wheel to zoom', () => {
    // Chrome on macOS: 4.000244140625 per notch against a legacy 12 / Windows: 100 against 120 / Firefox: lines
    expect(isTrackpadScroll({ deltaX: 0, deltaY: 4.000244140625, deltaMode: 0, wheelDeltaY: -12 })).toBe(false)
    expect(isTrackpadScroll({ deltaX: 0, deltaY: 100, deltaMode: 0, wheelDeltaY: -120 })).toBe(false)
    expect(isTrackpadScroll({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toBe(false)
  })
  it('without the legacy field, pixel scrolling is a trackpad', () => {
    expect(isTrackpadScroll({ deltaX: 0, deltaY: 12, deltaMode: 0 })).toBe(true)
  })
})
