import { describe, expect, it } from 'vitest'
import { type FeedCard, type History, rank, score } from '../src/play/feed'

const card = (key: string, over: Partial<FeedCard> = {}): FeedCard => ({ key, sim: key.split('/')[0]!, level: 'L1', idea: null, status: 'ready', ...over })
const seen = (over: Partial<History> = {}): History => ({ views: 1, seconds: 60, quick_skips: 0, liked: false, last_at: '', ...over })

describe('feed score', () => {
  const cards = [card('a/1', { idea: '1.1' }), card('a/2', { idea: '1.1' }), card('b/1', { level: 'L6' }), card('c/1', { level: 'L1' })]
  it('puts unseen cards first', () => {
    expect(score(cards[0]!, {}, cards)).toEqual({ score: 3, reasons: ['unseen'] })
    expect(score(cards[0]!, { 'a/1': seen() }, cards).score).toBe(-1)
  })
  it('moves seen cards back, more so when seen often, by three at most', () => {
    expect(score(cards[0]!, { 'a/1': seen({ views: 2 }) }, cards).score).toBe(-2)
    expect(score(cards[0]!, { 'a/1': seen({ views: 9 }) }, cards).score).toBe(-3)
  })
  it('demotes a card left within seconds, unless it was really watched at some point', () => {
    expect(score(cards[0]!, { 'a/1': seen({ seconds: 3, quick_skips: 1 }) }, cards)).toEqual({ score: -3, reasons: ['seen', 'skipped'] })
    expect(score(cards[0]!, { 'a/1': seen({ views: 2, seconds: 90, quick_skips: 1 }) }, cards).reasons).toEqual(['seen'])
  })
  it('lifts cards of a liked idea, and less so cards of a liked level', () => {
    const history = { 'a/1': seen({ liked: true }) }
    expect(score(cards[1]!, history, cards)).toEqual({ score: 5, reasons: ['unseen', 'liked-idea'] })
    expect(score(cards[3]!, history, cards)).toEqual({ score: 4, reasons: ['unseen', 'liked-level'] })
    expect(score(cards[2]!, history, cards)).toEqual({ score: 3, reasons: ['unseen'] })
    expect(score(cards[0]!, history, cards)).toEqual({ score: 0, reasons: ['seen', 'liked'] })
  })
  it('sends cards that are not ready to the end', () => {
    expect(score(card('d/1', { status: 'building' }), {}, cards)).toEqual({ score: -100, reasons: ['not-ready'] })
  })
})

describe('feed order', () => {
  it('avoids two cards of the same project in a row when it can', () => {
    const cards = [card('a/1'), card('a/2'), card('a/3'), card('b/1'), card('c/1')]
    expect(rank(cards, {}).map((r) => r.card.key)).toEqual(['a/1', 'b/1', 'a/2', 'c/1', 'a/3'])
  })
  it('is deterministic and keeps every card exactly once', () => {
    const cards = [card('b/2'), card('a/1'), card('b/1'), card('z/9', { status: 'failed' })]
    const history = { 'b/1': seen({ views: 3 }) }
    const first = rank(cards, history).map((r) => r.card.key)
    expect(rank([...cards].reverse(), history).map((r) => r.card.key)).toEqual(first)
    expect([...first].sort()).toEqual(['a/1', 'b/1', 'b/2', 'z/9'])
    expect(first[first.length - 1]).toBe('z/9')
    expect(first.indexOf('b/1')).toBeGreaterThan(first.indexOf('b/2'))
  })
})
