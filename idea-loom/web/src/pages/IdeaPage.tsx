import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { type CardView, type ProjectView, type Task, api } from '../api'
import { SimFrame } from '../ui/SimFrame'
import type { HistoryItem, IdeaDetail, Link as Edge, State } from '../contract'
import { type T, label, pick, plural } from '../i18n'
import { formatTime } from '../state/derive'
import { EditText, IdeaActions, PositionEditor } from '../ui/IdeaActions'
import { ProposalCard } from '../ui/ProposalCard'
import { useLang, useOwner, useStore, useT } from '../state/store'
import { Empty, Page, Section } from '../ui/Page'
import { IdeaLink, StatusBadge, ideaTitle, levelName } from '../ui/bits'

export function IdeaPage({ state }: { state: State }) {
  const { id = '' } = useParams()
  const [idea, setIdea] = useState<IdeaDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const owner = useOwner()
  const lang = useLang()
  const t = useT()

  useEffect(() => {
    setIdea(null)
    setEditing(false)
  }, [id])

  useEffect(() => {
    let live = true
    setError(null)
    api.idea(id).then(
      (d) => live && setIdea(d),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [id, state])

  if (error) return <Page title={id}><div className="notice bad" role="alert">{error}</div></Page>
  if (!idea) return <Page title={id}><p className="muted">{t('正在读取…', 'Loading…')}</p></Page>

  const kernel = state.frame.kernels.find((k) => k.name === idea.kernel)
  // 英文界面下正文用英文（有的话），下面的折叠块放另一种语言。
  // In the English UI the main text is the English one (when there is one), and the
  // disclosure below holds the other language.
  const english = lang === 'en' && Boolean(idea.title_en)
  const other = english ? { title: idea.title, body: idea.body } : { title: idea.title_en ?? '', body: idea.body_en ?? '' }

  return (
    <Page
      title={`${idea.id} ${ideaTitle(lang, idea)}`}
      lead={kernel ? `${levelName(state, idea.level, lang)} · ${pick(lang, kernel.name, kernel.name_en)}` : levelName(state, idea.level, lang)}
    >
      <div className="meta-row">
        <StatusBadge idea={idea} />
        {idea.merged_into && (
          <span>
            {t('并入了', 'Merged into')} <IdeaLink id={idea.merged_into} state={state} />
          </span>
        )}
        {idea.reason && <span className="muted">{t('原因：', 'Reason: ')}{idea.reason}</span>}
        <span className="muted small">{t('创建于', 'Created')} {formatTime(idea.created_at)}</span>
        {(idea.versions ?? 1) > 1 && <span className="muted small">{t(`改写过 ${(idea.versions ?? 1) - 1} 次`, `Rewritten ${plural((idea.versions ?? 1) - 1, 'time')}`)}</span>}
      </div>

      <div className="two-col">
        <div>
          <Section title={t('正文', 'Body')} note={t('这段就是给 Claude 的输入', 'This text is the input for Claude')}>
            {editing ? <EditText idea={idea} onDone={() => setEditing(false)} /> : <Prompt text={english ? (idea.body_en ?? '').trim() || idea.prompt_text : idea.prompt_text} />}
            {!editing && (
              <details className="english">
                <summary>
                  {english ? t('中文原文', 'Chinese original') : t('英文版', 'English version')}
                  {!idea.title_en && t('（还没有翻译）', ' (not translated yet)')}
                  {idea.en_stale && t('（中文改过了，英文还是旧的）', ' (the Chinese has changed since; the English is out of date)')}
                </summary>
                {idea.title_en ? (
                  <div lang={english ? 'zh-CN' : 'en'}>
                    <h4>{other.title}</h4>
                    {other.body.split('\n').map((line, i) => (
                      <p key={i}>{line}</p>
                    ))}
                  </div>
                ) : (
                  <p className="muted small">{t('去"生成与候选"页的"整理"里翻译。', 'Translate it under "Tidy up" on the "Generate & candidates" page.')}</p>
                )}
              </details>
            )}
            {owner && !editing && <IdeaActions idea={idea} state={state} onEdit={() => setEditing(true)} />}
          </Section>

          {owner && <Refine idea={idea} state={state} />}

          <UseIt idea={idea} />

          <Section title={t('血缘', 'Lineage')} note={t('它从哪来，谁接着它', 'Where it came from and what follows it')}>
            <Lineage idea={idea} state={state} />
          </Section>

          <Section title={t('历史', 'History')} note={t(`${idea.history.length} 件事，最近的在前`, `${plural(idea.history.length, 'event')}, latest first`)}>
            <ol className="history">
              {idea.history.map((h, i) => (
                <HistoryRow key={i} item={h} />
              ))}
            </ol>
          </Section>
        </div>

        <aside>
          <Section title={t('位置', 'Position')}>
            <dl className="facts">
              <dt>{t('层', 'Level')}</dt>
              <dd>
                <Link to={`/ideas?level=${idea.level}`}>{levelName(state, idea.level, lang)}</Link>
              </dd>
            </dl>
            {owner && <PositionEditor idea={idea} state={state} />}
            {kernel && <p className="muted small kernel-desc">{pick(lang, kernel.desc, kernel.desc_en)}</p>}
          </Section>

          <ProjectsFor idea={idea} state={state} />

          <Section title={t('来历', 'Origin')}>
            <dl className="facts">
              <dt>{t('怎么来的', 'How it came in')}</dt>
              <dd>{idea.origin?.subject ?? label(lang, 'by', idea.origin?.how, state.labels.by?.[idea.origin?.how ?? ''] ?? idea.origin?.how)}</dd>
              {idea.origin?.pr != null && (
                <>
                  <dt>{t('合并请求', 'Pull request')}</dt>
                  <dd>
                    <a href={`https://github.com/twokidsCarl/world-sim/pull/${idea.origin.pr}`} target="_blank" rel="noreferrer">
                      #{idea.origin.pr}
                    </a>
                  </dd>
                </>
              )}
            </dl>
          </Section>
        </aside>
      </div>
    </Page>
  )
}

function Prompt({ text }: { text: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }
  return (
    <figure className="prompt">
      <blockquote>
        {text.split('\n').map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </blockquote>
      <figcaption>
        <button onClick={() => void copy()}>{copied ? t('已复制', 'Copied') : t('复制给 Claude', 'Copy for Claude')}</button>
        <span className="muted small">{t('贴到一个新的 Claude Code 会话里，它会从这段开始规划。', 'Paste it into a new Claude Code session; it will start planning from this text.')}</span>
      </figcaption>
    </figure>
  )
}

// 每种连线在上游、下游两边的说法：[中文, 英文]。
// How each kind of edge reads on the upstream and the downstream side: [Chinese, English].
const UP: Record<string, [string, string]> = {
  merged_into: ['并入了它的', 'Merged into this'], mentions: ['它提到的', 'Mentioned by this'], refined_from: ['细化自', 'Refined from'],
  fused_from: ['融合自', 'Fused from'], split_from: ['拆分自', 'Split from'], inspired_by: ['由它想到', 'Inspired by'],
}
const DOWN: Record<string, [string, string]> = {
  merged_into: ['它并入了', 'This merged into'], mentions: ['提到它的', 'Mentioning this'], refined_from: ['细化出的', 'Refined into'],
  fused_from: ['融合成了', 'Fused into'], split_from: ['拆分出的', 'Split into'], inspired_by: ['由它想到的', 'Inspired'],
}
const edgeLabel = (t: T, table: Record<string, [string, string]>, kind: string) => (table[kind] ? t(...table[kind]) : kind)

function Lineage({ idea, state }: { idea: IdeaDetail; state: State }) {
  const t = useT()
  const group = (edges: Edge[], pick: (e: Edge) => string) => {
    const out = new Map<string, string[]>()
    for (const e of edges) out.set(e.kind, [...(out.get(e.kind) ?? []), pick(e)])
    return [...out.entries()]
  }
  const up = group(idea.links_in, (e) => e.source)
  const down = group(idea.links_out, (e) => e.target)
  if (up.length === 0 && down.length === 0) return <Empty>{t('这条 idea 现在和别的没有连线。', 'This idea is not linked to any other yet.')}</Empty>
  return (
    <div className="lineage">
      <div className="lin-col">
        <div className="lin-label">{t('上游', 'Upstream')}</div>
        {up.length === 0 && <span className="muted small">{t('没有', 'None')}</span>}
        {up.map(([kind, ids]) => (
          <LinGroup key={kind} label={edgeLabel(t, UP, kind)} ids={ids} state={state} />
        ))}
      </div>
      <div className="lin-self" aria-hidden="true">
        <span className="arrow">→</span>
        <span className="self num">{idea.id}</span>
        <span className="arrow">→</span>
      </div>
      <div className="lin-col">
        <div className="lin-label">{t('下游', 'Downstream')}</div>
        {down.length === 0 && <span className="muted small">{t('没有', 'None')}</span>}
        {down.map(([kind, ids]) => (
          <LinGroup key={kind} label={edgeLabel(t, DOWN, kind)} ids={ids} state={state} />
        ))}
      </div>
    </div>
  )
}

function LinGroup({ label, ids, state }: { label: string; ids: string[]; state: State }) {
  return (
    <div className="lin-group">
      <div className="muted small">{label}</div>
      <ul className="plain">
        {ids.map((id) => (
          <li key={id}>
            <IdeaLink id={id} state={state} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function HistoryRow({ item }: { item: HistoryItem }) {
  const lang = useLang()
  const t = useT()
  const changed = item.event === 'edited' && item.before && item.after
  return (
    <li className={`hist hist-${item.event}`}>
      <div className="hist-head">
        <span className="badge">{label(lang, 'event', item.event, item.event_label)}</span>
        <span>{item.text}</span>
        <span className="muted small">
          {formatTime(item.at)} · {label(lang, 'by', item.by, item.by_label)}
          {item.pr != null && (
            <>
              {' · '}
              <a href={`https://github.com/twokidsCarl/world-sim/pull/${item.pr}`} target="_blank" rel="noreferrer">
                #{item.pr}
              </a>
            </>
          )}
        </span>
      </div>
      {changed && (
        <details>
          <summary>{t('看改写前后', 'Compare before and after')}</summary>
          <div className="diff">
            <div>
              <div className="muted small">{t('之前', 'Before')}</div>
              <h4>{item.before!.title}</h4>
              <p>{item.before!.body}</p>
            </div>
            <div>
              <div className="muted small">{t('之后', 'After')}</div>
              <h4>{item.after!.title}</h4>
              <p>{item.after!.body}</p>
            </div>
          </div>
        </details>
      )}
    </li>
  )
}

function Refine({ idea, state }: { idea: IdeaDetail; state: State }) {
  const { proposals, load } = useStore()
  const t = useT()
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mine = (proposals?.proposals ?? []).filter((p) => p.status === 'open' && (p.idea_id === idea.id || p.target === idea.id || p.sources.includes(idea.id)))
  const live = ['pool', 'building', 'built', 'draft'].includes(idea.status)
  if (!live && mine.length === 0) return null
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.refine(idea.id, hint)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }
  return (
    <Section title={t('细化', 'Refine')} note={t('让模型给几个改写的方向；接受之前这条 idea 不变', 'Have the model suggest a few rewrites; the idea stays as it is until you accept one')}>
      {live && (
        <div className="row refine">
          <input aria-label={t('想往哪个方向改', 'Which direction to take it')} value={hint} onChange={(e) => setHint(e.target.value)} placeholder={t('想往哪个方向改（可以不填）', 'Which direction to take it (optional)')} />
          <button disabled={busy || proposals?.model_ready === false} onClick={() => void run()}>
            {busy ? t('正在想，大约十几秒…', 'Thinking, about fifteen seconds…') : t('给我几个改写', 'Give me a few rewrites')}
          </button>
          <Link to={`/inbox?like=${encodeURIComponent(idea.id)}`} className="small">
            {t('从它出发生成新的', 'Generate new ones from it')}
          </Link>
        </div>
      )}
      {error && <p className="err" role="alert">{error}</p>}
      {mine.length > 0 && (
        <div className="proposals">
          {mine.map((p) => (
            <ProposalCard key={p.id} proposal={p} state={state} />
          ))}
        </div>
      )}
    </Section>
  )
}

// 这条 idea 对应的子项目、任务和进度。 / The subprojects, tasks and progress behind this idea.
function useWork(idea: IdeaDetail) {
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  useEffect(() => {
    let live = true
    void Promise.all([api.projects(), api.tasks()]).then(([p, t]) => {
      if (!live) return
      setProjects(p.filter((x) => idea.projects.includes(x.dir)))
      setTasks(t.filter((x) => x.idea_id === idea.id && x.status !== 'cancelled'))
    }, () => undefined)
    return () => {
      live = false
    }
  }, [idea.id, idea.projects.join(',')])
  return { projects, tasks }
}

function ProjectsFor({ idea, state }: { idea: IdeaDetail; state: State }) {
  const { projects, tasks } = useWork(idea)
  const lang = useLang()
  const t = useT()
  return (
    <Section title={t('项目与进度', 'Projects and progress')}>
      {projects.length === 0 && tasks.length === 0 && <Empty>{t('还没有子项目在做它。', 'No subproject is working on it yet.')}</Empty>}
      <ul className="plain">
        {tasks.map((task) => (
          <li key={task.task_id}>
            <span className="badge">{label(lang, 'taskStatus', task.status, task.status_label)}</span> {task.title}
            {task.pr != null && <span className="muted small"> #{task.pr}</span>}
          </li>
        ))}
        {projects.map((p) => (
          <li key={p.dir}>
            <Link to={`/ideas?project=${p.dir}`} className="chip project">{p.dir}</Link>{' '}
            <span className="muted small">
              {t(`${p.merged} 个 PR 已合并`, `${plural(p.merged, 'PR')} merged`)}
              {p.last_merged_at && t(`，最近 ${formatTime(p.last_merged_at)}`, `, latest ${formatTime(p.last_merged_at)}`)}
              {p.linked.includes(idea.id) ? '' : t(' · 正文里提到', ' · mentioned in the body')}
            </span>
          </li>
        ))}
      </ul>
      {['pool', 'building', 'built'].includes(idea.status) && (
        <p className="after-meta">
          <Link to={`/work?idea=${encodeURIComponent(idea.id)}`}>{t('交给一个子项目 →', 'Hand it to a subproject →')}</Link>
        </p>
      )}
      <span hidden>{state.counts.live}</span>
    </Section>
  )
}

function UseIt({ idea }: { idea: IdeaDetail }) {
  const t = useT()
  const lang = useLang()
  const [cards, setCards] = useState<CardView[]>([])
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setOpen(null)
    api.play().then((v) => live && setCards(v.cards.filter((c) => c.idea === idea.id || idea.projects.includes(c.sim))), () => undefined)
    return () => {
      live = false
    }
  }, [idea.id, idea.projects.join(',')])
  if (cards.length === 0) return null
  // 明确挂在这条 idea 上的卡排前面，其余是它提到的子项目的卡。
  // Cards attached to this idea come first; the rest belong to the subprojects it mentions.
  const mine = [...cards].sort((x, y) => Number(y.idea === idea.id) - Number(x.idea === idea.id)).slice(0, 12)
  const shown = mine.find((c) => c.key === open)
  return (
    <Section title={t('使用', 'Use it')} note={t('做出来的东西在这里直接玩，不用启动任何服务器', 'Play what was built right here; no server to start')}>
      <div className="row wrap card-picks">
        {mine.map((c) => (
          <button key={c.key} aria-pressed={open === c.key} onClick={() => setOpen(open === c.key ? null : c.key)} title={pick(lang, c.hint.zh, c.hint.en)}>
            <span className="muted small">{c.sim}</span> {pick(lang, c.title.zh, c.title.en)}
          </button>
        ))}
        {cards.length > mine.length && <span className="muted small">{t(`还有 ${cards.length - mine.length} 张`, `${cards.length - mine.length} more`)}</span>}
      </div>
      {shown && (
        <>
          <SimFrame card={shown} className="embed" />
          <p className="small">
            <Link to={`/play?card=${encodeURIComponent(shown.key)}`}>{t('在 play 页打开 →', 'Open on the play page →')}</Link>
          </p>
        </>
      )}
    </Section>
  )
}
