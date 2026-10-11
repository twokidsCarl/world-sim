import motm from '../data/motm.json'
import neuro from '../data/neuro.json'

const STOP = new Set(['the', 'and', 'of', 'in', 'to', 'a', 'an', 'with', 'for', 'by', 'protein', 'proteins', 'complex', 'structure', 'virus', 'human'])
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1 && !STOP.has(w))

export interface Article {
  n: number
  title: string
  pdb: string[]
}

/**
 * Molecule of the Month articles whose title matches the queries: every
 * significant word of the title must appear in one query. These are
 * curated picks, so they are the strongest prior for a representative entry.
 */
export function matchArticles(queries: string[], limit = 3): Article[] {
  const scored: { a: Article; score: number }[] = []
  for (const a of motm as Article[]) {
    const tw = words(a.title)
    if (tw.length === 0) continue
    let best = 0
    for (const q of queries) {
      const qw = new Set(words(q))
      const hit = tw.filter((w) => qw.has(w) || qw.has(w.replace(/s$/, '')) || qw.has(w + 's')).length
      if (hit === tw.length) best = Math.max(best, tw.length / Math.max(qw.size, tw.length) + tw.length * 0.01)
    }
    if (best > 0) scored.push({ a, score: best })
  }
  return scored.sort((x, y) => y.score - x.score).slice(0, limit).map((s) => s.a)
}


/**
 * 神经相关的地标结构里，关键词和查询对得上的那些（至少两个词相同，或者关键词只有一个词而它出现了）。
 * 和“每月分子”一样，只是给检索添一条线索；编号仍要经 RCSB 确认才成为候选。
 * Landmark structures of the nervous system whose keywords match the queries (at least two words
 * in common, or a single-word keyword list whose word appears). Like the Molecule of the Month
 * table this is only one more search hint; an id still has to be confirmed by RCSB to become a candidate.
 */
export function matchNeuro(queries: string[], limit = 4): { id: string; title: string }[] {
  const scored: { id: string; title: string; score: number }[] = []
  const qw = new Set(queries.flatMap((q) => q.toLowerCase().replace(/[^a-z0-9/-]+/g, ' ').split(' ').filter((w) => w.length > 1)))
  for (const g of neuro.groups)
    for (const e of g.entries) {
      const kw = e.keywords.split(' ')
      const hit = kw.filter((w) => qw.has(w)).length
      if (hit >= Math.min(2, kw.length)) scored.push({ id: e.id, title: e.titleEn, score: hit / kw.length + hit * 0.01 })
    }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}
