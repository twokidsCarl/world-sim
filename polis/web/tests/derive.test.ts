import { describe, expect, it } from 'vitest'
import type { Manifest, Population, Series } from '../src/contract/types.gen.ts'
import {
  QUEUEING, STATUS, assemble, channel, clockText, eventsAt, indexByTick, parseEvents, personLog, queueRanks, queueSlot,
  value,
} from '../src/state/derive.ts' // prettier-ignore

const events = parseEvents(
  [
    '{"t":0,"k":"seed","a":0,"m":0}',
    '{"t":2,"k":"tell","a":0,"b":1,"m":0,"via":"kin","p0":5,"p1":30}',
    '{"t":2,"k":"queue","a":2}',
    '{"t":3,"k":"queue","a":1}',
    '',
  ].join('\n'),
)

function run() {
  const n = 3
  const ticks = 3
  const frames = new Uint8Array((ticks + 1) * 4 * n)
  const set = (k: number, c: number, i: number, v: number) => (frames[(k * 4 + c) * n + i] = v)
  set(2, STATUS, 2, QUEUEING)
  set(3, STATUS, 2, QUEUEING)
  set(3, STATUS, 1, QUEUEING)
  set(2, 0, 1, 77)
  const manifest = { run_id: 'x', n, ticks, params: { start_hour: 20 } } as Manifest
  const population = {
    cast: { witness: 0 },
    persons: [{ idx: 0 }, { idx: 1 }, { idx: 2 }],
    ties: [{ a: 0, b: 1, kind: 'kin', strength: 0.9 }],
  } as unknown as Population
  return assemble(manifest, population, [], {} as Series, events, frames)
}

describe('events', () => {
  it('indexes events by tick, including empty ticks', () => {
    expect(indexByTick(events, 3)).toEqual([0, 1, 1, 3, 4])
    const r = run()
    expect(eventsAt(r, 1)).toEqual([])
    expect(eventsAt(r, 2).map((e) => e.k)).toEqual(['tell', 'queue'])
    expect(eventsAt(r, 9)).toEqual([])
  })

  it('collects what a person did and what was said to them', () => {
    const r = run()
    expect(personLog(r, 1).map((e) => e.k)).toEqual(['tell', 'queue'])
    expect(personLog(r, 0).map((e) => e.k)).toEqual(['seed', 'tell'])
  })
})

describe('frames', () => {
  it('reads a value and a channel', () => {
    const r = run()
    expect(value(r, 2, 0, 1)).toBe(77)
    expect(Array.from(channel(r, 3, STATUS))).toEqual([0, QUEUEING, QUEUEING])
  })

  it('ranks the queue in the order people joined', () => {
    const r = run()
    expect(Array.from(queueRanks(r, 2))).toEqual([-1, -1, 0])
    expect(Array.from(queueRanks(r, 3))).toEqual([-1, 1, 0])
    expect(r.neighbors).toEqual([[1], [0], []])
  })

  it('spreads the queue outward from the bank', () => {
    const near = queueSlot([500, 500], 0)
    const far = queueSlot([500, 500], 200)
    expect(Math.hypot(near[0] - 500, near[1] - 500)).toBeLessThan(Math.hypot(far[0] - 500, far[1] - 500))
  })
})

describe('clock', () => {
  it('counts days from the starting hour', () => {
    const r = run()
    expect(clockText(r, 0)).toBe('第一天 20:00')
    expect(clockText(r, 3.7)).toBe('第一天 23:00')
    expect(clockText(r, 4)).toBe('第二天 00:00')
  })
})
