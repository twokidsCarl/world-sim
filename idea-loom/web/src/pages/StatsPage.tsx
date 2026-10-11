import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { type ProjectStats, type Session, type Stats, api } from '../api'
import type { State, ThreadId } from '../contract'
import { formatTime } from '../state/derive'
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

  const load = (refresh = false) => {
    setBusy(true)
    api.stats(refresh).then(
      (s) => (setStats(s), setError(null), setBusy(false)),
      (e: Error) => (setError(e.message), setBusy(false)),
    )
  }
  useEffect(() => load(), [])

  const names = useMemo(() => stats?.projects.map((p) => p.dir) ?? [], [stats])
  if (error && !stats) return <Page title="统计"><div className="notice bad" role="alert">{error}</div></Page>
  if (!stats) return <Page title="统计"><p className="muted">正在读本机的会话记录和合并请求，要几秒…</p></Page>

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
      title="统计"
      lead="每个项目花了多少、产出多少；Claude Code 每次跑了多久、什么时候停的；你在这个界面里把注意力放在了哪里。数字都是在这台机器上算的，不进仓库。"
      actions={
        <button disabled={busy} onClick={() => load(true)}>
          {busy ? '正在重算…' : '重新算一遍'}
        </button>
      }
    >
      {stats.notes.map((n) => (
        <div key={n} className="notice warn">{n}</div>
      ))}
      <div className="tiles">
        <Tile label="模型输出" value={compact(stats.totals.output)} note={`token · ${compact(stats.totals.messages)} 次回复`} />
        <Tile label="Claude Code 在跑的时间" value={duration(totalActive)} note={`${stats.sessions.length} 个会话`} />
        <Tile label="合并的 PR" value={totalMerged} />
        <Tile label="代码" value={compact(totalLines)} note="行，不算依赖、数据和生成的文件" />
        <Tile label="读缓存" value={compact(stats.totals.cache_read)} note="token，重复读上文的量" />
      </div>

      <Section title="每个项目" note="点表头换排序；条的长短是和这一列里最大的那个比">
        <div className="grid-wrap">
          <table className="table stats-table">
            <thead>
              <tr>
                <th scope="col">项目</th>
                {th('output', '模型输出（token）')}
                {th('active', '在跑的时间')}
                {th('merged', '合并的 PR')}
                {th('lines', '代码行数')}
                {th('per_line', '每行代码用的 token')}
                {th('per_pr', '每个 PR 用的 token')}
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.dir}>
                  <th scope="row">
                    <span className={`swatch ${seriesClass(p.dir, names)}`} aria-hidden="true" /> {p.dir}
                    <div className="muted small">
                      {p.sessions} 个会话
                      {Object.keys(p.by_language).length > 0 &&
                        ` · ${Object.entries(p.by_language).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k).join('、')}`}
                    </div>
                  </th>
                  <td className="r">
                    <span className="num">{compact(p.tokens.output)}</span>
                    <Bar value={p.tokens.output} max={max((x) => x.tokens.output)} className={seriesClass(p.dir, names)} title={`${p.dir}：输出 ${p.tokens.output.toLocaleString()} token`} />
                  </td>
                  <td className="r">
                    <span className="num">{p.active_seconds ? duration(p.active_seconds) : '—'}</span>
                    <Bar value={p.active_seconds} max={max((x) => x.active_seconds)} className={seriesClass(p.dir, names)} />
                  </td>
                  <td className="r">
                    <span className="num">{p.merged || '—'}</span>
                    {p.median_merge_seconds !== null && <div className="muted small">开到合并中位 {duration(p.median_merge_seconds)}</div>}
                  </td>
                  <td className="r">
                    <span className="num">{p.lines ? p.lines.toLocaleString() : '—'}</span>
                    {p.merged > 0 && <div className="muted small num">+{p.additions.toLocaleString()} −{p.deletions.toLocaleString()}</div>}
                  </td>
                  <td className="r num">{p.tokens_per_line ?? '—'}</td>
                  <td className="r num">{p.tokens_per_pr !== null ? compact(p.tokens_per_pr) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Claude Code 的每次运行" note="一条横带是一个会话；实心的段是在跑，中间断开的地方是停下了">
        <Runs sessions={stats.sessions} names={names} />
      </Section>

      <Section title="每天" note="模型输出按项目堆起来">
        <Days stats={stats} names={names} />
      </Section>

      <Section title="你的注意力" note="只统计得到在 idea-loom 里的操作；直接打开子项目自己的界面，那边统计不到">
        <AttentionView stats={stats} state={state} />
      </Section>

      <Section title="idea-loom 自己调用模型" note="生成、细化、翻译、小助手这些">
        {stats.own.calls === 0 ? (
          <Empty>还没有调用过。</Empty>
        ) : (
          <p>
            一共 <span className="num">{stats.own.calls}</span> 次，输出 <span className="num">{compact(stats.own.output_tokens)}</span> token，按接口价折算约{' '}
            <span className="num">{stats.own.cost_usd.toFixed(2)}</span> 美元。
            <span className="muted small"> {Object.entries(stats.own.by_purpose).map(([k, v]) => `${PURPOSE[k] ?? k} ${v} 次`).join(' · ')}</span>
          </p>
        )}
      </Section>
      <p className="muted small">算于 {formatTime(stats.generated_at)}，结果缓存一分钟。</p>
    </Page>
  )
}

