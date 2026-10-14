import { useEffect, useState } from 'react'
import { VisitorQueue } from './SuggestPage'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { type Job, type ReviewRun, type ReviewStatus, type Wish, type WishDetail, type WishList, api } from '../api'
import { JobPanel } from '../ui/JobPanel'
import { useAssistant } from '../assistant/store'
import { label, plural } from '../i18n'
import { formatTime } from '../state/derive'
import { useLang, useT } from '../state/store'
import { SessionView } from '../sessions/SessionView'
import { whereLabel } from '../ui/nav'
import { DEFAULT_GROUPS, WISH_GROUPS, type WishGroup, groupCount, readFilter, writeFilter } from './wishFilter'
import { wishCommand, wishName } from './wishName'
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

// 有作业正在做这条愿望时，在状态旁边标出它走到哪一步。等你批方案的那一步用醒目的徽标，其余的是转圈的小字。
// When a job is working on the wish, show its stage next to the status. The step waiting for your approval gets a badge that stands out; the rest are small text with a spinner.
function JobStage({ wish }: { wish: Wish }) {
  const lang = useLang()
  const t = useT()
  if (!wish.job_phase) return null
  if (wish.job_queued) return <span className="muted small"> {t('排队中', 'Queued')}</span>
  const text = label(lang, 'phase', wish.job_phase, wish.job_label ?? wish.job_phase)
  if (wish.job_phase === 'plan_ready') {
    return (
      <>
        {' '}
        <span className="badge status-draft">
          <span aria-hidden="true">!</span> {text}
        </span>
      </>
    )
  }
  return (
    <span className="muted small">
      {' '}
      <span className="spin" aria-hidden="true">◌</span> {text}
    </span>
  )
}

// 有 Claude Code 会话在给这条愿望出计划（/wishes 带编号时自动认领）时标"计划中"。采纳、不做、做完、放下或过了时限就消失。
// "Planning" while a Claude Code session is planning this wish (/wishes with ids claims it). It goes away on accept, decline, done, release or when it lapses.
export function ClaimMark({ wish, full = false }: { wish: Wish; full?: boolean }) {
  const lang = useLang()
  const t = useT()
  if (!wish.claimed_at) return null
  const who = label(lang, 'wishBy', wish.claimed_by ?? '', wish.claimed_by_label ?? wish.claimed_by ?? '')
  const tip = t(`${who} 从 ${formatTime(wish.claimed_at)} 起在出计划，${formatTime(wish.claim_until ?? '')} 自动失效`, `${who} has been planning it since ${formatTime(wish.claimed_at)}; lapses at ${formatTime(wish.claim_until ?? '')}`)
  return (
    <>
      {' '}
      <span className="badge w-claimed" title={tip}>
        <span className="spin" aria-hidden="true">◌</span> {t('计划中', 'Planning')}
      </span>
      {full && <span className="muted small"> {tip}</span>}
    </>
  )
}

