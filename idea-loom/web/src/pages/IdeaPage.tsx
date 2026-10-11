import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { type ProjectView, type Task, api } from '../api'
import type { HistoryItem, IdeaDetail, Link as Edge, State } from '../contract'
import { formatTime } from '../state/derive'
import { EditText, IdeaActions, PositionEditor } from '../ui/IdeaActions'
import { ProposalCard } from '../ui/ProposalCard'
import { useStore } from '../state/store'
import { Empty, Page, Section } from '../ui/Page'
import { IdeaLink, StatusBadge, ThreadChips, levelName } from '../ui/bits'

export function IdeaPage({ state }: { state: State }) {
  const { id = '' } = useParams()
  const [idea, setIdea] = useState<IdeaDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

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
  if (!idea) return <Page title={id}><p className="muted">正在读取…</p></Page>

  const kernel = state.frame.kernels.find((k) => k.name === idea.kernel)
  const projects = state.projects.filter((p) => (idea.projects ?? []).includes(p.dir))

  return (
    <Page title={`${idea.id} ${idea.title}`} lead={kernel ? `${levelName(state, idea.level)} · ${kernel.name}` : levelName(state, idea.level)}>
      <div className="meta-row">
        <StatusBadge idea={idea} />
        {idea.merged_into && (
          <span>
            并入了 <IdeaLink id={idea.merged_into} state={state} />
          </span>
        )}
        {idea.reason && <span className="muted">原因：{idea.reason}</span>}
        <span className="muted small">创建于 {formatTime(idea.created_at)}</span>
        {(idea.versions ?? 1) > 1 && <span className="muted small">改写过 {(idea.versions ?? 1) - 1} 次</span>}
      </div>

      <div className="two-col">
        <div>
          <Section title="正文" note="这段就是给 Claude 的输入">
            {editing ? <EditText idea={idea} onDone={() => setEditing(false)} /> : <Prompt text={idea.prompt_text} />}
            {!editing && (
              <details className="english">
                <summary>
                  英文版{!idea.title_en && '（还没有翻译）'}
                  {idea.en_stale && '（中文改过了，英文还是旧的）'}
                </summary>
                {idea.title_en ? (
                  <div lang="en">
                    <h4>{idea.title_en}</h4>
                    {(idea.body_en ?? '').split('\n').map((line, i) => (
                      <p key={i}>{line}</p>
                    ))}
                  </div>
                ) : (
                  <p className="muted small">去"生成与候选"页的"整理"里翻译。</p>
                )}
              </details>
            )}
            {!editing && <IdeaActions idea={idea} state={state} onEdit={() => setEditing(true)} />}
          </Section>

          <Refine idea={idea} state={state} />

          <UseIt idea={idea} />

          <Section title="血缘" note="它从哪来，谁接着它">
            <Lineage idea={idea} state={state} />
          </Section>

          <Section title="历史" note={`${idea.history.length} 件事，最近的在前`}>
            <ol className="history">
              {idea.history.map((h, i) => (
                <HistoryRow key={i} item={h} />
              ))}
            </ol>
          </Section>
        </div>

        <aside>
          <Section title="位置">
            <dl className="facts">
              <dt>层</dt>
              <dd>
                <Link to={`/ideas?level=${idea.level}`}>{levelName(state, idea.level)}</Link>
              </dd>
            </dl>
            <PositionEditor idea={idea} state={state} />
            {kernel && <p className="muted small kernel-desc">{kernel.desc}</p>}
          </Section>

          <ProjectsFor idea={idea} state={state} />

          <Section title="来历">
            <dl className="facts">
              <dt>怎么来的</dt>
              <dd>{idea.origin?.subject ?? state.labels.by?.[idea.origin?.how ?? ''] ?? idea.origin?.how}</dd>
              {idea.origin?.pr != null && (
                <>
                  <dt>合并请求</dt>
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
        <button onClick={() => void copy()}>{copied ? '已复制' : '复制给 Claude'}</button>
        <span className="muted small">贴到一个新的 Claude Code 会话里，它会从这段开始规划。</span>
      </figcaption>
    </figure>
  )
}

const UP: Record<string, string> = { merged_into: '并入了它的', mentions: '它提到的', refined_from: '细化自', fused_from: '融合自', split_from: '拆分自', inspired_by: '由它想到' }
const DOWN: Record<string, string> = { merged_into: '它并入了', mentions: '提到它的', refined_from: '细化出的', fused_from: '融合成了', split_from: '拆分出的', inspired_by: '由它想到的' }

function Lineage({ idea, state }: { idea: IdeaDetail; state: State }) {
  const group = (edges: Edge[], pick: (e: Edge) => string) => {
    const out = new Map<string, string[]>()
    for (const e of edges) out.set(e.kind, [...(out.get(e.kind) ?? []), pick(e)])
    return [...out.entries()]
  }
  const up = group(idea.links_in, (e) => e.source)
  const down = group(idea.links_out, (e) => e.target)
  if (up.length === 0 && down.length === 0) return <Empty>这条 idea 现在和别的没有连线。</Empty>
  return (
    <div className="lineage">
      <div className="lin-col">
        <div className="lin-label">上游</div>
        {up.length === 0 && <span className="muted small">没有</span>}
        {up.map(([kind, ids]) => (
          <LinGroup key={kind} label={UP[kind] ?? kind} ids={ids} state={state} />
        ))}
      </div>
      <div className="lin-self" aria-hidden="true">
        <span className="arrow">→</span>
        <span className="self num">{idea.id}</span>
        <span className="arrow">→</span>
      </div>
      <div className="lin-col">
        <div className="lin-label">下游</div>
        {down.length === 0 && <span className="muted small">没有</span>}
        {down.map(([kind, ids]) => (
          <LinGroup key={kind} label={DOWN[kind] ?? kind} ids={ids} state={state} />
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
  const changed = item.event === 'edited' && item.before && item.after
  return (
    <li className={`hist hist-${item.event}`}>
      <div className="hist-head">
        <span className="badge">{item.event_label}</span>
        <span>{item.text}</span>
        <span className="muted small">
          {formatTime(item.at)} · {item.by_label}
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
          <summary>看改写前后</summary>
          <div className="diff">
            <div>
              <div className="muted small">之前</div>
              <h4>{item.before!.title}</h4>
              <p>{item.before!.body}</p>
            </div>
            <div>
              <div className="muted small">之后</div>
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
    <Section title="细化" note="让模型给几个改写的方向；接受之前这条 idea 不变">
      {live && (
        <div className="row refine">
          <input aria-label="想往哪个方向改" value={hint} onChange={(e) => setHint(e.target.value)} placeholder="想往哪个方向改（可以不填）" />
          <button disabled={busy || proposals?.model_ready === false} onClick={() => void run()}>
            {busy ? '正在想，大约十几秒…' : '给我几个改写'}
          </button>
          <Link to={`/inbox?like=${encodeURIComponent(idea.id)}`} className="small">
            从它出发生成新的
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
  return (
    <Section title="项目与进度">
      {projects.length === 0 && tasks.length === 0 && <Empty>还没有子项目在做它。</Empty>}
      <ul className="plain">
        {tasks.map((t) => (
          <li key={t.task_id}>
            <span className="badge">{t.status_label}</span> {t.title}
            {t.pr != null && <span className="muted small"> #{t.pr}</span>}
          </li>
        ))}
        {projects.map((p) => (
          <li key={p.dir}>
            <Link to={`/ideas?project=${p.dir}`} className="chip project">{p.dir}</Link>{' '}
            <span className="muted small">
              {p.merged} 个 PR 已合并{p.last_merged_at && `，最近 ${formatTime(p.last_merged_at)}`}
              {p.linked.includes(idea.id) ? '' : ' · 正文里提到'}
            </span>
          </li>
        ))}
      </ul>
      {['pool', 'building', 'built'].includes(idea.status) && (
        <p className="after-meta">
          <Link to={`/work?idea=${encodeURIComponent(idea.id)}`}>交给一个子项目 →</Link>
        </p>
      )}
      <span hidden>{state.counts.live}</span>
    </Section>
  )
}

function UseIt({ idea }: { idea: IdeaDetail }) {
  const { projects } = useWork(idea)
  const [open, setOpen] = useState<string | null>(null)
  const usable = projects.filter((p) => p.ui_url)
  if (usable.length === 0) return null
  const shown = usable.find((p) => p.dir === open)
  return (
    <Section title="使用" note="做出来的东西在这里直接用">
      <div className="row wrap">
        {usable.map((p) =>
          p.ui_up ? (
            <button key={p.dir} aria-pressed={open === p.dir} onClick={() => setOpen(open === p.dir ? null : p.dir)}>
              {open === p.dir ? `收起 ${p.dir}` : `在这里打开 ${p.dir}`}
            </button>
          ) : (
            <span key={p.dir} className="muted small">
              {p.dir} 的开发服务没在跑（{p.ui_url!.replace('http://', '')}）。在它的目录里启动之后刷新这一页。
            </span>
          ),
        )}
        {shown && (
          <a href={shown.ui_url!} target="_blank" rel="noreferrer" className="small">
            在新窗口打开 ↗
          </a>
        )}
      </div>
      {shown && <iframe className="embed" src={shown.ui_url!} title={`${shown.dir} 的界面`} />}
    </Section>
  )
}
