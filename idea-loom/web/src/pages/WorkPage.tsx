import { useEffect, useState } from 'react'
import { NowRunning } from '../ui/NowRunning'
import { Link, useSearchParams } from 'react-router'
import { type ProjectView, type Task, api } from '../api'
import type { State } from '../contract'
import { label, plural } from '../i18n'
import { formatTime } from '../state/derive'
import { useLang, useStore, useT } from '../state/store'
import { Empty, Page, Section } from '../ui/Page'
import { JobPanel } from '../ui/JobPanel'
import { IdeaLink, ideaTitle } from '../ui/bits'

// 看板的列：[中文, 英文, 归到这一列的状态]。 / The board columns: [Chinese, English, the statuses in the column].
const COLUMNS: [string, string, string[]][] = [
  ['待开工', 'To start', ['todo']],
  ['方案待批', 'Plan awaiting approval', ['planning', 'plan_ready']],
  ['进行中', 'In progress', ['running', 'failed']],
  ['已合并', 'Merged', ['merged']],
]
const STATUSES: [string, string, string][] = [['todo', '待开工', 'To start'], ['running', '进行中', 'In progress'], ['merged', '已合并', 'Merged'], ['cancelled', '取消', 'Cancelled']]

export function WorkPage({ state }: { state: State }) {
  const [params] = useSearchParams()
  const reloadState = useStore((s) => s.load)
  const lang = useLang()
  const t = useT()
  const [projects, setProjects] = useState<ProjectView[] | null>(null)
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ideaParam = params.get('idea') ?? ''
  const [draft, setDraft] = useState({ idea_id: ideaParam, project: '', title: '', brief: '' })
  const [busy, setBusy] = useState(false)
  const [openJob, setOpenJob] = useState<string | null>(params.get('job'))
  const [advancing, setAdvancing] = useState<string | null>(null)
  // 连续推进由云端的 worker 来做，本地没有。 / Chains are run by the worker in the cloud; there is none locally.
  const cloud = useStore((s) => s.me?.auth_enabled === true)
  // 开工失败的原因就近显示在那张卡上，不只在页面顶部；点了之后在回应前不能再点。
  // A failed start is shown on its own card, not only at the top of the page; the button is off until the answer comes.
  const [starting, setStarting] = useState<string | null>(null)
  const [startErrors, setStartErrors] = useState<Record<string, string>>({})
  const start = (task: Task) => {
    setStarting(task.task_id)
    setStartErrors((m) => ({ ...m, [task.task_id]: '' }))
    void api.startJob('task', task.task_id).then(
      (j) => (setStarting(null), setOpenJob(j.job_id), void load()),
      (e: Error) => (setStarting(null), setStartErrors((m) => ({ ...m, [task.task_id]: e.message }))),
    )
  }
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
  const shown = (tasks ?? []).filter((x) => x.status !== 'cancelled')
  // 子项目的一句话介绍：英文版在全局状态的项目表里。
  // A subproject's tagline: the English one is in the project list of the global state.
  const tagline = (dir: string, zh: string) => (lang === 'en' && state.projects.find((x) => x.dir === dir)?.tagline_en) || zh

  return (
    <Page
      title={t('开发', 'Work')}
      lead={t(
        '把一条 idea 交给一个子项目去做，看它走到哪一步。每个子项目的进度来自它在 GitHub 上的合并请求。',
        'Hand an idea to a subproject and see how far it has got. The progress of each subproject comes from its pull requests on GitHub.',
      )}
      actions={
        // 「接入」不占菜单了，从这里进。 / "Connect" is no longer in the menu; this is the way in.
        <Link className="button inline" to="/connect">
          {t('接入外面的 Agent', 'Connect outside agents')}
        </Link>
      }
    >
      {error && <div className="notice bad" role="alert">{error}</div>}
      <NowRunning onOpen={setOpenJob} />

      <Section
        title={t('任务', 'Tasks')}
        note={t(
          '点「开工」让 Claude Code 先出方案，你批准之后它才动手；也可以自己开会话做，再手动改状态',
          'Click "Start" and Claude Code writes a plan first; it only acts after you approve. You can also do it in a session of your own and set the status by hand',
        )}
      >
        <div className="board">
          {COLUMNS.map(([zh, en, statuses]) => {
            const mine = shown.filter((x) => statuses.includes(x.status))
            return (
              <div key={zh} className="board-col" aria-label={t(zh, en)}>
                <h3>
                  {t(zh, en)} <span className="num">{mine.length}</span>
                </h3>
                {mine.map((task) => (
                  <div key={task.task_id} className="task">
                    <div className="task-title">{task.title}</div>
                    <div className="small">
                      <Link to={`/ideas?project=${task.project}`} className="chip project">{task.project}</Link>{' '}
                      {task.idea_id && <IdeaLink id={task.idea_id} state={state} />}
                    </div>
                    {task.brief && <div className="muted small pre">{task.brief}</div>}
                    {task.pr != null && (
                      <div className="small">
                        {task.pr_url ? (
                          <a href={task.pr_url} target="_blank" rel="noreferrer">{t(`合并请求 #${task.pr}`, `Pull request #${task.pr}`)}</a>
                        ) : (
                          t(`合并请求 #${task.pr}`, `Pull request #${task.pr}`)
                        )}
                      </div>
                    )}
                    {task.status === 'failed' && <div className="err small">{t('失败：', 'Failed: ')}{task.notes[0]?.text}</div>}
                    <div className="row">
                      {(task.status === 'todo' || task.status === 'failed') && (
                        <button className="primary" disabled={starting === task.task_id} onClick={() => start(task)}>
                          {starting === task.task_id ? t('正在启动…', 'Starting…') : t('开工', 'Start')}
                        </button>
                      )}
                      {task.job_id && ['planning', 'plan_ready', 'running'].includes(task.status) && (
                        <span className="muted small">{t('已有作业在进行，点「看作业」。', 'A job is already under way; click "Show job".')}</span>
                      )}
                      {task.job_id && (
                        <button aria-expanded={openJob === task.job_id} onClick={() => setOpenJob(openJob === task.job_id ? null : task.job_id)}>
                          {openJob === task.job_id ? t('收起作业', 'Hide job') : t('看作业', 'Show job')}
                        </button>
                      )}
                    </div>
                    {startErrors[task.task_id] && <div className="err small" role="alert">{startErrors[task.task_id]}</div>}
                    <div className="row">
                      <select aria-label={t('状态', 'Status')} value={task.status} onChange={(e) => move(task, e.target.value)}>
                        {!STATUSES.some(([s]) => s === task.status) && <option value={task.status}>{label(lang, 'taskStatus', task.status, task.status_label)}</option>}
                        {STATUSES.map(([s, zh, en]) => (
                          <option key={s} value={s}>{t(zh, en)}</option>
                        ))}
                      </select>
                      <span className="muted small">{formatTime(task.updated_at)}</span>
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
        {tasks && shown.length === 0 && <Empty>{t('还没有任务。在下面建一个，或者去某条 idea 的页面点"交给一个子项目"。', 'No tasks yet. Create one below, or click "Hand it to a subproject" on the page of an idea.')}</Empty>}
      </Section>

      <Section title={t('新建任务', 'New task')}>
        <form
          className="form wide"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <div className="row wrap">
            <label>
              {t('哪一条 idea', 'Which idea')}
              <select value={draft.idea_id} onChange={(e) => setDraft({ ...draft, idea_id: e.target.value })}>
                <option value="">{t('不对应某一条', 'No particular one')}</option>
                {state.ideas.filter((i) => ['pool', 'building', 'built'].includes(i.status)).map((i) => (
                  <option key={i.id} value={i.id}>{i.id} {ideaTitle(lang, i)}</option>
                ))}
              </select>
            </label>
            <label>
              {t('交给哪个子项目（目录名；写一个新名字就是开新项目）', 'Which subproject (directory name; a new name starts a new project)')}
              <input list="project-dirs" value={draft.project} onChange={(e) => setDraft({ ...draft, project: e.target.value })} placeholder={idea?.projects[0] ?? t('比如 sandpile', 'For example sandpile')} />
              <datalist id="project-dirs">
                {(projects ?? []).map((p) => (
                  <option key={p.dir} value={p.dir} />
                ))}
              </datalist>
            </label>
          </div>
          <label>
            {t('做什么（一句话）', 'What to do (one sentence)')}
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder={idea ? t(`${idea.title}的第一版`, `A first version of ${ideaTitle(lang, idea)}`) : ''} />
          </label>
          <label>
            {t('补充说明（可以不填）', 'More detail (optional)')}
            <textarea rows={3} value={draft.brief} onChange={(e) => setDraft({ ...draft, brief: e.target.value })} />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !draft.title.trim() || !draft.project.trim()}>
              {t('建任务', 'Create task')}
            </button>
            {idea && idea.status === 'pool' && <span className="muted small">{t(`建了之后，${idea.id} 的状态会变成"开发中"。`, `Once created, the status of ${idea.id} becomes "Building".`)}</span>}
          </div>
        </form>
      </Section>

      <Section title={t('子项目', 'Subprojects')} note={t('进度读自 GitHub，按 PR 标题冒号前的项目名归类，缓存一分钟', 'Progress is read from GitHub, grouped by the project name before the colon in the PR title, and cached for a minute')}>
        {!projects ? (
          <p className="muted">{t('正在读取…', 'Loading…')}</p>
        ) : (
          <div className="projects">
            {projects.map((p) => (
              <article key={p.dir} className="project-card">
                <div className="project-head">
                  <h3>{p.dir}</h3>
                  <span className="muted small">{p.level ?? ''} {tagline(p.dir, p.tagline)}</span>
                  <span className="n num" title={t('合并了的 PR', 'Merged PRs')}>{p.merged}</span>
                </div>
                <div className="muted small">
                  {t(`${p.merged} 个 PR 已合并`, `${plural(p.merged, 'PR')} merged`)}
                  {p.prs > p.merged && t(`，${p.prs - p.merged} 个还开着`, `, ${p.prs - p.merged} still open`)}
                  {p.last_merged_at && t(` · 最近一次 ${formatTime(p.last_merged_at)}`, ` · latest ${formatTime(p.last_merged_at)}`)}
                  {!p.has_readme && t(' · 目录里还没有 README', ' · no README in the directory yet')}
                </div>
                <div className="small">
                  {p.ui_url &&
                    (p.ui_up ? (
                      <a href={p.ui_url} target="_blank" rel="noreferrer">{t('打开它的界面 ↗', 'Open its UI ↗')}</a>
                    ) : (
                      <span className="muted">{t('还在构建，或者构建失败了（去「无尽探索」页看）', 'Still building, or the build failed (see the Explore page)')}</span>
                    ))}
                </div>
                <div className="row">
                  <button disabled={advancing !== null} onClick={() => advance(p.dir)} title={t('让模型读它的 README 和最近的 PR，提议下一个里程碑，建成一个待开工的任务', 'The model reads its README and recent PRs, proposes the next milestone and creates a task ready to start')}>
                    {advancing === p.dir ? t('正在想下一步…', 'Thinking about the next step…') : t('推进：提议下一步', 'Advance: propose the next step')}
                  </button>
                  {cloud && (
                    <button
                      title={t('事先批准接下来最多三步：每一步仍然出方案、跑测试、走 PR，只是方案不再等你批。哪一步没做成就停下并通知你。', 'Approve up to three more steps in advance: each still plans, runs the tests and goes through a PR, only the plan no longer waits for you. A step that fails stops the chain and notifies you.')}
                      onClick={() => void api.chain(p.dir, 3).then(() => setError(null), (e: Error) => setError(e.message))}
                    >
                      {t('连续推进三步', 'Run three steps')}
                    </button>
                  )}
                </div>
                {p.ideas.length > 0 && (
                  <div className="small">
                    {t('相关的 idea：', 'Related ideas:')}
                    {p.ideas.slice(0, 8).map((id) => (
                      <span key={id}> <IdeaLink id={id} state={state} showTitle={false} /></span>
                    ))}
                    {p.ideas.length > 8 && <Link to={`/ideas?project=${p.dir}`}>{t(` 等 ${p.ideas.length} 条`, ` and more, ${p.ideas.length} in all`)}</Link>}
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
