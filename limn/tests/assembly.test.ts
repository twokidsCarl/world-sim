import { describe, expect, it } from 'vitest'
import { mul4, parseOperExpression } from '../src/mol/assembly'

describe('parseOperExpression', () => {
  it('reads a single operator', () => {
    expect(parseOperExpression('1')).toEqual([['1']])
  })
  it('expands lists and ranges', () => {
    expect(parseOperExpression('1,3,5-7')).toEqual([['1'], ['3'], ['5'], ['6'], ['7']])
  })
  it('keeps non-numeric ids', () => {
    expect(parseOperExpression('P,X0')).toEqual([['P'], ['X0']])
  })
  it('takes the product of parenthesised groups', () => {
    const out = parseOperExpression('(1-60)(61-88)')
    expect(out.length).toBe(60 * 28)
    expect(out[0]).toEqual(['1', '61'])
    expect(out[out.length - 1]).toEqual(['60', '88'])
  })
})

describe('mul4', () => {
  it('composes translations (column-major)', () => {
    const t = (x: number, y: number, z: number) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1])
    const m = mul4(t(1, 2, 3), t(10, 20, 30))
    expect([m[12], m[13], m[14]]).toEqual([11, 22, 33])
  })
  it('applies the right-hand matrix first', () => {
    // rotate 90 degrees about z, then translate by x+5: (1,0,0) -> (0,1,0) -> (5,1,0)
    const rotZ = new Float32Array([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    const tx = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1])
    const m = mul4(tx, rotZ)
    const x = m[0]! * 1 + m[12]!, y = m[1]! * 1 + m[13]!
    expect([x, y]).toEqual([5, 1])
  })
})
