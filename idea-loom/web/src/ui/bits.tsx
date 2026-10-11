import { Link } from 'react-router'
import type { Idea, State, ThreadId } from '../contract'
import { type Lang, label, pick } from '../i18n'
import { useLang, useT } from '../state/store'

// 状态永远是"形状 + 文字"，不只靠颜色。
// Status is always a shape plus text, never colour alone.
const STATUS_MARK: Record<string, string> = { draft: '◌', pool: '●', building: '◐', built: '◆', merged: '⤳', discarded: '×' }

export function StatusBadge({ idea }: { idea: Pick<Idea, 'status' | 'status_label'> }) {
  const lang = useLang()
  return (
    <span className={`badge status-${idea.status}`}>
      <span aria-hidden="true">{STATUS_MARK[idea.status]}</span> {label(lang, 'status', idea.status, idea.status_label)}
    </span>
  )
}

export function ThreadChips({ threads, state }: { threads: ThreadId[] | undefined; state: State }) {
  const lang = useLang()
  const t = useT()
  if (!threads?.length) return <span className="muted small">{t('无横线', 'No thread')}</span>
  return (
    <span className="chips">
      {threads.map((id) => {
        const info = state.frame.threads.find((x) => x.id === id)
        return (
          <span key={id} className={`chip thread thread-${id}`} title={pick(lang, info?.desc, info?.desc_en) || pick(lang, info?.name, info?.name_en)}>
            {id} {pick(lang, info?.short, info?.short_en)}
          </span>
        )
      })}
    </span>
  )
}

export function IdeaLink({ id, state, showTitle = true }: { id: string; state: State; showTitle?: boolean }) {
  const lang = useLang()
  const idea = state.ideas.find((i) => i.id === id)
  return (
    <Link to={`/ideas/${encodeURIComponent(id)}`} className={`idea-link${idea && !['pool', 'building', 'built'].includes(idea.status) ? ' gone' : ''}`}>
      <span className="id num">{id}</span>
      {showTitle && idea && <span> {ideaTitle(lang, idea)}</span>}
    </Link>
  )
}

// 一条 idea 在当前语言下的标题和正文；没有英文就用中文。
// The title and body of an idea in the current language; Chinese when there is no English.
export function ideaTitle(lang: Lang, idea: Pick<Idea, 'title' | 'title_en'>): string {
  return pick(lang, idea.title, idea.title_en)
}

export function ideaBody(lang: Lang, idea: Pick<Idea, 'body' | 'body_en'>): string {
  return pick(lang, idea.body, idea.body_en)
}

export function levelName(state: State, level: string, lang: Lang): string {
  const info = state.frame.levels.find((l) => l.id === level)
  if (!info) return level
  const name = pick(lang, info.name, info.name_en)
  return info.kind === 'ladder' ? `${info.id} ${name}` : name
}

// 内核的中文名同时是它的标识（筛选、地址、idea.kernel 都用它），这里只换显示出来的名字。
// A kernel's Chinese name is also its identifier (filters, URLs and idea.kernel all use
// it); this changes only the name that is displayed.
export function kernelName(state: State, name: string, lang: Lang): string {
  const info = state.frame.kernels.find((k) => k.name === name)
  return info ? pick(lang, info.name, info.name_en) : name
}
