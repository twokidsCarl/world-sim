import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { type ProjectStats, type Session, type Stats, api } from '../api'
import type { State, ThreadId } from '../contract'
import { pick, plural } from '../i18n'
import { formatTime } from '../state/derive'
import { useLang, useT } from '../state/store'
import { Empty, Page, Section } from '../ui/Page'
import { IdeaLink } from '../ui/bits'
import { Bar, Legend, Tile, compact, duration, heat, seriesClass } from '../ui/viz'

const THREADS: ThreadId[] = ['A', 'B', 'C', 'D', 'E']
type SortKey = 'output' | 'active' | 'merged' | 'lines' | 'per_line' | 'per_pr'
const SORTS: Record<SortKey, (p: ProjectStats) => number> = {
  output: (p) => p.tokens.output,
  active: (p) => p.active_seconds,
  merged: (p) => p.merged,
  lines: (p) => p.lines,
  per_line: (p) => p.tokens_per_line ?? -1,
  per_pr: (p) => p.tokens_per_pr ?? -1,
}

export function StatsPage({ state }: { state: State }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sort, setSort] = useState<SortKey>('output')
  const lang = useLang()
  const t = useT()

  const load = (refresh = false) => {
    setBusy(true)
    api.stats(refresh).then(
      (s) => (setStats(s), setError(null), setBusy(false)),
      (e: Error) => (setError(e.message), setBusy(false)),
    )
  }
  useEffect(() => load(), [])

  const names = useMemo(() => stats?.projects.map((p) => p.dir) ?? [], [stats])
  if (error && !stats) return <Page title={t('统计', 'Statistics')}><div className="notice bad" role="alert">{error}</div></Page>
  if (!stats) return <Page title={t('统计', 'Statistics')}><p className="muted">{t('正在读本机的会话记录和合并请求，要几秒…', 'Reading the session records on this machine and the pull requests; this takes a few seconds…')}</p></Page>

  const projects = [...stats.projects].sort((a, b) => SORTS[sort](b) - SORTS[sort](a))
  const max = (f: (p: ProjectStats) => number) => Math.max(1, ...stats.projects.map(f))
  const totalMerged = stats.projects.reduce((n, p) => n + p.merged, 0)
  const totalLines = stats.projects.reduce((n, p) => n + p.lines, 0)
  const totalActive = stats.sessions.reduce((n, s) => n + s.active_seconds, 0)
  const th = (key: SortKey, label: string) => (
    <th scope="col" className="r" aria-sort={sort === key ? 'descending' : 'none'}>
      <button className="th-sort" onClick={() => setSort(key)}>
        {label}
        {sort === key && ' ↓'}
      </button>
    </th>
  )

  return (
    <Page
      title={t('统计', 'Statistics')}
      lead={t(
        '每个项目花了多少、产出多少；Claude Code 每次跑了多久、什么时候停的；你在这个界面里把注意力放在了哪里。数字都是在这台机器上算的，不进仓库。',
        'What each project cost and produced; how long each Claude Code run lasted and when it stopped; where your attention went in this UI. All numbers are computed on this machine and never enter the repository.',
      )}
      actions={
        <button disabled={busy} onClick={() => load(true)}>
          {busy ? t('正在重算…', 'Recomputing…') : t('重新算一遍', 'Recompute')}
        </button>
      }
    >
      {stats.notes.map((n) => (
        <div key={n} className="notice warn">{n}</div>
      ))}
      <div className="tiles">
        <Tile label={t('模型输出', 'Model output')} value={compact(stats.totals.output, lang)} note={t(`token · ${compact(stats.totals.messages, lang)} 次回复`, `tokens · ${compact(stats.totals.messages, lang)} replies`)} />
        <Tile label={t('Claude Code 在跑的时间', 'Claude Code running time')} value={duration(totalActive, lang)} note={t(`${stats.sessions.length} 个会话`, plural(stats.sessions.length, 'session'))} />
        <Tile label={t('合并的 PR', 'Merged PRs')} value={totalMerged} />
        <Tile label={t('代码', 'Code')} value={compact(totalLines, lang)} note={t('行，不算依赖、数据和生成的文件', 'lines, not counting dependencies, data and generated files')} />
        <Tile label={t('读缓存', 'Cache reads')} value={compact(stats.totals.cache_read, lang)} note={t('token，重复读上文的量', 'tokens, the context read again')} />
      </div>

      <Section title={t('每个项目', 'By project')} note={t('点表头换排序；条的长短是和这一列里最大的那个比', 'Click a header to sort; bar lengths are relative to the largest in the column')}>
        <div className="grid-wrap">
          <table className="table stats-table">
            <thead>
              <tr>
                <th scope="col">{t('项目', 'Project')}</th>
                {th('output', t('模型输出（token）', 'Model output (tokens)'))}
                {th('active', t('在跑的时间', 'Running time'))}
                {th('merged', t('合并的 PR', 'Merged PRs'))}
                {th('lines', t('代码行数', 'Lines of code'))}
                {th('per_line', t('每行代码用的 token', 'Tokens per line'))}
                {th('per_pr', t('每个 PR 用的 token', 'Tokens per PR'))}
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.dir}>
                  <th scope="row">
                    <span className={`swatch ${seriesClass(p.dir, names)}`} aria-hidden="true" /> {p.dir}
                    <div className="muted small">
                      {t(`${p.sessions} 个会话`, plural(p.sessions, 'session'))}
                      {Object.keys(p.by_language).length > 0 &&
                        ` · ${Object.entries(p.by_language).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k).join(t('、', ', '))}`}
                    </div>
                  </th>
                  <td className="r">
                    <span className="num">{compact(p.tokens.output, lang)}</span>
                    <Bar value={p.tokens.output} max={max((x) => x.tokens.output)} className={seriesClass(p.dir, names)} title={t(`${p.dir}：输出 ${p.tokens.output.toLocaleString()} token`, `${p.dir}: ${p.tokens.output.toLocaleString()} output tokens`)} />
                  </td>
                  <td className="r">
                    <span className="num">{p.active_seconds ? duration(p.active_seconds, lang) : '—'}</span>
                    <Bar value={p.active_seconds} max={max((x) => x.active_seconds)} className={seriesClass(p.dir, names)} />
                  </td>
                  <td className="r">
                    <span className="num">{p.merged || '—'}</span>
                    {p.median_merge_seconds !== null && <div className="muted small">{t('开到合并中位', 'median open to merge')} {duration(p.median_merge_seconds, lang)}</div>}
                  </td>
                  <td className="r">
                    <span className="num">{p.lines ? p.lines.toLocaleString() : '—'}</span>
                    {p.merged > 0 && <div className="muted small num">+{p.additions.toLocaleString()} −{p.deletions.toLocaleString()}</div>}
                  </td>
                  <td className="r num">{p.tokens_per_line ?? '—'}</td>
                  <td className="r num">{p.tokens_per_pr !== null ? compact(p.tokens_per_pr, lang) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={t('Claude Code 的每次运行', 'Each Claude Code run')} note={t('一条横带是一个会话；实心的段是在跑，中间断开的地方是停下了', 'One band is one session; solid segments are running time, gaps are where it stopped')}>
        <Runs sessions={stats.sessions} names={names} />
      </Section>

      <Section title={t('每天', 'By day')} note={t('模型输出按项目堆起来', 'Model output stacked by project')}>
        <Days stats={stats} names={names} />
      </Section>

      <Section title={t('你的注意力', 'Your attention')} note={t('只统计得到在 idea-loom 里的操作；直接打开子项目自己的界面，那边统计不到', 'Only what you do inside idea-loom is counted; a subproject UI opened directly is not')}>
        <AttentionView stats={stats} state={state} />
      </Section>

      <Section title={t('idea-loom 自己调用模型', 'Model calls by idea-loom itself')} note={t('生成、细化、翻译、小助手这些', 'Generate, refine, translate, the assistant and so on')}>
        {stats.own.calls === 0 ? (
          <Empty>{t('还没有调用过。', 'No calls yet.')}</Empty>
        ) : (
          <p>
            {t('一共 ', '')}<span className="num">{stats.own.calls}</span>{t(' 次，输出 ', stats.own.calls === 1 ? ' call, ' : ' calls, ')}
            <span className="num">{compact(stats.own.output_tokens, lang)}</span>{t(' token，按接口价折算约', ' output tokens, about')}{' '}
            <span className="num">{t('', '$')}{stats.own.cost_usd.toFixed(2)}</span>{t(' 美元。', ' at API prices.')}
            <span className="muted small"> {Object.entries(stats.own.by_purpose).map(([k, v]) => `${PURPOSE[k] ? t(...PURPOSE[k]) : k} ${t(`${v} 次`, `× ${v}`)}`).join(' · ')}</span>
          </p>
        )}
      </Section>
      <p className="muted small">{t(`算于 ${formatTime(stats.generated_at)}，结果缓存一分钟。`, `Computed at ${formatTime(stats.generated_at)}; results are cached for a minute.`)}</p>
    </Page>
  )
}

