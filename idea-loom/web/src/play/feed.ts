// play 页的推荐顺序。规则是写明的打分，不是黑箱；每张卡带着"为什么排在这儿"的理由。
// The order of the play feed. The rules are an explicit score, not a black box, and every
// card carries the reason it sits where it does.
export type FeedCard = { key: string; sim: string; level: string | null; idea: string | null; status: string }
export type History = { views: number; seconds: number; quick_skips: number; liked: boolean; last_at: string }
export type Reason = 'unseen' | 'liked-idea' | 'liked-level' | 'liked' | 'skipped' | 'seen' | 'not-ready' | 'explore'
export type Ranked<T> = { card: T; score: number; reasons: Reason[] }

const SAME_SIM_PENALTY = 1.5
const EXPLORE_EVERY = 5
const OPENING_FROM = 4 // 第一张从排在前面的几个项目里随机挑 / the first card is drawn from this many leading projects

export function score(card: FeedCard, history: Record<string, History>, cards: FeedCard[]): { score: number; reasons: Reason[] } {
  const reasons: Reason[] = []
  let s = 0
  if (card.status !== 'ready') return { score: -100, reasons: ['not-ready'] }
  const h = history[card.key]
  const liked = cards.filter((c) => c.key !== card.key && history[c.key]?.liked)
  if (!h || h.views === 0) {
    s += 3
    reasons.push('unseen')
  } else {
    // 看过的往后放，看得越多越靠后，最多扣三分。 / Seen cards move back, at most three points.
    s -= Math.min(h.views, 3)
    reasons.push('seen')
    // 进来几秒就划走、从没停下来看过的，再往后。 / Left within seconds and never really watched: further back.
    if (h.quick_skips > 0 && h.seconds < 20) {
      s -= 2
      reasons.push('skipped')
    }
    if (h.liked) {
      s += 1
      reasons.push('liked')
    }
  }
  if (card.idea && liked.some((c) => c.idea === card.idea)) {
    s += 2
    reasons.push('liked-idea')
  } else if (card.level && liked.some((c) => c.level === card.level)) {
    s += 1
    reasons.push('liked-level')
  }
  return { score: s, reasons }
}

