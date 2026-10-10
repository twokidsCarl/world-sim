import motm from '../data/motm.json'

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
