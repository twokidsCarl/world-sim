import { useEffect, useState } from 'react'
import { VisitorQueue } from './SuggestPage'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { type Job, type Suggestion, type WishDetail, type WishList, api } from '../api'
import { JobPanel } from '../ui/JobPanel'
import { useAssistant } from '../assistant/store'
import { label, plural } from '../i18n'
import { formatTime } from '../state/derive'
import { useLang, useT } from '../state/store'
import { Empty, Page, Section } from '../ui/Page'

const TONE: Record<string, string> = { open: 'w-open', accepted: 'w-accepted', done: 'w-done', declined: 'w-quiet', withdrawn: 'w-quiet' }
const MARK: Record<string, string> = { open: '○', accepted: '◐', done: '●', declined: '⊘', withdrawn: '×' }

export function WishBadge({ status, label: text }: { status: string; label: string }) {
  const lang = useLang()
  return (
    <span className={`badge ${TONE[status] ?? ''}`}>
      <span aria-hidden="true">{MARK[status]}</span> {label(lang, 'wishStatus', status, text)}
    </span>
  )
}

export function WishesPage() {
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? ''
  const [list, setList] = useState<WishList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const restored = params.get('withdrawn')
  const lang = useLang()
  const t = useT()

  useEffect(() => {
    api.wishes(status).then(setList, (e: Error) => setError(e.message))
  }, [status, restored])

  const total = list ? Object.values(list.counts).reduce((a, b) => a + b, 0) : 0
  return (
    <Page
      title={t('许愿池', 'Wish pool')}
      lead={t(
        '对 idea-loom 这个工具本身的改进愿望。愿望不是在这里填的：和右边的小助手说话时，它发现工具哪里不顺手就会记一条，你也可以直接跟它说"把这个记下来"。',
        'Wishes for improving the idea-loom tool itself. Wishes are not filled in here: while you talk to the assistant on the right, it records one whenever it notices the tool getting in your way, and you can also just tell it "write this down".',
      )}
    >
      {error && <div className="notice bad" role="alert">{error}</div>}
      {restored && (
        <div className="notice good" role="status">
          {t('已撤销。', 'Withdrawn.')}{' '}
          <button onClick={() => void api.restoreWish(restored).then(() => setParams({}))}>{t('恢复', 'Restore')}</button>{' '}
          <button onClick={() => setParams({})}>{t('知道了', 'Got it')}</button>
        </div>
      )}
      <VisitorQueue onAccepted={() => api.wishes(status).then(setList, () => undefined)} />
      <Review onRecorded={() => api.wishes(status).then(setList, () => undefined)} />
      {list && (
        <>
          <div className="wish-counts" role="group" aria-label={t('按状态筛选', 'Filter by status')}>
            <button aria-pressed={status === ''} onClick={() => setParams({})}>
              {t('待处理', 'To handle')} <span className="num">{(list.counts.open ?? 0) + (list.counts.accepted ?? 0)}</span>
            </button>
            {Object.entries(list.statuses).map(([key, text]) => (
              <button key={key} aria-pressed={status === key} onClick={() => setParams({ status: key })}>
                <span aria-hidden="true">{MARK[key]}</span> {label(lang, 'wishStatus', key, text)} <span className="num">{list.counts[key] ?? 0}</span>
              </button>
            ))}
          </div>
          {list.wishes.length > 0 && (
            <div className="wish-kinds" aria-label={t('按种类', 'By kind')}>
              {Object.entries(list.kind_labels)
                .filter(([key]) => (list.kinds[key] ?? 0) > 0)
                .map(([key, text]) => (
                  <div key={key} className="wish-kind">
                    <span>{label(lang, 'wishKind', key, text)}</span>
                    <span className="bar" aria-hidden="true">
                      <span style={{ width: `${((list.kinds[key] ?? 0) / list.wishes.length) * 100}%` }} />
                    </span>
                    <span className="num">{list.kinds[key]}</span>
                  </div>
                ))}
            </div>
          )}
          {list.unreadable > 0 && <div className="notice warn">{t(`愿望记录里有 ${list.unreadable} 行读不出来，已跳过。`, `${plural(list.unreadable, 'line')} in the wish log could not be read and ${list.unreadable === 1 ? 'was' : 'were'} skipped.`)}</div>}
          {list.wishes.length === 0 ? (
            <Empty>
              {total === 0
                ? t('还没有愿望。打开右下角的小助手，问它点什么，或者告诉它哪里不顺手。', 'No wishes yet. Open the assistant in the bottom right corner and ask it something, or tell it what gets in your way.')
                : t('这个状态下没有愿望。', 'No wishes with this status.')}
            </Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t('愿望', 'Wish')}</th>
                  <th scope="col">{t('种类', 'Kind')}</th>
                  <th scope="col">{t('出在哪一页', 'Page it came up on')}</th>
                  <th scope="col" className="r">{t('遇到几次', 'Times seen')}</th>
                  <th scope="col">{t('状态', 'Status')}</th>
                  <th scope="col">{t('最近变化', 'Last change')}</th>
                </tr>
              </thead>
              <tbody>
                {list.wishes.map((w) => (
                  <tr key={w.wish_id}>
                    <td>
                      <Link to={`/wishes/${w.wish_id}`}>{w.title}</Link>
                    </td>
                    <td className="muted">{label(lang, 'wishKind', w.kind, w.kind_label)}</td>
                    <td>{w.where?.url ? <Link to={w.where.url}>{w.where.title || w.where.url}</Link> : <span className="muted">—</span>}</td>
                    <td className="r num">{w.occurrences}</td>
                    <td>
                      <WishBadge status={w.status} label={w.status_label} />
                      {w.pr != null && <span className="muted small"> {t(`合并请求 #${w.pr}`, `Pull request #${w.pr}`)}</span>}
                    </td>
                    <td className="muted small">{formatTime(w.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Page>
  )
}

export function WishPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const refresh = useAssistant((s) => s.refresh)
  const [wish, setWish] = useState<WishDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ title: '', stuck: '', suggestion: '' })
  const [copied, setCopied] = useState(false)
  const [job, setJob] = useState<Job | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const lang = useLang()
  const t = useT()
  const loadJob = () => api.jobs().then((all) => setJob(all.find((j) => j.kind === 'wish' && j.ref === id) ?? null), () => undefined)

  const reload = () => api.wish(id).then(setWish, (e: Error) => setError(e.message))
  useEffect(() => {
    setWish(null)
    setError(null)
    void reload()
    void loadJob()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  if (error && !wish) return <Page title={t('愿望', 'Wish')}><div className="notice bad" role="alert">{error}</div></Page>
  if (!wish) return <Page title={t('愿望', 'Wish')}><p className="muted">{t('正在读取…', 'Loading…')}</p></Page>
  const open = wish.status === 'open'
  const canStart = ['open', 'accepted'].includes(wish.status) && (!job || ['failed', 'cancelled', 'declined'].includes(job.phase))

  return (
    <Page
      title={wish.title}
      lead={t(`${wish.kind_label} · 遇到 ${wish.occurrences} 次`, `${label(lang, 'wishKind', wish.kind, wish.kind_label)} · seen ${plural(wish.occurrences, 'time')}`)}
      actions={
        open &&
        !editing && (
          <div className="row">
            <button onClick={() => (setDraft({ title: wish.title, stuck: wish.stuck, suggestion: wish.suggestion }), setEditing(true))}>{t('改写', 'Rewrite')}</button>
            <button
              onClick={() =>
                void api.withdrawWish(wish.wish_id).then(() => {
                  void refresh()
                  navigate(`/wishes?withdrawn=${wish.wish_id}`)
                }, (e: Error) => setError(e.message))
              }
            >
              {t('撤销', 'Withdraw')}
            </button>
          </div>
        )
      }
    >
      <div className="meta-row">
        <WishBadge status={wish.status} label={wish.status_label} />
        {wish.status_note && <span className="muted">{wish.status_note}</span>}
        <span className="muted small">{t('记于', 'Recorded')} {formatTime(wish.created_at)}</span>
        <span className="muted small">{t('最近变化', 'Last change')} {formatTime(wish.updated_at)}</span>
        {wish.where?.url && (
          <span className="small">
            {t('出在', 'Came up on')} <Link to={wish.where.url}>{wish.where.title || wish.where.url}</Link>
          </span>
        )}
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      {!open && wish.status !== 'withdrawn' && (
        <p className="muted small after-meta">
          {t(
            `已经是"${wish.status_label}"，不能再改写或撤销。还想改，跟处理它的 Claude 说，或者让小助手另记一条。`,
            `It is already "${label(lang, 'wishStatus', wish.status, wish.status_label)}" and can no longer be rewritten or withdrawn. To change it, tell the Claude handling it, or have the assistant record another one.`,
          )}
        </p>
      )}
      {wish.status === 'withdrawn' && (
        <p className="after-meta">
          <button onClick={() => void api.restoreWish(wish.wish_id).then(() => (void reload(), void refresh()))}>{t('恢复这条愿望', 'Restore this wish')}</button>
        </p>
      )}

      {editing ? (
        <form
          className="form wide"
          onSubmit={(e) => {
            e.preventDefault()
            void api.editWish(wish.wish_id, draft).then((w) => (setWish(w), setEditing(false)), (err: Error) => setError(err.message))
          }}
        >
          <label>
            {t('一句话', 'In one sentence')}
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </label>
          <label>
            {t('卡在哪', 'Where it gets stuck')}
            <textarea rows={3} value={draft.stuck} onChange={(e) => setDraft({ ...draft, stuck: e.target.value })} />
          </label>
          <label>
            {t('建议怎么改', 'Suggested change')}
            <textarea rows={3} value={draft.suggestion} onChange={(e) => setDraft({ ...draft, suggestion: e.target.value })} />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={!draft.title.trim()}>
              {t('保存', 'Save')}
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              {t('取消', 'Cancel')}
            </button>
          </div>
        </form>
      ) : (
        <div className="halves">
          <Section title={t('卡在哪', 'Where it gets stuck')}>
            <p className="pre">{wish.stuck || t('（没有写）', '(nothing written)')}</p>
          </Section>
          <Section title={t('建议', 'Suggestion')}>
            <p className="pre">{wish.suggestion || t('（没有写）', '(nothing written)')}</p>
          </Section>
        </div>
      )}

      <div className="halves">
        <Section title={t('方案和合并请求', 'Plans and pull requests')} note={t('由处理它的 Claude Code 标回来，这里只显示', 'Marked back by the Claude Code handling it; shown here only')}>
          {wish.links.length === 0 ? (
            <Empty>{t('还没有。', 'None yet.')}</Empty>
          ) : (
            <ul className="plain">
              {wish.links.map((l, i) => (
                <li key={i}>
                  <span className="badge">{l.kind === 'pr' ? t(`合并请求${l.pr != null ? ` #${l.pr}` : ''}`, `Pull request${l.pr != null ? ` #${l.pr}` : ''}`) : l.kind === 'plan' ? t('方案', 'Plan') : t('作业', 'Job')}</span>{' '}
                  {l.url ? (
                    l.url.startsWith('/') ? <Link to={l.url}>{l.title || l.url}</Link> : <a href={l.url} target="_blank" rel="noreferrer">{l.title || l.url}</a>
                  ) : (
                    l.title
                  )}{' '}
                  <span className="muted small">{formatTime(l.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title={t('说明', 'Notes')} note={t('最近的在前', 'Latest first')}>
          {wish.notes.length === 0 ? (
            <Empty>{t('还没有。', 'None yet.')}</Empty>
          ) : (
            <ul className="plain">
              {wish.notes.map((n, i) => (
                <li key={i}>
                  <span className="pre">{n.text}</span>{' '}
                  <span className="muted small">
                    {label(lang, 'wishBy', n.by, n.by_label)} · {formatTime(n.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title={t('交给 Claude 去做', 'Hand it to Claude')} note={t('先出方案，你批准之后它才动手', 'It writes a plan first and only acts after you approve')}>
        {job ? (
          <JobPanel jobId={job.job_id} onChange={() => (void reload(), void refresh(), void loadJob())} />
        ) : null}
        {job && !['failed', 'cancelled', 'declined'].includes(job.phase) && ['open', 'accepted'].includes(wish.status) && (
          <div className="row">
            <button className="primary" disabled>
              {t('开工：让 Claude 先出方案', 'Start: have Claude write a plan first')}
            </button>
            <span className="muted small">
              {t('这条愿望已经有一个作业在进行，见上面的作业。', 'This wish already has a job under way; see the job above.')}{' '}
              <Link to={`/work/jobs/${job.job_id}`}>{t('打开作业', 'Open the job')}</Link>
              {job.queued && job.waiting ? ` · ${t(`排队中：${job.waiting}`, `Queued: ${job.waiting}`)}` : ''}
            </span>
          </div>
        )}
        {startError && <div className="notice bad" role="alert">{startError}</div>}
        {canStart && (
          <div className="row">
            <button
              className="primary"
              disabled={starting}
              onClick={() => {
                setStarting(true)
                setStartError(null)
                void api.startJob('wish', wish.wish_id).then(
                  () => (setStarting(false), void loadJob(), void reload()),
                  (e: Error) => (setStarting(false), setStartError(e.message), void loadJob()),
                )
              }}
            >
              {starting ? t('正在启动…', 'Starting…') : job ? t('再来一次：重新出方案', 'Once more: write a new plan') : t('开工：让 Claude 先出方案', 'Start: have Claude write a plan first')}
            </button>
            <span className="muted small">{t('它先只读代码、写一份方案给你看，不改任何东西。', 'At first it only reads the code and writes a plan for you to read; it changes nothing.')}</span>
          </div>
        )}
        <details className="table-view">
          <summary>{t('想自己开一个 Claude Code 会话去做', 'Do it in a Claude Code session of your own')}</summary>
          <p className="muted small">
            {t('把下面这句话贴进去。它用命令 ', 'Paste the text below into it. It uses the command ')}<code>idea-loom wishes</code>{t(' 把采纳、做完、不做标回来。', ' to mark the wish accepted, done or declined.')}
          </p>
          <figure className="prompt small-prompt">
            <blockquote className="pre">{wish.copy_text}</blockquote>
            <figcaption>
              <button
                onClick={() =>
                  void navigator.clipboard.writeText(wish.copy_text).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1600)
                  }, () => undefined)
                }
              >
                {copied ? t('已复制', 'Copied') : t('复制这句话', 'Copy this text')}
              </button>
            </figcaption>
          </figure>
        </details>
      </Section>

      <Section title={t('遇到的每一次', 'Every time it came up')} note={t(`${wish.seen.length} 次`, plural(wish.seen.length, 'time'))}>
        <ul className="plain">
          {wish.seen.map((s, i) => (
            <li key={i}>
              <span className="muted small">{formatTime(s.at)}</span> {s.question || t('（没有记下当时的问题）', '(the question at the time was not recorded)')}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t('经过', 'History')}>
        <ol className="history">
          {wish.history.map((h, i) => (
            <li key={i} className="hist">
              <div className="hist-head">
                <span className="badge">{label(lang, 'wishEvent', h.event, h.event_label)}</span>
                <span>{h.text}</span>
                <span className="muted small">
                  {formatTime(h.at)} · {label(lang, 'wishBy', h.by, h.by_label)}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </Section>
    </Page>
  )
}

// 回看：让模型读一遍最近的操作，提出最多三条愿望，由你取舍。
// Review: the model reads your recent actions and proposes up to three wishes for you to keep or drop.
function Review({ onRecorded }: { onRecorded: () => void }) {
  const refresh = useAssistant((s) => s.refresh)
  const [status, setStatus] = useState<{ actions_since: number; due: boolean; last_at: string | null } | null>(null)
  const [items, setItems] = useState<Suggestion[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = useT()
  useEffect(() => {
    api.reviewStatus().then(setStatus, () => undefined)
  }, [items])
  const run = () => {
    setBusy(true)
    setError(null)
    api.review().then(
      (found) => (setItems(found), setBusy(false)),
      (e: Error) => (setError(e.message), setBusy(false)),
    )
  }
  const drop = (s: Suggestion) => setItems((old) => (old ?? []).filter((x) => x !== s))
  return (
    <div className="review">
      <div className="row wrap">
        <button disabled={busy} onClick={run}>
          {busy ? t('正在回看，大约二十秒…', 'Reviewing, about twenty seconds…') : t('回看我最近的使用', 'Review my recent use')}
        </button>
        <span className="muted small">
          {t(
            '让模型读一遍你最近在界面里的操作（不含输入的文字），自己提出最多三条愿望，记不记由你定。',
            'The model reads what you did in the UI recently (not the text you typed) and proposes up to three wishes of its own; whether to record them is up to you.',
          )}
          {status && t(` 上次回看之后攒了 ${status.actions_since} 条操作。`, ` ${plural(status.actions_since, 'action')} since the last review.`)}
          {status?.due && t(' 可以回看一次了。', ' Time for a review.')}
        </span>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      {items && items.length === 0 && <p className="muted">{t('这次没看出什么值得记的。', 'Nothing worth recording this time.')}</p>}
      {items && items.length > 0 && (
        <div className="proposals">
          {items.map((s) => (
            <article key={s.title} className="proposal">
              <h3>{s.title}</h3>
              <p><span className="muted small">{t('卡在哪', 'Where it gets stuck')}</span> {s.stuck}</p>
              <p><span className="muted small">{t('建议', 'Suggestion')}</span> {s.suggestion}</p>
              <p className="muted small p-why">{t('它的依据：', 'Its evidence: ')}{s.evidence}</p>
              <div className="row">
                <button
                  className="primary"
                  onClick={() => void api.recordWish(s).then(() => (drop(s), onRecorded(), void refresh()), (e: Error) => setError(e.message))}
                >
                  {t('记进许愿池', 'Record in the wish pool')}
                </button>
                <button onClick={() => drop(s)}>{t('不要', 'Dismiss')}</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
