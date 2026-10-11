// 最近发布的结构与论文信息 / recently released structures and their papers
import { describe, expect, it } from 'vitest'
import { JOURNALS, recentQuery } from '../server/sources/literature'

describe('recent structures', () => {
  it('asks RCSB for one journal since one date, newest first', () => {
    const q = recentQuery('Science', '2026-07-13', 60)
    expect(q.query.nodes).toEqual([
      { type: 'terminal', service: 'text', parameters: { attribute: 'rcsb_primary_citation.rcsb_journal_abbrev', operator: 'exact_match', value: 'Science' } },
      { type: 'terminal', service: 'text', parameters: { attribute: 'rcsb_accession_info.initial_release_date', operator: 'greater_or_equal', value: '2026-07-13' } },
    ])
    expect(q.request_options.sort[0]).toEqual({ sort_by: 'rcsb_accession_info.initial_release_date', direction: 'desc' })
    expect(q.request_options.paginate.rows).toBe(60)
  })

  it('offers the journals the plan named', () => {
    for (const j of ['Nature', 'Science', 'Cell']) expect(JOURNALS).toContain(j)
  })
})
