import { useEffect, useRef, useState } from 'react'
import { type Job, type JobEvent, api } from '../api'
import { Markdown } from '../assistant/Markdown'
import { label, plural } from '../i18n'
import { formatTime } from '../state/derive'
import { useLang, useT } from '../state/store'
import { RestartNotice } from './RestartNotice'
import { usageLine, usageTitle } from './viz'

const ACTIVE = ['planning', 'running', 'testing', 'pr']
const TONE: Record<string, string> = { plan_ready: 'w-accepted', merged: 'w-done', failed: 'j-failed' }

// 一个作业：看它走到哪一步，读方案，批准、提意见或标为不做；失败了可以还原。
// One job: see where it is, read the plan, approve, send feedback or decline; a failed job can be reverted.
export function JobPanel({ jobId, onChange }: { jobId: string; onChange?: () => void }) {
  const [job, setJob] = useState<Job | null>(null)
  const [events, setEvents] = useState<JobEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [mode, setMode] = useState<'revise' | 'decline' | null>(null)
  const [busy, setBusy] = useState(false)
  const lang = useLang()
  const t = useT()
  const last = useRef(0)
  const phase = useRef('')

  useEffect(() => {
    let live = true
    last.current = 0
    setEvents([])
    const tick = async () => {
      try {
        const view = await api.job(jobId, last.current)
        if (!live) return
        if (view.events.length) {
          last.current = view.events[view.events.length - 1]!.seq
          setEvents((old) => [...old, ...view.events])
        }
        if (view.job.phase !== phase.current) {
          if (phase.current) onChange?.()
          phase.current = view.job.phase
        }
        setJob(view.job)
        setError(null)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e))
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 1500)
    return () => {
      live = false
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setMode(null)
      setFeedback('')
      onChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  if (!job) return <p className="muted small">{error ?? t('正在读取作业…', 'Loading the job…')}</p>
  const active = ACTIVE.includes(job.phase)
  const steps = events.filter((e) => e.type === 'step' && e.state === 'running')
  const notes = events.filter((e) => e.type === 'note')
  // 作业的小结有中英两份；英文界面优先用英文的。
  // The job summary comes in both languages; the English UI prefers the English one.
  const pickSummary = (key: string) => (typeof job.summary[key] === 'string' ? (job.summary[key] as string) : '')
  const summary = (lang === 'en' && pickSummary('summary_en')) || pickSummary('summary_zh')

  return (
    <div className="job">
      <div className="job-head">
        <span className={`badge ${TONE[job.phase] ?? ''}`}>
          {active && <span className="spin" aria-hidden="true">◌</span>} {job.queued ? t('排队中', 'Queued') : label(lang, 'phase', job.phase, job.phase_label)}
        </span>
        <span className="muted small">
          {t('在', 'In')} <code>{job.directory}/</code> · {t('开始于', 'started')} {formatTime(job.created_at)}
          {usageLine(job.tokens, lang) && <span className="num" title={usageTitle(job.tokens, lang)}> · {usageLine(job.tokens, lang)}</span>}
        </span>
        {active && (
          <button disabled={busy} onClick={() => void act(() => api.jobAction(job.job_id, 'cancel'))}>
            {t('取消', 'Cancel')}
          </button>
        )}
      </div>

      {active && (
        <p className="muted small" role="status">
          {job.phase === 'planning' && t('Claude 正在读代码、写方案。这一步它只读不写。', 'Claude is reading the code and writing a plan. In this step it only reads and writes nothing.')}
          {job.phase === 'running' && t(`Claude 正在按方案动手，只能改 ${job.directory}/ 下面的文件。`, `Claude is carrying out the plan and may only change files under ${job.directory}/.`)}
          {job.phase === 'testing' && t('它做完了，现在由程序自己把测试再跑一遍。', 'It has finished; the program is now running the tests again by itself.')}
          {job.phase === 'pr' && t('测试通过，正在开 PR 并等它自动合并。', 'The tests passed; opening a PR and waiting for it to merge automatically.')}
          {steps.length > 0 && t(` 已经读、改了 ${steps.length} 处，最近：${steps[steps.length - 1]!.label}`, ` ${plural(steps.length, 'read or edit')} so far, latest: ${steps[steps.length - 1]!.label}`)}
        </p>
      )}

      {/* 交给 Claude 的原文，批准之前可以对照着看；访客提的愿望尤其要看。 / The exact brief handed to Claude, to check against before approving, above all for a visitor's wish. */}
      <details className="small">
        <summary>{t('交给 Claude 的原文', 'The brief handed to Claude')}</summary>
        <pre className="job-pre">{job.what}</pre>
      </details>
      {job.error && <div className="notice bad pre" role="alert">{job.error}</div>}
      {job.queued && job.waiting && <div className="notice warn" role="status">{t(`还没轮到：${job.waiting}`, `Not started yet: ${job.waiting}`)}</div>}
      {job.phase === 'merged' && (
        <div className="notice good" role="status">
          {t('已合并', 'Merged')}{job.pr_url && <>{t('：', ': ')}<a href={job.pr_url} target="_blank" rel="noreferrer">{t(`合并请求 #${job.pr}`, `pull request #${job.pr}`)}</a></>}{t('。', '.')}
          {summary && ` ${summary}`}
        </div>
      )}
      {/* 这个作业改了后端的代码：后端还没换上新代码时说明并给重启的按钮。 / This job changed backend code: while the backend has not picked it up, say so and offer the restart button. */}
      {job.phase === 'merged' && job.restart_needed && <RestartNotice />}

      {job.plan && (
        <details open={job.phase === 'plan_ready'} className="job-plan">
          <summary>{t('方案', 'Plan')}{job.feedback.length > 0 && t(`（按你的意见改过 ${job.feedback.length} 次）`, ` (revised ${plural(job.feedback.length, 'time')} after your feedback)`)}</summary>
          <Markdown text={job.plan} />
        </details>
      )}

      {job.phase === 'plan_ready' && (
        <div className="job-actions">
          {mode === null ? (
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => void act(() => api.jobAction(job.job_id, 'approve'))}>
                {t('批准，开始动手', 'Approve and start')}
              </button>
              <button onClick={() => setMode('revise')}>{t('提意见，重写方案', 'Give feedback, rewrite the plan')}</button>
              <button onClick={() => setMode('decline')}>{t('不做', 'Decline')}</button>
            </div>
          ) : (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault()
                void act(() => api.jobText(job.job_id, mode, feedback))
              }}
            >
              <label>
                {mode === 'revise' ? t('你的意见', 'Your feedback') : t('为什么不做（可以不填）', 'Why decline (optional)')}
                <textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
              </label>
              <div className="row">
                <button type="submit" className="primary" disabled={busy || (mode === 'revise' && !feedback.trim())}>
                  {mode === 'revise' ? t('让它重写', 'Have it rewrite') : t('标为不做', 'Mark as declined')}
                </button>
                <button type="button" onClick={() => setMode(null)}>
                  {t('取消', 'Cancel')}
                </button>
              </div>
            </form>
          )}
          <p className="muted small">{t('批准之前它不会改任何文件。批准之后：它动手 → 程序重跑测试 → 开 PR → 自动合并。', 'It changes no file before you approve. After approval: it does the work → the program reruns the tests → opens a PR → merges automatically.')}</p>
        </div>
      )}

      {(job.phase === 'failed' || job.phase === 'cancelled') && job.changed.length + (job.phase === 'cancelled' ? 1 : 0) > 0 && (
        <div className="row">
          {job.phase === 'failed' && job.changed.length > 0 && (
            <button className="primary" disabled={busy} onClick={() => void act(() => api.jobAction(job.job_id, 'resume'))} title={t('不重来：用它已经改好的文件，从跑测试接着走到开 PR', 'No restart: keep the files it already changed and continue from running the tests to opening a PR')}>
              {t('接着做：重跑测试并提交', 'Continue: rerun the tests and submit')}
            </button>
          )}
          <button disabled={busy} onClick={() => void act(() => api.jobAction(job.job_id, 'revert'))}>
            {t('还原它改过的文件', 'Revert the files it changed')}
          </button>
          <span className="muted small">{t(`把 ${job.directory}/ 里改过的文件恢复成仓库里的样子，新建的删掉。数据文件不动。`, `Restores the changed files in ${job.directory}/ to what the repository has and deletes new ones. Data files are left alone.`)}</span>
        </div>
      )}

      {(job.changed.length > 0 || job.test_log || notes.length > 0 || job.denied.length > 0) && (
        <details className="job-log">
          <summary>{t('经过', 'Log')}{job.changed.length > 0 && t(`，改了 ${job.changed.length} 个文件`, `, ${plural(job.changed.length, 'file')} changed`)}</summary>
          {job.changed.length > 0 && (
            <ul className="plain small">
              {job.changed.map((f) => (
                <li key={f}><code>{f}</code></li>
              ))}
            </ul>
          )}
          <ol className="plain small job-events">
            {events.filter((e) => e.type !== 'plan' && !(e.type === 'step' && e.state !== 'running')).map((e) => (
              <li key={e.seq}>
                <span className="muted num">{formatTime(e.at).slice(11)}</span> {e.text ?? e.label ?? e.message ?? e.type}
              </li>
            ))}
          </ol>
          {job.repairs > 0 && <p className="small">{t(`测试没过之后，让它修了 ${job.repairs} 轮。`, `After the tests failed, it was asked to fix things for ${plural(job.repairs, 'round')}.`)}</p>}
          {job.denied.length > 0 && (
            <>
              <p className="small">{t('这些操作被拒绝了（不在放行的范围里）：', 'These actions were refused (outside what is allowed):')}</p>
              <ul className="plain small">
                {job.denied.map((d) => (
                  <li key={d}><code>{d}</code></li>
                ))}
              </ul>
            </>
          )}
          {job.test_log && <pre className="job-pre">{job.test_log}</pre>}
        </details>
      )}
      {error && <p className="err" role="alert">{error}</p>}
    </div>
  )
}
