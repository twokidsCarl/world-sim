import { useEffect, useRef, useState } from 'react'
import { type Job, type JobEvent, api } from '../api'
import { Markdown } from '../assistant/Markdown'
import { formatTime } from '../state/derive'

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

  if (!job) return <p className="muted small">{error ?? '正在读取作业…'}</p>
  const active = ACTIVE.includes(job.phase)
  const steps = events.filter((e) => e.type === 'step' && e.state === 'running')
  const notes = events.filter((e) => e.type === 'note')

  return (
    <div className="job">
      <div className="job-head">
        <span className={`badge ${TONE[job.phase] ?? ''}`}>
          {active && <span className="spin" aria-hidden="true">◌</span>} {job.phase_label}
        </span>
        <span className="muted small">
          在 <code>{job.directory}/</code> · 开始于 {formatTime(job.created_at)}
          {job.cost_usd > 0 && ` · 约 ${job.cost_usd.toFixed(2)} 美元`}
        </span>
        {active && (
          <button disabled={busy} onClick={() => void act(() => api.jobAction(job.job_id, 'cancel'))}>
            取消
          </button>
        )}
      </div>

      {active && (
        <p className="muted small" role="status">
          {job.phase === 'planning' && 'Claude 正在读代码、写方案。这一步它只读不写。'}
          {job.phase === 'running' && `Claude 正在按方案动手，只能改 ${job.directory}/ 下面的文件。`}
          {job.phase === 'testing' && '它做完了，现在由程序自己把测试再跑一遍。'}
          {job.phase === 'pr' && '测试通过，正在开 PR 并等它自动合并。'}
          {steps.length > 0 && ` 已经读、改了 ${steps.length} 处，最近：${steps[steps.length - 1]!.label}`}
        </p>
      )}

      {job.error && <div className="notice bad pre" role="alert">{job.error}</div>}
      {job.phase === 'merged' && (
        <div className="notice good" role="status">
          已合并{job.pr_url && <>：<a href={job.pr_url} target="_blank" rel="noreferrer">合并请求 #{job.pr}</a></>}。
          {typeof job.summary.summary_zh === 'string' && ` ${job.summary.summary_zh}`}
          {job.restart_needed && ' 后端的代码变了，重启后端之后才生效。'}
        </div>
      )}

      {job.plan && (
        <details open={job.phase === 'plan_ready'} className="job-plan">
          <summary>方案{job.feedback.length > 0 && `（按你的意见改过 ${job.feedback.length} 次）`}</summary>
          <Markdown text={job.plan} />
        </details>
      )}

      {job.phase === 'plan_ready' && (
        <div className="job-actions">
          {mode === null ? (
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => void act(() => api.jobAction(job.job_id, 'approve'))}>
                批准，开始动手
              </button>
              <button onClick={() => setMode('revise')}>提意见，重写方案</button>
              <button onClick={() => setMode('decline')}>不做</button>
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
                {mode === 'revise' ? '你的意见' : '为什么不做（可以不填）'}
                <textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
              </label>
              <div className="row">
                <button type="submit" className="primary" disabled={busy || (mode === 'revise' && !feedback.trim())}>
                  {mode === 'revise' ? '让它重写' : '标为不做'}
                </button>
                <button type="button" onClick={() => setMode(null)}>
                  取消
                </button>
              </div>
            </form>
          )}
          <p className="muted small">批准之前它不会改任何文件。批准之后：它动手 → 程序重跑测试 → 开 PR → 自动合并。</p>
        </div>
      )}

      {(job.phase === 'failed' || job.phase === 'cancelled') && job.changed.length + (job.phase === 'cancelled' ? 1 : 0) > 0 && (
        <div className="row">
          {job.phase === 'failed' && job.changed.length > 0 && (
            <button className="primary" disabled={busy} onClick={() => void act(() => api.jobAction(job.job_id, 'resume'))} title="不重来：用它已经改好的文件，从跑测试接着走到开 PR">
              接着做：重跑测试并提交
            </button>
          )}
          <button disabled={busy} onClick={() => void act(() => api.jobAction(job.job_id, 'revert'))}>
            还原它改过的文件
          </button>
          <span className="muted small">把 {job.directory}/ 里改过的文件恢复成仓库里的样子，新建的删掉。数据文件不动。</span>
        </div>
      )}

      {(job.changed.length > 0 || job.test_log || notes.length > 0 || job.denied.length > 0) && (
        <details className="job-log">
          <summary>经过{job.changed.length > 0 && `，改了 ${job.changed.length} 个文件`}</summary>
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
          {job.repairs > 0 && <p className="small">测试没过之后，让它修了 {job.repairs} 轮。</p>}
          {job.denied.length > 0 && (
            <>
              <p className="small">这些操作被拒绝了（不在放行的范围里）：</p>
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
