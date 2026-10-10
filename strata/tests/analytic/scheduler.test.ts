import { describe, expect, it } from 'vitest'
import type { QuantityDef, Sample } from '../../src/core/quantity'
import { Scheduler } from '../../src/core/scheduler'
import type { Backend } from '../../src/core/substrate'

interface F {
  step: number
  a?: number
  b?: number
}

const quantities: QuantityDef<F>[] = [
  { id: 'qa', level: 'micro', label: 'a', kind: 'scalar', reducers: ['a'], compute: (f) => f.a!, theory: () => 1 },
  { id: 'qb', level: 'micro', label: 'b', kind: 'scalar', reducers: ['b'], compute: (f) => f.b! },
]

function backend(log: string[][]): Backend<F> {
  return {
    step() {},
    setParams() {},
    dispose() {},
    reduce(ids) {
      log.push([...ids])
      return { step: 5, a: ids.includes('a') ? 10 : undefined, b: ids.includes('b') ? 20 : undefined }
    },
  }
}

describe('scheduler', () => {
  it('requests nothing when there are no subscribers', async () => {
    const log: string[][] = []
    await new Scheduler(quantities).tick(backend(log), {})
    expect(log).toEqual([])
  })

  it('computes only subscribed quantities and their reducers', async () => {
    const log: string[][] = []
    const sched = new Scheduler(quantities)
    const got: Sample[] = []
    const off = sched.subscribe('qa', (s) => got.push(s))
    await sched.tick(backend(log), {})
    expect(log).toEqual([['a']])
    expect(got).toEqual([{ step: 5, epoch: 0, value: 10, theory: 1 }])
    off()
    await sched.tick(backend(log), {})
    expect(log.length).toBe(1)
  })

  it('drops a frame whose epoch changed while it was being reduced', async () => {
    const sched = new Scheduler(quantities)
    const got: Sample[] = []
    sched.subscribe('qb', (s) => got.push(s))
    const slow: Backend<F> = {
      ...backend([]),
      reduce: () => new Promise((r) => setTimeout(() => r({ step: 1, b: 2 }), 5)),
    }
    const pending = sched.tick(slow, {})
    sched.epoch++
    await pending
    expect(got).toEqual([])
  })

  it('rejects unknown quantities', () => {
    expect(() => new Scheduler(quantities).subscribe('nope', () => {})).toThrow()
  })
})
