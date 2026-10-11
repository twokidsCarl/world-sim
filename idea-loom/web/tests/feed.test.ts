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

  // 一个项目的分数压过其余所有项目：收藏过 a 的一张卡，a 的其余卡都因为同一条 idea 加分。
  // One project outscores all the others: a card of `a` is liked, so the rest of `a` gains from the shared idea.
  const dominated = () => {
    const cards = [
      ...Array.from({ length: 12 }, (_, i) => card(`a/${String(i).padStart(2, '0')}`, { idea: '1.1', level: 'L3' })),
      ...Array.from({ length: 4 }, (_, i) => card(`b/${i}`, { level: 'L2' })),
      ...Array.from({ length: 3 }, (_, i) => card(`c/${i}`, { level: 'L4' })),
      card('d/0', { level: 'L5' }),
      card('z/9', { status: 'failed' }),
    ]
    const history = { 'a/00': seen({ liked: true }), 'b/0': seen({ views: 3 }), 'c/0': seen({ views: 2 }) }
    return { cards, history }
  }
  const keys = (seed?: number) => {
    const { cards, history } = dominated()
    return rank(cards, history, seed).map((r) => r.card.key)
  }
  // 三张连着是同一个项目，而它们后面还有别的项目的同一档的卡：这就破了硬限制。
  // Three in a row from one project while a card of another project in the same tier is still to come: the limit is broken.
  const brokenRuns = (order: string[]) => {
    const ready = (k: string) => k !== 'z/9'
    const sim = (k: string) => k.split('/')[0]!
    const bad: number[] = []
    for (let i = 2; i < order.length; i++) {
      const s = sim(order[i]!)
      if (sim(order[i - 1]!) !== s || sim(order[i - 2]!) !== s) continue
      if (order.slice(i + 1).some((k) => sim(k) !== s && ready(k) === ready(order[i]!))) bad.push(i)
    }
    return bad
  }

  it('would run one project for many cards without the limit, and never three in a row with it', () => {
    const { cards, history } = dominated()
    const a = cards.filter((c) => c.sim === 'a' && c.key !== 'a/00')
    expect(Math.min(...a.map((c) => score(c, history, cards).score)) - 1.5).toBeGreaterThan(Math.max(...cards.filter((c) => c.sim !== 'a').map((c) => score(c, history, cards).score)))
    expect(brokenRuns(keys())).toEqual([])
    for (let seed = 0; seed < 50; seed++) expect(brokenRuns(keys(seed))).toEqual([])
    // 前六张里不止一个项目。 / More than one project among the first six.
    expect(new Set(keys().slice(0, 6).map((k) => k.split('/')[0])).size).toBeGreaterThan(1)
  })
  it('gives the same order for the same seed, whatever the input order', () => {
    const { cards, history } = dominated()
    expect(keys(7)).toEqual(keys(7))
    expect(rank([...cards].reverse(), history, 7).map((r) => r.card.key)).toEqual(keys(7))
  })
  it('gives different orders for different seeds', () => {
    expect(new Set([1, 2, 3, 4, 5, 6].map((seed) => keys(seed).join(' '))).size).toBeGreaterThan(1)
  })
  it('keeps every card exactly once and cards that are not ready last, with any seed', () => {
    const all = dominated().cards.map((c) => c.key).sort()
    for (const seed of [undefined, 0, 1, 2, 3, 42, 2 ** 32 - 1]) {
      const order = keys(seed)
      expect([...order].sort()).toEqual(all)
      expect(order[order.length - 1]).toBe('z/9')
    }
  })
  it('is deterministic and has no exploration slots without a seed', () => {
    const { cards, history } = dominated()
    expect(keys()).toEqual(keys())
    expect(rank([...cards].reverse(), history).map((r) => r.card.key)).toEqual(keys())
    expect(rank(cards, history).some((r) => r.reasons.includes('explore'))).toBe(false)
  })
  it('marks every fifth ready position as an exploration pick, and only those', () => {
    const { cards, history } = dominated()
    for (const seed of [1, 2, 3]) {
      const ranked = rank(cards, history, seed)
      const at = ranked.flatMap((r, i) => (r.reasons.includes('explore') ? [i] : []))
      expect(at).toEqual([4, 9, 14, 19])
      // 探索的理由是加在原有理由后面的。 / The exploration reason is added after the card's own reasons.
      for (const i of at) expect(ranked[i]!.reasons).toEqual([...score(ranked[i]!.card, history, cards).reasons, 'explore'])
    }
  })
  it('opens each visit on a different leading card, always the best of its project', () => {
    const { cards, history } = dominated()
    const firsts = new Set(Array.from({ length: 40 }, (_, seed) => rank(cards, history, seed)[0]!.card.key))
    expect(firsts.size).toBeGreaterThan(1) // 每次进来第一张不一样 / the opening card varies between visits
    expect(firsts.size).toBeLessThanOrEqual(4)
    for (const key of firsts) {
      // 它是自己那个项目里分数最高的那张。 / It is the top-scored card of its own project.
      const sim = key.split('/')[0]!
      const best = Math.max(...cards.filter((c) => c.sim === sim && c.status === 'ready').map((c) => score(c, history, cards).score))
      expect(score(cards.find((c) => c.key === key)!, history, cards).score).toBe(best)
    }
    expect(rank(cards, history)[0]!.card.key).toBe(rank(cards, history)[0]!.card.key) // 不给种子时不随机 / no randomness without a seed
  })
  it('lets a project appear at most once in any three consecutive cards while others have enough cards', () => {
    // 五个项目，其中一个的分数远高于别的；别的项目一共 16 张，比错开 a 的 6 张所需的 10 张多。
    // Five projects, one scoring far above the rest; the others have 16 cards between them, more than the 10 needed to spread a's 6.
    const others = ['b', 'c', 'd', 'e'].flatMap((p) => [0, 1, 2, 3].map((i) => `${p}/${i}`))
    const cards = [...Array.from({ length: 6 }, (_, i) => card(`a/${i}`, { idea: '1.1' })), ...others.map((key) => card(key))]
    const history = Object.fromEntries(others.map((key) => [key, seen({ views: 3 })]))
    for (const seed of [undefined, 1, 2, 3, 4, 5, 6, 7]) {
      const sims = rank(cards, history, seed).map((r) => r.card.sim)
      for (let i = 0; i + 2 < 12; i++) expect(sims.slice(i, i + 3).filter((x) => x === 'a').length, `seed ${seed} at ${i}: ${sims.slice(i, i + 3)}`).toBeLessThanOrEqual(1)
      for (let i = 0; i + 1 < sims.length; i++) expect(sims[i] === 'a' && sims[i + 1] === 'a', `seed ${seed} at ${i}`).toBe(false)
    }
  })
})
