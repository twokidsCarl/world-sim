import { describe, expect, it } from 'vitest'
import { wishCommand, wishName } from '../src/pages/wishName'

// 愿望给人叫的名字和交给 Claude Code 的命令。 / The name people use for a wish and the command handed to Claude Code.
describe('wish names', () => {
  it('names a wish by its sequence number', () => {
    expect(wishName(1)).toBe('wish-1')
    expect(wishName(42)).toBe('wish-42')
  })
  it('gives no name when the number is missing', () => {
    expect(wishName(undefined)).toBe('')
    expect(wishName(0)).toBe('')
  })
  it('builds the /wishes command, falling back to the full id', () => {
    expect(wishCommand({ number: 7, wish_id: 'wish-20261012T160005Z-8360' })).toBe('/wishes wish-7')
    expect(wishCommand({ wish_id: 'wish-20261012T160005Z-8360' })).toBe('/wishes wish-20261012T160005Z-8360')
  })
})
