import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { type ProjectView, type Task, api } from '../api'
import type { State } from '../contract'
import { formatTime } from '../state/derive'
import { useStore } from '../state/store'
import { Empty, Page, Section } from '../ui/Page'
import { JobPanel } from '../ui/JobPanel'
import { IdeaLink } from '../ui/bits'

const COLUMNS: [string, string[]][] = [
  ['待开工', ['todo']],
  ['方案待批', ['planning', 'plan_ready']],
  ['进行中', ['running', 'failed']],
  ['已合并', ['merged']],
]
const STATUSES: [string, string][] = [['todo', '待开工'], ['running', '进行中'], ['merged', '已合并'], ['cancelled', '取消']]

export function WorkPage({ state }: { state: State }) {
  const [params] = useSearchParams()
  const reloadState = useStore((s) => s.load)
  const [projects, setProjects] = useState<ProjectView[] | null>(null)
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ideaParam = params.get('idea') ?? ''
  const [draft, setDraft] = useState({ idea_id: ideaParam, project: '', title: '', brief: '' })
  const [busy, setBusy] = useState(false)
  const [openJob, setOpenJob] = useState<string | null>(params.get('job'))
  const [advancing, setAdvancing] = useState<string | null>(null)
  const start = (task: Task) =>
    void api.startJob('task', task.task_id).then((j) => (setOpenJob(j.job_id), void load()), (e: Error) => setError(e.message))
  const advance = (dir: string) => {
    setAdvancing(dir)
    void api.advance(dir).then(() => (setAdvancing(null), void load(), void reloadState()), (e: Error) => (setAdvancing(null), setError(e.message)))
  }

  const load = () =>
    Promise.all([api.projects(), api.tasks()]).then(
      ([p, t]) => (setProjects(p), setTasks(t), setError(null)),
      (e: Error) => setError(e.message),
    )
  useEffect(() => void load(), [])

  const idea = state.ideas.find((i) => i.id === draft.idea_id)
  const create = async () => {
    setBusy(true)
    try {
      await api.createTask({ ...draft, idea_id: draft.idea_id || null })
      setDraft({ idea_id: '', project: '', title: '', brief: '' })
      await Promise.all([load(), reloadState()])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }
  const move = (task: Task, status: string) => void api.taskStatus(task.task_id, status).then(load, (e: Error) => setError(e.message))
  const shown = (tasks ?? []).filter((t) => t.status !== 'cancelled')

  return (
    <Page title="开发" lead="把一条 idea 交给一个子项目去做，看它走到哪一步。每个子项目的进度来自它在 GitHub 上的合并请求。">
      {error && <div className="notice bad" role="alert">{error}</div>}

      <Section title="任务" note="点「开工」让 Claude Code 先出方案，你批准之后它才动手；也可以自己开会话做，再手动改状态">
        <div className="board">
          {COLUMNS.map(([label, statuses]) => {
            const mine = shown.filter((t) => statuses.includes(t.status))
            return (
              <div key={label} className="board-col" aria-label={label}>
                <h3>
                  {label} <span className="num">{mine.length}</span>
                </h3>
                {mine.map((t) => (
                  <div key={t.task_id} className="task">
                    <div className="task-title">{t.title}</div>
                    <div className="small">
                      <Link to={`/ideas?project=${t.project}`} className="chip project">{t.project}</Link>{' '}
                      {t.idea_id && <IdeaLink id={t.idea_id} state={state} />}
                    </div>
                    {t.brief && <div className="muted small pre">{t.brief}</div>}
                    {t.pr != null && (
                      <div className="small">
                        {t.pr_url ? <a href={t.pr_url} target="_blank" rel="noreferrer">合并请求 #{t.pr}</a> : `合并请求 #${t.pr}`}
                      </div>
                    )}
                    {t.status === 'failed' && <div className="err small">失败：{t.notes[0]?.text}</div>}
                    <div className="row">
                      {(t.status === 'todo' || t.status === 'failed') && (
                        <button className="primary" onClick={() => start(t)}>
                          开工
                        </button>
                      )}
                      {t.job_id && (
                        <button aria-expanded={openJob === t.job_id} onClick={() => setOpenJob(openJob === t.job_id ? null : t.job_id)}>
                          {openJob === t.job_id ? '收起作业' : '看作业'}
                        </button>
                      )}
                    </div>
                    <div className="row">
                      <select aria-label="状态" value={t.status} onChange={(e) => move(t, e.target.value)}>
                        {!STATUSES.some(([s]) => s === t.status) && <option value={t.status}>{t.status_label}</option>}
                        {STATUSES.map(([s, l]) => (
                          <option key={s} value={s}>{l}</option>
                        ))}
                      </select>
                      <span className="muted small">{formatTime(t.updated_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
        {openJob && (
          <div className="job-wrap">
            <JobPanel jobId={openJob} onChange={() => void load()} />
          </div>
        )}
        {tasks && shown.length === 0 && <Empty>还没有任务。在下面建一个，或者去某条 idea 的页面点"交给一个子项目"。</Empty>}
      </Section>

      <Section title="新建任务">
        <form
          className="form wide"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <div className="row wrap">
            <label>
              哪一条 idea
              <select value={draft.idea_id} onChange={(e) => setDraft({ ...draft, idea_id: e.target.value })}>
                <option value="">不对应某一条</option>
                {state.ideas.filter((i) => ['pool', 'building', 'built'].includes(i.status)).map((i) => (
                  <option key={i.id} value={i.id}>{i.id} {i.title}</option>
                ))}
              </select>
            </label>
            <label>
              交给哪个子项目（目录名；写一个新名字就是开新项目）
              <input list="project-dirs" value={draft.project} onChange={(e) => setDraft({ ...draft, project: e.target.value })} placeholder={idea?.projects[0] ?? '比如 sandpile'} />
              <datalist id="project-dirs">
                {(projects ?? []).map((p) => (
                  <option key={p.dir} value={p.dir} />
                ))}
              </datalist>
            </label>
          </div>
          <label>
            做什么（一句话）
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder={idea ? `${idea.title}的第一版` : ''} />
          </label>
          <label>
            补充说明（可以不填）
            <textarea rows={3} value={draft.brief} onChange={(e) => setDraft({ ...draft, brief: e.target.value })} />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !draft.title.trim() || !draft.project.trim()}>
              建任务
            </button>
            {idea && idea.status === 'pool' && <span className="muted small">建了之后，{idea.id} 的状态会变成"开发中"。</span>}
          </div>
        </form>
      </Section>

      <Section title="子项目" note="进度读自 GitHub，按 PR 标题冒号前的项目名归类，缓存一分钟">
        {!projects ? (
          <p className="muted">正在读取…</p>
        ) : (
          <div className="projects">
            {projects.map((p) => (
              <article key={p.dir} className="project-card">
                <div className="project-head">
                  <h3>{p.dir}</h3>
                  <span className="muted small">{p.level ?? ''} {p.tagline}</span>
                  <span className="n num" title="合并了的 PR">{p.merged}</span>
                </div>
                <div className="muted small">
                  {p.merged} 个 PR 已合并{p.prs > p.merged && `，${p.prs - p.merged} 个还开着`}
                  {p.last_merged_at && ` · 最近一次 ${formatTime(p.last_merged_at)}`}
                  {!p.has_readme && ' · 目录里还没有 README'}
                </div>
                <div className="small">
                  {p.ui_url &&
                    (p.ui_up ? (
                      <a href={p.ui_url} target="_blank" rel="noreferrer">打开它的界面 ↗</a>
                    ) : (
                      <span className="muted">它的开发服务没在跑（{p.ui_url.replace('http://', '')}）</span>
                    ))}
                </div>
                <div className="row">
                  <button disabled={advancing !== null} onClick={() => advance(p.dir)} title="让模型读它的 README 和最近的 PR，提议下一个里程碑，建成一个待开工的任务">
                    {advancing === p.dir ? '正在想下一步…' : '推进：提议下一步'}
                  </button>
                </div>
                {p.ideas.length > 0 && (
                  <div className="small">
                    相关的 idea：
                    {p.ideas.slice(0, 8).map((id) => (
                      <span key={id}> <IdeaLink id={id} state={state} showTitle={false} /></span>
                    ))}
                    {p.ideas.length > 8 && <Link to={`/ideas?project=${p.dir}`}> 等 {p.ideas.length} 条</Link>}
                  </div>
                )}
                {p.recent.length > 0 && (
                  <ul className="plain pr-list">
                    {p.recent.slice(0, 5).map((pr) => (
                      <li key={pr.number}>
                        <a href={pr.url} target="_blank" rel="noreferrer" className="num">#{pr.number}</a>
                        <span className="t" title={pr.title}>{pr.title.replace(/^[^:：]+[:：]\s*/, '')}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </div>
        )}
      </Section>
    </Page>
  )
}