// 带种子的小随机数发生器（mulberry32）：同一个种子给出同一串数。
// A small seeded generator (mulberry32): the same seed gives the same sequence.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 每次挑分数最高的；和上一张是同一个项目的要扣分，让相邻两张尽量不同。分数相同按编号排。
// Pick the highest score each time; a card from the same project as the previous pick is
// penalised so neighbours differ. Ties break by key.
//
// 硬限制：任意连着的三张里，同一个项目最多出现一次，只要别的项目还有同一档的卡（准备好的是一档，没准备好的
// 是另一档，排在最后）。
// Hard limit: within any three consecutive cards a project appears at most once, as long as another
// project still has a card in the same tier (ready cards are one tier, cards that are not ready
// another, placed last).
//
// 给了 seed 时有两处随机：第一张从排在前面的几个项目各自最好的卡里随机挑；之后准备好的卡里每第
// EXPLORE_EVERY 个位置是"探索位"，从还没排的卡里随机挑一张（同样守上面的限制），并在理由里写明。
// 同一个 seed 得到同一个顺序；不给 seed 就完全没有随机。
// With a seed there are two random elements: the first card is drawn from the best cards of the
// leading few projects; after that every EXPLORE_EVERY-th ready position is an exploration slot,
// drawn at random from the cards not yet placed (under the same limit) and marked in its reasons.
// The same seed gives the same order; without a seed nothing is random.
export function rank<T extends FeedCard>(cards: T[], history: Record<string, History>, seed?: number): Ranked<T>[] {
  // 先按编号排，结果就和传进来的顺序无关。 / Sort by key first so the input order does not matter.
  const scored = cards.map((card) => ({ card, ...score(card, history, cards) })).sort((a, b) => (a.card.key < b.card.key ? -1 : a.card.key > b.card.key ? 1 : 0))
  const random = seed === undefined ? null : mulberry32(seed)
  const out: Ranked<T>[] = []
  let last = ''
  let before = '' // 上上张的项目 / the project of the pick before the last
  for (const ready of [true, false]) {
    const pool = scored.filter((r) => (r.card.status === 'ready') === ready)
    while (pool.length) {
      // 在浏览器里实际点过：只限制"最多连两张"时，分数高的那个项目仍然每三张占两张，看着还是它。
      // 所以收紧成：任意连着的三张里，同一个项目最多出现一次——只要别的项目还有卡。做不到就退一步，
      // 只要求和上一张不同；再做不到（只剩一个项目了）才不限制。
      // Tried by clicking in a browser: with only "at most two in a row", the top-scoring project
      // still took two of every three cards and the feed still looked like that project. So it is
      // tightened: within any three consecutive cards a project appears at most once, as long as
      // other projects have cards. Failing that it falls back to differing from the previous card,
      // and only when one project is left is nothing required.
      const all = pool.map((_, i) => i)
      const fresh = all.filter((i) => pool[i]!.card.sim !== last && pool[i]!.card.sim !== before)
      const other = all.filter((i) => pool[i]!.card.sim !== last)
      // 但别把"别的项目"的卡太早用光：卡最多的那个项目有 n 张时，要让它每三张只出一次，别的项目至少得有
      // 2(n−1) 张。不够的话就只要求和上一张不同，这样才能一直错开到最后，而不是前面很匀、后面连成一串。
      // But do not use up the other projects' cards too early: for the project with the most cards, n,
      // to appear once in three, the others need at least 2(n−1). When they have fewer, only "differ
      // from the previous card" is required, so cards stay interleaved to the end instead of being
      // even at first and bunched up later.
      const counts = new Map<string, number>()
      for (const r of pool) counts.set(r.card.sim, (counts.get(r.card.sim) ?? 0) + 1)
      const most = Math.max(...counts.values())
      const spread = pool.length - most >= 2 * (most - 1)
      const allowed = spread && fresh.length ? fresh : other.length ? other : all
      let best = allowed[0]!
      const explore = random !== null && ready && (out.length + 1) % EXPLORE_EVERY === 0
      if (random !== null && ready && out.length === 0) {
        // 第一张：每个项目出它分数最高的那张，从其中排在前面的几个项目里随机挑一个。
        // 这样每次进来看到的第一张不一样，但仍然是各项目里最值得看的。
        // The first card: each project puts forward its best card and one of the leading few
        // projects is picked at random. Every visit then opens differently, yet still on a
        // card that is among the most worth seeing.
        const top = new Map<string, number>()
        for (const i of allowed) {
          const held = top.get(pool[i]!.card.sim)
          if (held === undefined || pool[i]!.score > pool[held]!.score) top.set(pool[i]!.card.sim, i)
        }
        const leaders = [...top.values()].sort((a, b) => pool[b]!.score - pool[a]!.score || a - b).slice(0, OPENING_FROM)
        best = leaders[Math.floor(random() * leaders.length)]!
      } else if (explore) {
        best = allowed[Math.floor(random() * allowed.length)]!
      } else {
        const value = (i: number) => pool[i]!.score - (pool[i]!.card.sim === last ? SAME_SIM_PENALTY : 0)
        // allowed 按编号升序，所以只在严格更高时才换，分数相同的留给编号小的。
        // `allowed` is in key order, so replacing only on a strictly higher value leaves ties to the smaller key.
        for (const i of allowed) if (value(i) > value(best)) best = i
      }
      const [picked] = pool.splice(best, 1)
      out.push(explore ? { ...picked!, reasons: [...picked!.reasons, 'explore'] } : picked!)
      before = last
      last = picked!.card.sim
    }
  }
  return out
}
