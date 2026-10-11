// play 页的推荐顺序。规则是写明的打分，不是黑箱；每张卡带着"为什么排在这儿"的理由。
// The order of the play feed. The rules are an explicit score, not a black box, and every
// card carries the reason it sits where it does.
export type FeedCard = { key: string; sim: string; level: string | null; idea: string | null; status: string }
export type History = { views: number; seconds: number; quick_skips: number; liked: boolean; last_at: string }
export type Reason = 'unseen' | 'liked-idea' | 'liked-level' | 'liked' | 'skipped' | 'seen' | 'not-ready'
export type Ranked<T> = { card: T; score: number; reasons: Reason[] }

const SAME_SIM_PENALTY = 1.5

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

// 每次挑分数最高的；和上一张是同一个项目的要扣分，让相邻两张尽量不同。分数相同按编号排，结果是确定的。
// Pick the highest score each time; a card from the same project as the previous pick is
// penalised so neighbours differ. Ties break by key, so the result is deterministic.
export function rank<T extends FeedCard>(cards: T[], history: Record<string, History>): Ranked<T>[] {
  const pool = cards.map((card) => ({ card, ...score(card, history, cards) }))
  const out: Ranked<T>[] = []
  let last = ''
  while (pool.length) {
    let best = 0
    for (let i = 1; i < pool.length; i++) {
      const a = pool[i]!.score - (pool[i]!.card.sim === last ? SAME_SIM_PENALTY : 0)
      const b = pool[best]!.score - (pool[best]!.card.sim === last ? SAME_SIM_PENALTY : 0)
      if (a > b || (a === b && pool[i]!.card.key < pool[best]!.card.key)) best = i
    }
    const [picked] = pool.splice(best, 1)
    out.push(picked!)
    last = picked!.card.sim
  }
  return out
}