const PURPOSE: Record<string, string> = { generate: '生成', refine: '细化', fuse: '融合', classify: '归类', dedupe: '查重', translate: '翻译', assistant: '小助手', review: '回看', job: '作业' }

function Runs({ sessions, names }: { sessions: Session[]; names: string[] }) {
  const [hover, setHover] = useState<string | null>(null)
  if (sessions.length === 0) return <Empty>这台机器上没有这个仓库的会话记录。</Empty>
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
                <span className="run-title">{s.title || '（没有记到第一句话）'}</span>
                <span className="muted small">
                  {s.project} · 跑了 {duration(s.active_seconds)} · {s.prompts} 句话 · {s.tool_calls.toLocaleString()} 次工具 · 输出 {compact(s.tokens.output)} token · 停了{' '}
                  {s.segments.length - 1} 次 · 最后停在 {formatTime(lastStop.end)}
                </span>
              </div>
              <div className="run-track" role="img" aria-label={`${s.title}：${s.segments.length} 段运行`}>
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
                          {formatTime(g.start)} 到 {formatTime(g.end).slice(11)}
                          <br />
                          跑了 {duration(g.seconds)}，输出 {compact(g.output_tokens)} token
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
        <summary>用表格看每一段</summary>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">会话</th>
              <th scope="col">项目</th>
              <th scope="col">开始</th>
              <th scope="col">停下</th>
              <th scope="col" className="r">跑了多久</th>
              <th scope="col" className="r">输出 token</th>
            </tr>
          </thead>
          <tbody>
            {sessions.flatMap((s) =>
              s.segments.map((g, i) => (
                <tr key={`${s.id}:${i}`}>
                  <td>{i === 0 ? s.title : <span className="muted">同上，第 {i + 1} 段</span>}</td>
                  <td>{s.project}</td>
                  <td className="num">{formatTime(g.start)}</td>
                  <td className="num">{formatTime(g.end)}</td>
                  <td className="r num">{duration(g.seconds)}</td>
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
  const days = [...new Set(stats.days.map((d) => d.day))].sort()
  if (days.length === 0) return <Empty>还没有数据。</Empty>
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
                  <span key={d.project} className={seriesClass(d.project, names)} style={{ flexGrow: d.output_tokens }} title={`${d.project}：${d.output_tokens.toLocaleString()} token`} />
                ))}
              </span>
              <span className="muted small num">
                {compact(total(day))} token · 合并 {merged} 个 PR
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
  if (a.total_seconds === 0) return <Empty>还没有记到停留时间。在界面里多看几页，过一会儿再来。</Empty>
  const maxAtt = Math.max(0, ...Object.values(a.cells).flatMap((row) => Object.values(row)))
  const maxCount = Math.max(0, ...Object.values(state.coverage.cells).flatMap((row) => Object.values(row).map((ids) => ids.length)))
  const ladder = state.frame.levels.filter((l) => l.kind === 'ladder')
  const maxIdea = Math.max(1, ...a.ideas.map((i) => i.seconds))
  const pages: Record<string, string> = { '/': '地图', '/ideas': '想法池和 idea 页', '/inbox': '生成与候选', '/lineage': '血缘', '/wishes': '许愿池', '/work': '开发', '/stats': '统计', '/new': '手写一条' }
  const kept = a.proposals_kept + a.proposals_dropped
  return (
    <>
      <div className="tiles">
        <Tile label="看了多久" value={duration(a.total_seconds)} note={`${a.days} 天里，只算窗口在前台且有操作的时间`} />
        <Tile label="点了" value={a.clicks} note="次" />
        <Tile label="问小助手" value={a.questions} note="次" />
        <Tile label="候选" value={kept ? `${a.proposals_kept} / ${kept}` : '—'} note="留下的 / 处理过的" />
        <Tile label="从没打开过" value={a.never_opened.length} note={`条 idea，共 ${state.counts.live} 条`} />
      </div>
      <div className="heat-pair">
        {(['注意力：在每一格的 idea 页上停了多久', '对照：每一格有几条 idea'] as const).map((title, which) => (
          <figure key={title} className="heat-fig">
            <figcaption>{title}</figcaption>
            <table className="heat">
              <thead>
                <tr>
                  <th />
                  {THREADS.map((t) => (
                    <th key={t} scope="col">{t}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ladder.map((l) => (
                  <tr key={l.id}>
                    <th scope="row">{l.id}</th>
                    {THREADS.map((t) => {
                      const seconds = a.cells[l.id]?.[t] ?? 0
                      const count = state.coverage.cells[l.id]?.[t]?.length ?? 0
                      const level = which === 0 ? heat(seconds, maxAtt) : heat(count, maxCount)
                      const label = which === 0 ? (seconds ? duration(seconds) : '') : count ? String(count) : ''
                      return (
                        <td key={t} className={`h${level}`} title={`${l.id} ${l.name} · ${t}：${which === 0 ? duration(seconds) : `${count} 条`}`}>
                          <Link to={`/ideas?level=${l.id}&threads=${t}`}>{label || '·'}</Link>
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
      <p className="muted small">两张图形状一样、颜色各自按自己的最大值分五档。左边浅而右边深的格子，是条数不少却没怎么看过的。</p>

      <div className="halves">
        <div>
          <h3 className="sub">看得最久的 idea</h3>
          <ul className="plain att-ideas">
            {a.ideas.slice(0, 10).map((i) => (
              <li key={i.id}>
                <IdeaLink id={i.id} state={state} />
                <Bar value={i.seconds} max={maxIdea} className="series-1" />
                <span className="muted small num">
                  {duration(i.seconds)} · 打开 {i.opens} 次
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="sub">时间花在哪些页面</h3>
          <ul className="plain att-ideas">
            {Object.entries(a.by_page).sort((x, y) => y[1] - x[1]).map(([page, seconds]) => (
              <li key={page}>
                <span>{pages[page] ?? page}</span>
                <Bar value={seconds} max={a.total_seconds} className="series-1" />
                <span className="muted small num">{duration(seconds)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <button onClick={() => setShowNever(!showNever)}>{showNever ? '收起' : `看从没打开过的 ${a.never_opened.length} 条`}</button>
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
