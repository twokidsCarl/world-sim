import type { Idea, State } from '../contract'
import { formatTime } from '../state/derive'
import { Page } from '../ui/Page'
import { IdeaLink, levelName } from '../ui/bits'

type Batch = { key: string; subject: string; at: string; pr: number | null; ideas: Idea[] }

// 按"哪一次进来的"把 idea 分成批，时间从早到晚。
// Group ideas into batches by when they entered the pool, oldest first.
export function batches(ideas: Idea[]): Batch[] {
  const out = new Map<string, Batch>()
  for (const idea of ideas) {
    const o = idea.origin
    const key = o.commit ?? `${o.how}:${idea.created_at.slice(0, 10)}`
    const subject = o.subject ?? (o.how === 'human' ? '手写' : o.how === 'generate' ? '生成' : o.how === 'assistant' ? '小助手提议' : o.how)
    const batch = out.get(key) ?? { key, subject, at: idea.created_at, pr: o.pr, ideas: [] }
    batch.ideas.push(idea)
    if (idea.created_at < batch.at) batch.at = idea.created_at
    out.set(key, batch)
  }
  return [...out.values()].sort((a, b) => a.at.localeCompare(b.at))
}

export function LineagePage({ state }: { state: State }) {
  const all = batches(state.ideas)
  const merges = state.links.filter((l) => l.kind !== 'mentions')
  return (
    <Page title="血缘" lead="想法池是一批一批长出来的。这里按进来的先后排列，标出谁并入了谁、谁是从谁细化或融合来的。">
      <ol className="batches">
        {all.map((b, i) => {
          const byLevel = new Map<string, Idea[]>()
          for (const idea of b.ideas) byLevel.set(idea.level, [...(byLevel.get(idea.level) ?? []), idea])
          return (
            <li key={b.key} className="batch">
              <div className="batch-head">
                <span className="batch-n num">第 {i + 1} 批</span>
                <h2>{b.subject}</h2>
                <span className="muted small">
                  {formatTime(b.at)} · {b.ideas.length} 条
                  {b.pr != null && (
                    <>
                      {' · '}
                      <a href={`https://github.com/twokidsCarl/world-sim/pull/${b.pr}`} target="_blank" rel="noreferrer">
                        #{b.pr}
                      </a>
                    </>
                  )}
                </span>
              </div>
              <div className="batch-levels">
                {state.frame.levels
                  .filter((l) => byLevel.has(l.id))
                  .map((l) => (
                    <div key={l.id} className="batch-level">
                      <div className="muted small">{levelName(state, l.id)}</div>
                      <ul className="plain">
                        {byLevel.get(l.id)!.map((idea) => {
                          const out = merges.filter((m) => m.source === idea.id)
                          const into = merges.filter((m) => m.target === idea.id)
                          return (
                            <li key={idea.id}>
                              <IdeaLink id={idea.id} state={state} />
                              {out.map((m) => (
                                <span key={m.target + m.kind} className="muted small rel">
                                  {' '}
                                  → {m.label} <IdeaLink id={m.target} state={state} showTitle={false} />
                                </span>
                              ))}
                              {into.length > 0 && (
                                <span className="muted small rel">
                                  {' '}
                                  ← {into.map((m) => m.source).join('、')}
                                </span>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  ))}
              </div>
            </li>
          )
        })}
      </ol>
    </Page>
  )
}