export function WishesPage() {
  const [params, setParams] = useSearchParams()
  const { group, status } = readFilter(params)
  const [list, setList] = useState<WishList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const restored = params.get('withdrawn')
  const lang = useLang()
  const t = useT()

  // 列表里本来就带着各状态的数：顺手把左侧栏的待处理数对上。 / The list carries the per-status counts anyway, so the nav's pending count is brought in line with it.
  const setPending = useAssistant((s) => s.setPendingWishes)
  const load = () =>
    api.wishes(status, group).then(
      (l) => (setList(l), setPending(groupCount('pending', l.counts, l.groups && Object.keys(l.groups).length > 0 ? l.groups : DEFAULT_GROUPS))),
      (e: Error) => setError(e.message),
    )
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, group, restored])
  const groups = (list?.groups && Object.keys(list.groups).length > 0 ? list.groups : DEFAULT_GROUPS) as Record<WishGroup, readonly string[]>
  const groupName: Record<WishGroup, string> = { pending: t('待处理', 'To handle'), closed: t('已完结', 'Closed'), all: t('全部', 'All') }

  const total = list ? Object.values(list.counts).reduce((a, b) => a + b, 0) : 0
  return (
    <Page
      title={t('许愿池', 'Wish pool')}
      lead={t(
        '对 idea-loom 这个工具本身的改进愿望。愿望不是在这里填的：和右边的小助手说话时，它发现工具哪里不顺手就会记一条，你也可以直接跟它说"把这个记下来"；回看你最近的使用时，也会自己记下重要的几条。处理它们：在 Claude Code 里运行 /wishes。',
        'Wishes for improving the idea-loom tool itself. Wishes are not filled in here: while you talk to the assistant on the right, it records one whenever it notices the tool getting in your way, and you can also just tell it "write this down"; reviewing your recent use also records the important findings by itself. To handle them, run /wishes in Claude Code.',
      )}
    >
      {error && <div className="notice bad" role="alert">{error}</div>}
      {restored && (
        <div className="notice good" role="status">
          {t('已撤销。', 'Withdrawn.')}{' '}
          <button onClick={() => void api.restoreWish(restored).then(() => setParams(writeFilter({ group, status })))}>{t('恢复', 'Restore')}</button>{' '}
          <button onClick={() => setParams(writeFilter({ group, status }))}>{t('知道了', 'Got it')}</button>
        </div>
      )}
      <HandleAll />
      <VisitorQueue onAccepted={() => void load()} />
      <Review onRecorded={() => void load()} />
      {list && (
        <>
          {/* 第一层是合计，第二层是它的组成部分：样式不同，上下两行。 / The first tier is the totals and the second their parts: different styles, on two rows. */}
          <div className="wish-filter">
            <span className="seg" role="group" aria-label={t('按组筛选', 'Filter by group')}>
              {WISH_GROUPS.map((g) => (
                <button key={g} aria-pressed={group === g} aria-selected={group === g} onClick={() => setParams(writeFilter({ group: g, status: '' }))}>
                  {groupName[g]} <span className="num">{groupCount(g, list.counts, groups)}</span>
                </button>
              ))}
            </span>
            <div className="wish-counts" role="group" aria-label={t(`「${groupName[group]}」里按状态筛选`, `Filter by status within "${groupName[group]}"`)}>
              <span className="muted small">{t('其中', 'Of which')}</span>
              {groups[group].map((key) => (
                <button key={key} aria-pressed={status === key} onClick={() => setParams(writeFilter({ group, status: status === key ? '' : key }))}>
                  <span aria-hidden="true">{MARK[key]}</span> {label(lang, 'wishStatus', key, list.statuses[key] ?? key)} <span className="num">{list.counts[key] ?? 0}</span>
                </button>
              ))}
            </div>
          </div>
          {list.wishes.length > 0 && (
            <div className="wish-kinds" role="group" aria-label={t('下面这些按种类分', 'The wishes below, by kind')}>
              <div className="muted small wish-kinds-head">{t(`下面这 ${list.wishes.length} 条按种类分`, `The ${plural(list.wishes.length, 'wish', 'wishes')} below, by kind`)}</div>
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
                : t('这个筛选下没有愿望。', 'No wishes under this filter.')}
            </Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t('愿望', 'Wish')}</th>
                  <th scope="col">{t('种类', 'Kind')}</th>
                  <th scope="col">{t('记于哪页', 'Recorded on')}</th>
                  <th scope="col" className="r">{t('遇到几次', 'Times seen')}</th>
                  <th scope="col">{t('状态', 'Status')}</th>
                  <th scope="col">{t('最近变化', 'Last change')}</th>
                </tr>
              </thead>
              <tbody>
                {list.wishes.map((w) => (
                  <tr key={w.wish_id}>
                    <td>
                      <span className="muted small num wish-name">{wishName(w.number)}</span> <Link to={`/wishes/${wishName(w.number) || w.wish_id}`}>{w.title}</Link>
                    </td>
                    <td className="muted">{label(lang, 'wishKind', w.kind, w.kind_label)}</td>
                    <td>{w.where?.url ? <Link to={w.where.url}>{whereLabel(w.where.url, w.where.title, lang)}</Link> : <span className="muted">—</span>}</td>
                    <td className="r num">{w.occurrences}</td>
                    <td>
                      <WishBadge status={w.status} label={w.status_label} />
                      <ClaimMark wish={w} />
                      <JobStage wish={w} />
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
  const [jobs, setJobs] = useState<Job[]>([])
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const lang = useLang()
  const t = useT()
  const loadJob = () => api.jobs().then(setJobs, () => undefined)

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
  // 地址里可以是 wish-N，作业记的是完整编号。 / The address may say wish-N; jobs record the full id.
  const job = jobs.find((j) => j.kind === 'wish' && j.ref === wish.wish_id) ?? null
  const open = wish.status === 'open'
  const canStart = ['open', 'accepted'].includes(wish.status) && (!job || ['failed', 'cancelled', 'declined'].includes(job.phase))

  return (
    <Page
      title={wish.title}
      lead={[wishName(wish.number), t(`${wish.kind_label} · 遇到 ${wish.occurrences} 次`, `${label(lang, 'wishKind', wish.kind, wish.kind_label)} · seen ${plural(wish.occurrences, 'time')}`)].filter(Boolean).join(' · ')}
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
        <ClaimMark wish={wish} full />
        {wish.status_note && <span className="muted">{wish.status_note}</span>}
        <span className="muted small">{t('记于', 'Recorded')} {formatTime(wish.created_at)}</span>
        <span className="muted small">{t('最近变化', 'Last change')} {formatTime(wish.updated_at)}</span>
        {wish.where?.url && (
          <span className="small">
            {t('记下时在', 'Recorded while on')} <Link to={wish.where.url}>{whereLabel(wish.where.url, wish.where.title, lang)}</Link>
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

      <Section title={t('在 Claude Code 里处理', 'Handle it in Claude Code')} note={t('它拿到这条愿望的数据，先出计划，你批准之后才动手', 'It fetches this wish, plans first and only acts after you approve')}>
        <WishSession wish={wish} />
        <WishCommand wish={wish} />
        {job ? (
          <JobPanel jobId={job.job_id} onChange={() => (void reload(), void refresh(), void loadJob())} />
        ) : null}
        {canStart && (
          <details className="table-view">
            <summary>{t('或者让网页里的自动作业来做', 'Or have the automatic job in this page do it')}</summary>
            <p className="muted small">
              {t('它在后台跑、中途问不了你问题，适合很小、很明确的改动；别的还是用上面的 /wishes。', 'It runs in the background and cannot ask you anything along the way, which suits very small, clear-cut changes; for anything else use /wishes above.')}
            </p>
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
          </details>
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

// 回看：攒够一批操作，后台自己让模型读一遍，给每条发现打重要程度；重要的直接记进许愿池，其余的丢掉。
// 这里显示攒了多少、能"现在回看"，下面是最近几次回看的记录，丢掉的可以捞回来。
// Review: once enough actions pile up, the backend has the model read them and rate each finding's importance; important ones go
// straight into the wish pool and the rest are dropped. Here: how many have piled up, "review now", and the recent reviews, where a dropped one can be rescued.
function Review({ onRecorded }: { onRecorded: () => void }) {
  const refresh = useAssistant((s) => s.refresh)
  const [status, setStatus] = useState<ReviewStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const t = useT()
  const running = status?.running ?? false
  const load = () => api.reviewStatus().then(setStatus, () => undefined)
  useEffect(() => {
    void load()
  }, [])
  // 在回看的时候每隔几秒看一眼，做完了刷新愿望列表。 / While a review runs, look every few seconds; when it ends, refresh the wish list.
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      api.reviewStatus().then((s) => {
        setStatus(s)
        if (!s.running) (onRecorded(), void refresh())
      }, () => undefined)
    }, 3000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])
  const run = () => {
    setError(null)
    api.review().then(setStatus, (e: Error) => setError(e.message))
  }
  const rescue = (r: ReviewRun, i: number) =>
    void api.rescueFinding(r.id, i).then(() => (void load(), onRecorded(), void refresh()), (e: Error) => setError(e.message))
  const dueAfter = status?.due_after ?? 300
  const recordAt = status?.record_at ?? 4
  return (
    <div className="review">
      <div className="row wrap">
        <button disabled={running} onClick={run}>
          {running ? t('正在回看，大约二十秒…', 'Reviewing, about twenty seconds…') : t('现在回看', 'Review now')}
        </button>
        <span className="muted small">
          {t(
            `每攒够 ${dueAfter} 条操作，后台就自己回看一次：模型读一遍你最近在界面里的操作（不含输入的文字），提出改进愿望，并给每条打 1–5 分的重要程度。${recordAt} 分及以上的直接记进许愿池，其余的丢掉；下面留着记录，丢掉的也能捞回来。`,
            `Every ${dueAfter} actions the backend reviews by itself: the model reads what you did in the UI recently (not the text you typed), proposes wishes and rates each one's importance from 1 to 5. Those at ${recordAt} or above go straight into the wish pool and the rest are dropped; the log below keeps them, and a dropped one can still be rescued.`,
          )}
          {status && t(` 上次回看之后攒了 ${status.actions_since} 条操作。`, ` ${plural(status.actions_since, 'action')} since the last review.`)}
          {status && !status.auto && t(' 现在没有可用的模型，不会自己回看。', ' No model is available right now, so no review runs by itself.')}
        </span>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      {status && status.runs.length > 0 && (
        <div className="review-log">
          {status.runs.map((r, n) => (
            <ReviewEntry key={r.id} run={r} open={n === 0} recordAt={recordAt} onRescue={(i) => rescue(r, i)} />
          ))}
        </div>
      )}
    </div>
  )
}

// 一次回看的记录：什么时候、怎么开始的、记了几条、丢了几条；展开看每条的分数和理由。
// One review in the log: when, how it started, how many were recorded and dropped; open it for each finding's score and reason.
function ReviewEntry({ run, open, recordAt, onRescue }: { run: ReviewRun; open: boolean; recordAt: number; onRescue: (index: number) => void }) {
  const lang = useLang()
  const t = useT()
  const kept = run.findings.filter((f) => f.wish_id).length
  const how = run.trigger === 'auto' ? t('自动', 'Automatic') : t('手动', 'Manual')
  const outcome = run.error
    ? t(`没做成：${run.error}`, `Failed: ${run.error}`)
    : run.findings.length === 0
      ? t('没看出什么值得记的', 'nothing worth recording')
      : t(`记了 ${kept} 条，丢了 ${run.findings.length - kept} 条`, `${kept} recorded, ${run.findings.length - kept} dropped`)
  return (
    <details className="review-run" open={open}>
      <summary>
        {formatTime(run.at)} · {how} · {t(`读了 ${run.actions} 条操作`, `read ${plural(run.actions, 'action')}`)} ·{' '}
        <span className={run.error ? 'err' : ''}>{outcome}</span>
      </summary>
      <ul className="review-findings">
        {run.findings.map((f, i) => (
          <li key={i} className={f.wish_id ? '' : 'dropped'}>
            <span className={`badge ${f.importance >= recordAt ? 'w-open' : 'w-quiet'}`} title={t('重要程度（1–5）', 'Importance (1–5)')}>
              {f.importance}/5
            </span>{' '}
            {f.wish_id ? <Link to={`/wishes/${f.wish_id}`}>{f.title}</Link> : <strong>{f.title}</strong>}{' '}
            <span className="muted small">{label(lang, 'wishKind', f.kind, f.kind)}</span>
            {f.rescued && <span className="muted small"> · {t('捞回来的', 'rescued')}</span>}
            <div className="muted small">
              {f.reason && <>{t('为什么是这个分：', 'Why this score: ')}{f.reason}</>}
              {f.stuck && <> · {t('卡在哪：', 'Stuck at: ')}{f.stuck}</>}
              {f.suggestion && <> · {t('建议：', 'Suggestion: ')}{f.suggestion}</>}
            </div>
            {!f.wish_id && (
              <button className="link" onClick={() => onRescue(i)}>
                {t('还是记进许愿池', 'Record it anyway')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}


// 主入口：在这个仓库里开着的 Claude Code 会话里运行 /wishes wish-N。
// The main way in: run /wishes wish-N in a Claude Code session opened in this repository.
function WishCommand({ wish }: { wish: Wish }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const command = wishCommand(wish)
  return (
    <div className="row wish-command">
      <code className="pre">{command}</code>
      <button
        className="primary"
        onClick={() => void navigator.clipboard.writeText(command).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)), () => undefined)}
      >
        {copied ? t('已复制', 'Copied') : t('复制', 'Copy')}
      </button>
      <span className="muted small">
        {t('贴进在这个仓库里开着的 Claude Code。不带编号的 /wishes 会先把全部待处理的愿望分一遍诊。', 'Paste it into a Claude Code session opened in this repository. /wishes without an id first triages every pending wish.')}
      </span>
    </div>
  )
}


// 在这一页里直接和 Claude Code 一起处理这条愿望：开一个会话，第一句话是 /wishes <编号>，以计划模式起步。
// 只在本机有（它能在这台机器上执行命令）；云端这个按钮不出现。
// Handle this wish with Claude Code right on this page: a session opens whose first message is /wishes <id>, starting in plan mode.
// Local only (it can run commands on this machine); in the cloud the button does not appear.
function WishSession({ wish }: { wish: Wish }) {
  const { wish_id: wishId, title } = wish
  const t = useT()
  const [session, setSession] = useState<string | null>(null)
  const [offered, setOffered] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    api.sessions().then(
      (list) => {
        if (!live) return
        setOffered(!list.unavailable)
        // 这条愿望已经有一个没结束的会话，就接着用它。 / If this wish already has a session that has not ended, carry on with it.
        setSession(list.sessions.find((s) => s.wish_id === wishId && s.status !== 'closed')?.id ?? null)
      },
      () => setOffered(false),
    )
    return () => {
      live = false
    }
  }, [wishId])
  if (!offered) return null
  if (session) return <SessionView id={session} />
  return (
    <div className="row wish-command">
      <button
        className="primary"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(null)
          api.startSession({ text: wishCommand(wish), mode: 'plan', wish_id: wishId, title: t(`愿望：${title}`, `Wish: ${title}`) }).then(
            (made) => (setBusy(false), setSession(made.id)),
            (e: Error) => (setBusy(false), setError(e.message)),
          )
        }}
      >
        {busy ? t('正在开会话…', 'Opening a session…') : t('在这里和 Claude Code 一起处理', 'Handle it here with Claude Code')}
      </button>
      <span className="muted small">{t('它先读代码、出计划；计划、改文件、跑命令都等你在这里点头。', 'It reads the code and plans first; the plan, file edits and commands all wait for your nod here.')}</span>
      {error && <span className="err">{error}</span>}
    </div>
  )
}

// 列表页：让 Claude Code 把全部待处理的愿望分一遍诊。 / On the list page: have Claude Code triage every pending wish.
function HandleAll() {
  const t = useT()
  const navigate = useNavigate()
  const [offered, setOffered] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.sessions().then((list) => setOffered(!list.unavailable), () => setOffered(false))
  }, [])
  if (!offered) return null
  return (
    <div className="row wish-command">
      <button onClick={() => void api.startSession({ text: '/wishes', mode: 'plan', title: t('许愿池：分诊', 'Wish pool: triage') }).then((made) => navigate(`/sessions/${made.id}`), (e: Error) => setError(e.message))}>
        {t('让 Claude Code 看一遍全部待处理的', 'Have Claude Code go over everything pending')}
      </button>
      {error && <span className="err">{error}</span>}
    </div>
  )
}
