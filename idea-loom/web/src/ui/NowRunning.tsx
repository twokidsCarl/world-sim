import { useEffect, useState } from 'react'
import { type WorkerStatus, api } from '../api'
import { useT } from '../state/store'
import { Section } from './Page'

// 现在在跑什么：队列、在跑的作业、今天开工了几个、订阅额度用了多少、等你看的草稿 PR、定时维护做过什么。
// What is running now: the queue, running jobs, how many started today, how much of the allowance
// is used, draft PRs waiting for you, and what scheduled maintenance has done.
export function NowRunning({ onOpen }: { onOpen: (jobId: string) => void }) {
  const t = useT()
  const [status, setStatus] = useState<WorkerStatus | null>(null)
  useEffect(() => {
    const load = () => api.worker().then(setStatus, () => undefined)
    void load()
    const timer = setInterval(load, 15000)
    return () => clearInterval(timer)
  }, [])
  if (!status) return null
  const windows = Object.entries(status.usage.windows ?? {}).filter(([, w]) => typeof w.utilization === 'number' && (w.resets_at ?? 0) * 1000 > Date.now())
  const quiet = status.queued.length === 0 && status.active.length === 0 && status.review.length === 0
  const names: Record<string, string> = { five_hour: t('五小时窗口', 'five-hour window'), seven_day: t('七天窗口', 'seven-day window') }
  return (
    <Section
      title={t('现在在跑什么', 'What is running now')}
      note={t(`今天开工了 ${status.started_today} / ${status.per_day} 个作业`, `${status.started_today} of ${status.per_day} jobs started today`)}
    >
      {status.paused && <div className="notice warn" role="status">{t(`队列暂停了：${status.paused}`, `The queue is paused: ${status.paused}`)}</div>}
      {quiet && <p className="muted small">{t('没有在跑的，也没有排着队的。', 'Nothing is running and nothing is queued.')}</p>}
      <ul className="plain-list">
        {status.active.map((j) => (
          <li key={j.job_id}>
            <span className="spin" aria-hidden="true">◌</span> <button className="link" onClick={() => onOpen(j.job_id)}>{j.title}</button> <span className="muted small">{j.phase}</span>
          </li>
        ))}
        {status.queued.map((j) => (
          <li key={j.job_id}>
            {t('排队', 'Queued')} · <button className="link" onClick={() => onOpen(j.job_id)}>{j.title}</button>
            {j.waiting && <span className="muted small"> {t(`还没轮到：${j.waiting}`, `not started yet: ${j.waiting}`)}</span>}
          </li>
        ))}
        {status.review.map((j) => (
          <li key={j.job_id}>
            {t('等你看', 'Waiting for you')} · {j.title}{' '}
            {j.pr_url && <a href={j.pr_url} target="_blank" rel="noreferrer">{t('草稿 PR ↗', 'draft PR ↗')}</a>}
          </li>
        ))}
      </ul>
      {windows.length > 0 && (
        <p className="small muted">
          {t('订阅额度：', 'Subscription allowance: ')}
          {windows.map(([name, w]) => `${names[name] ?? name} ${Math.round((w.utilization ?? 0) * 100)}%`).join(t('，', ', '))}
        </p>
      )}
      {Object.keys(status.chains).length > 0 && (
        <p className="small muted">
          {t('连续推进：', 'Chains: ')}
          {Object.entries(status.chains).map(([dir, left]) => t(`${dir} 还剩 ${left} 步`, `${dir} has ${left} left`)).join(t('，', ', '))}
        </p>
      )}
      <p className="small muted">
        {status.maintenance.enabled
          ? t(
              `自动维护开着：每 ${Math.round(status.maintenance.check_seconds / 60)} 分钟看一次，最近 ${status.maintenance.window_minutes} 分钟提交少于 ${status.maintenance.below} 次、又没有别的作业时，自动做一件小事（每天最多 ${status.maintenance.per_day} 次）。`,
              `Automatic maintenance is on: checked every ${Math.round(status.maintenance.check_seconds / 60)} minutes; with fewer than ${status.maintenance.below} commits in the last ${status.maintenance.window_minutes} minutes and no other job, it does one small thing by itself (at most ${status.maintenance.per_day} a day).`,
            )
          : t('自动维护没有打开。', 'Automatic maintenance is off.')}
        {status.maintenance.enabled && status.maintenance.last_check.why_not && t(` 上一次看的时候没做：${status.maintenance.last_check.why_not}。`, ` Not started at the last check: ${status.maintenance.last_check.why_not}.`)}
        {status.maintenance.recent.length > 0 && t(` 最近做过：${status.maintenance.recent.slice(0, 3).map((r) => `${r.item}（${r.directory}）`).join('、')}`, ` Recently: ${status.maintenance.recent.slice(0, 3).map((r) => `${r.item} (${r.directory})`).join(', ')}`)}
      </p>
    </Section>
  )
}
