import { Link } from 'react-router'
import type { Idea, State, ThreadId } from '../contract'

// 状态永远是"形状 + 文字"，不只靠颜色。
// Status is always a shape plus text, never colour alone.
const STATUS_MARK: Record<string, string> = { draft: '◌', pool: '●', building: '◐', built: '◆', merged: '⤳', discarded: '×' }

export function StatusBadge({ idea }: { idea: Pick<Idea, 'status' | 'status_label'> }) {
  return (
    <span className={`badge status-${idea.status}`}>
      <span aria-hidden="true">{STATUS_MARK[idea.status]}</span> {idea.status_label}
    </span>
  )
}

export function ThreadChips({ threads, state }: { threads: ThreadId[] | undefined; state: State }) {
  if (!threads?.length) return <span className="muted small">无横线</span>
  return (
    <span className="chips">
      {threads.map((t) => {
        const info = state.frame.threads.find((x) => x.id === t)
        return (
          <span key={t} className={`chip thread thread-${t}`} title={info?.desc || info?.name}>
            {t} {info?.short}
          </span>
        )
      })}
    </span>
  )
}

export function IdeaLink({ id, state, showTitle = true }: { id: string; state: State; showTitle?: boolean }) {
  const idea = state.ideas.find((i) => i.id === id)
  return (
    <Link to={`/ideas/${encodeURIComponent(id)}`} className={`idea-link${idea && !['pool', 'building', 'built'].includes(idea.status) ? ' gone' : ''}`}>
      <span className="id num">{id}</span>
      {showTitle && idea && <span> {idea.title}</span>}
    </Link>
  )
}

export function levelName(state: State, level: string): string {
  const info = state.frame.levels.find((l) => l.id === level)
  if (!info) return level
  return info.kind === 'ladder' ? `${info.id} ${info.name}` : info.name
}