// 调用模型的各种用途：[中文, 英文]。 / What the model was called for: [Chinese, English].
const PURPOSE: Record<string, [string, string]> = {
  generate: ['生成', 'Generate'], refine: ['细化', 'Refine'], fuse: ['融合', 'Fuse'], classify: ['归类', 'Classify'], dedupe: ['查重', 'Find duplicates'],
  translate: ['翻译', 'Translate'], assistant: ['小助手', 'Assistant'], review: ['回看', 'Review'], job: ['作业', 'Job'],
}

function Runs({ sessions, names }: { sessions: Session[]; names: string[] }) {
  const [hover, setHover] = useState<string | null>(null)
  const lang = useLang()
  const t = useT()
  if (sessions.length === 0) return <Empty>{t('这台机器上没有这个仓库的会话记录。', 'No session records for this repository on this machine.')}</Empty>
  const t0 = Math.min(...sessions.map((s) => Date.parse(s.first_at)))
  const t1 = Math.max(...sessions.map((s) => Date.parse(s.last_at)))
  const span = Math.max(1, t1 - t0)
  const pct = (iso: string) => ((Date.parse(iso) - t0) / span) * 100
  const projects = [...new Set(sessions.map((s) => s.project))]
  return (
    <>
      <Legend items={projects.map((p) => ({ label: p, className: seriesClass(p, names) }))} />
      <div className="runs">
        <div className="runs-axis muted small">
          <span>{formatTime(new Date(t0).toISOString())}</span>
          <span>{formatTime(new Date(t1).toISOString())}</span>
        </div>
        {sessions.map((s) => {
          const lastStop = s.segments[s.segments.length - 1]!
          return (
            <div key={s.id} className="run">
              <div className="run-head">
                <span className="run-title">{s.title || t('（没有记到第一句话）', '(first message not recorded)')}</span>
                <span className="muted small">
                  {s.project} ·{' '}
                  {t(
                    `跑了 ${duration(s.active_seconds, lang)} · ${s.prompts} 句话 · ${s.tool_calls.toLocaleString()} 次工具 · 输出 ${compact(s.tokens.output, lang)} token · 停了 ${s.segments.length - 1} 次 · 最后停在 ${formatTime(lastStop.end)}`,
                    `ran ${duration(s.active_seconds, lang)} · ${plural(s.prompts, 'prompt')} · ${s.tool_calls.toLocaleString()} tool ${s.tool_calls === 1 ? 'call' : 'calls'} · ${compact(s.tokens.output, lang)} output tokens · stopped ${plural(s.segments.length - 1, 'time')} · last stop ${formatTime(lastStop.end)}`,
                  )}
                </span>
              </div>
              <div className="run-track" role="img" aria-label={t(`${s.title}：${s.segments.length} 段运行`, `${s.title}: ${plural(s.segments.length, 'run segment')}`)}>
                {s.segments.map((g, i) => {
                  const key = `${s.id}:${i}`
                  return (
                    <span
                      key={i}
                      tabIndex={0}
                      className={`run-seg ${seriesClass(s.project, names)}`}
                      style={{ left: `${pct(g.start)}%`, width: `max(4px, ${pct(g.end) - pct(g.start)}%)` }}
                      onMouseEnter={() => setHover(key)}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover(key)}
                      onBlur={() => setHover(null)}
                    >
                      {hover === key && (
                        <span className="tip" role="tooltip">
                          {formatTime(g.start)} {t('到', 'to')} {formatTime(g.end).slice(11)}
                          <br />
                          {t(`跑了 ${duration(g.seconds, lang)}，输出 ${compact(g.output_tokens, lang)} token`, `ran ${duration(g.seconds, lang)}, ${compact(g.output_tokens, lang)} output tokens`)}
                        </span>
                      )}
                    </span>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <details className="table-view">
        <summary>{t('用表格看每一段', 'See every segment as a table')}</summary>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('会话', 'Session')}</th>
              <th scope="col">{t('项目', 'Project')}</th>
              <th scope="col">{t('开始', 'Start')}</th>
              <th scope="col">{t('停下', 'Stop')}</th>
              <th scope="col" className="r">{t('跑了多久', 'Ran for')}</th>
              <th scope="col" className="r">{t('输出 token', 'Output tokens')}</th>
            </tr>
          </thead>
          <tbody>
            {sessions.flatMap((s) =>
              s.segments.map((g, i) => (
                <tr key={`${s.id}:${i}`}>
                  <td>{i === 0 ? s.title : <span className="muted">{t(`同上，第 ${i + 1} 段`, `Same, segment ${i + 1}`)}</span>}</td>
                  <td>{s.project}</td>
                  <td className="num">{formatTime(g.start)}</td>
                  <td className="num">{formatTime(g.end)}</td>
                  <td className="r num">{duration(g.seconds, lang)}</td>
                  <td className="r num">{g.output_tokens.toLocaleString()}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </details>
    </>
  )
}

function Days({ stats, names }: { stats: Stats; names: string[] }) {
  const lang = useLang()
  const t = useT()
  const days = [...new Set(stats.days.map((d) => d.day))].sort()
  if (days.length === 0) return <Empty>{t('还没有数据。', 'No data yet.')}</Empty>
  const total = (day: string) => stats.days.filter((d) => d.day === day).reduce((n, d) => n + d.output_tokens, 0)
  const max = Math.max(1, ...days.map(total))
  const projects = [...new Set(stats.days.filter((d) => d.output_tokens > 0).map((d) => d.project))]
  return (
    <>
      <Legend items={projects.map((p) => ({ label: p, className: seriesClass(p, names) }))} />
      <div className="days">
        {days.map((day) => {
          const rows = stats.days.filter((d) => d.day === day)
          const merged = rows.reduce((n, d) => n + d.merged, 0)
          return (
            <div key={day} className="day">
              <span className="num">{day}</span>
              <span className="day-stack" style={{ width: `${(total(day) / max) * 100}%` }}>
                {rows.filter((d) => d.output_tokens > 0).map((d) => (
                  <span key={d.project} className={seriesClass(d.project, names)} style={{ flexGrow: d.output_tokens }} title={t(`${d.project}：${d.output_tokens.toLocaleString()} token`, `${d.project}: ${d.output_tokens.toLocaleString()} tokens`)} />
                ))}
              </span>
              <span className="muted small num">
                {t(`${compact(total(day), lang)} token · 合并 ${merged} 个 PR`, `${compact(total(day), lang)} tokens · ${plural(merged, 'PR')} merged`)}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}

function AttentionView({ stats, state }: { stats: Stats; state: State }) {
  const a = stats.attention
  const [showNever, setShowNever] = useState(false)
  const lang = useLang()
  const t = useT()
  if (a.total_seconds === 0) return <Empty>{t('还没有记到停留时间。在界面里多看几页，过一会儿再来。', 'No dwell time recorded yet. Look at a few more pages and come back in a while.')}</Empty>
  const maxAtt = Math.max(0, ...Object.values(a.cells).flatMap((row) => Object.values(row)))
  const maxCount = Math.max(0, ...Object.values(state.coverage.cells).flatMap((row) => Object.values(row).map((ids) => ids.length)))
  const ladder = state.frame.levels.filter((l) => l.kind === 'ladder')
  const maxIdea = Math.max(1, ...a.ideas.map((i) => i.seconds))
  const pages: Record<string, string> = {
    '/': t('地图', 'Map'), '/ideas': t('想法池和 idea 页', 'Idea pool and idea pages'), '/inbox': t('生成与候选', 'Generate & candidates'), '/lineage': t('血缘', 'Lineage'),
    '/wishes': t('许愿池', 'Wish pool'), '/work': t('开发', 'Work'), '/stats': t('统计', 'Statistics'), '/new': t('手写一条', 'Write one'),
  }
  const kept = a.proposals_kept + a.proposals_dropped
  return (
    <>
      <div className="tiles">
        <Tile label={t('看了多久', 'Time spent')} value={duration(a.total_seconds, lang)} note={t(`${a.days} 天里，只算窗口在前台且有操作的时间`, `over ${plural(a.days, 'day')}; only time with the window in front and some activity`)} />
        <Tile label={t('点了', 'Clicks')} value={a.clicks} note={t('次', 'in all')} />
        <Tile label={t('问小助手', 'Questions to the assistant')} value={a.questions} note={t('次', 'in all')} />
        <Tile label={t('候选', 'Candidates')} value={kept ? `${a.proposals_kept} / ${kept}` : '—'} note={t('留下的 / 处理过的', 'kept / decided')} />
        <Tile label={t('从没打开过', 'Never opened')} value={a.never_opened.length} note={t(`条 idea，共 ${state.counts.live} 条`, `ideas, of ${state.counts.live}`)} />
      </div>
      <div className="heat-pair">
        {[t('注意力：在每一格的 idea 页上停了多久', 'Attention: time spent on the idea pages of each cell'), t('对照：每一格有几条 idea', 'For comparison: ideas in each cell')].map((title, which) => (
          <figure key={title} className="heat-fig">
            <figcaption>{title}</figcaption>
            <table className="heat">
              <thead>
                <tr>
                  <th />
                  {THREADS.map((id) => (
                    <th key={id} scope="col">{id}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ladder.map((l) => (
                  <tr key={l.id}>
                    <th scope="row">{l.id}</th>
                    {THREADS.map((id) => {
                      const seconds = a.cells[l.id]?.[id] ?? 0
                      const count = state.coverage.cells[l.id]?.[id]?.length ?? 0
                      const level = which === 0 ? heat(seconds, maxAtt) : heat(count, maxCount)
                      const label = which === 0 ? (seconds ? duration(seconds, lang) : '') : count ? String(count) : ''
                      return (
                        <td key={id} className={`h${level}`} title={`${l.id} ${pick(lang, l.name, l.name_en)} · ${id}${t('：', ': ')}${which === 0 ? duration(seconds, lang) : t(`${count} 条`, plural(count, 'idea'))}`}>
                          <Link to={`/ideas?level=${l.id}&threads=${id}`}>{label || '·'}</Link>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </figure>
        ))}
      </div>
      <p className="muted small">{t('两张图形状一样、颜色各自按自己的最大值分五档。左边浅而右边深的格子，是条数不少却没怎么看过的。', 'The two grids have the same shape; each is shaded in five steps against its own maximum. A cell that is light on the left and dark on the right holds plenty of ideas you have hardly looked at.')}</p>

      <div className="halves">
        <div>
          <h3 className="sub">{t('看得最久的 idea', 'Ideas looked at longest')}</h3>
          <ul className="plain att-ideas">
            {a.ideas.slice(0, 10).map((i) => (
              <li key={i.id}>
                <IdeaLink id={i.id} state={state} />
                <Bar value={i.seconds} max={maxIdea} className="series-1" />
                <span className="muted small num">
                  {duration(i.seconds, lang)} · {t(`打开 ${i.opens} 次`, `opened ${plural(i.opens, 'time')}`)}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="sub">{t('时间花在哪些页面', 'Where the time went, by page')}</h3>
          <ul className="plain att-ideas">
            {Object.entries(a.by_page).sort((x, y) => y[1] - x[1]).map(([page, seconds]) => (
              <li key={page}>
                <span>{pages[page] ?? page}</span>
                <Bar value={seconds} max={a.total_seconds} className="series-1" />
                <span className="muted small num">{duration(seconds, lang)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <button onClick={() => setShowNever(!showNever)}>{showNever ? t('收起', 'Collapse') : t(`看从没打开过的 ${a.never_opened.length} 条`, `Show the ${a.never_opened.length} never opened`)}</button>
      {showNever && (
        <ul className="plain never">
          {a.never_opened.map((id) => (
            <li key={id}>
              <IdeaLink id={id} state={state} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
