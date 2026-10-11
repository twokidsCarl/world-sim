import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { type WishDetail, type WishList, api } from '../api'
import { useAssistant } from '../assistant/store'
import { formatTime } from '../state/derive'
import { Empty, Page, Section } from '../ui/Page'

const TONE: Record<string, string> = { open: 'w-open', accepted: 'w-accepted', done: 'w-done', declined: 'w-quiet', withdrawn: 'w-quiet' }
const MARK: Record<string, string> = { open: '○', accepted: '◐', done: '●', declined: '⊘', withdrawn: '×' }

export function WishBadge({ status, label }: { status: string; label: string }) {
  return (
    <span className={`badge ${TONE[status] ?? ''}`}>
      <span aria-hidden="true">{MARK[status]}</span> {label}
    </span>
  )
}

export function WishesPage() {
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? ''
  const [list, setList] = useState<WishList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const restored = params.get('withdrawn')

  useEffect(() => {
    api.wishes(status).then(setList, (e: Error) => setError(e.message))
  }, [status, restored])

  const total = list ? Object.values(list.counts).reduce((a, b) => a + b, 0) : 0
  return (
    <Page title="许愿池" lead={'对 idea-loom 这个工具本身的改进愿望。愿望不是在这里填的：和右边的小助手说话时，它发现工具哪里不顺手就会记一条，你也可以直接跟它说"把这个记下来"。'}>
      {error && <div className="notice bad" role="alert">{error}</div>}
      {restored && (
        <div className="notice good" role="status">
          已撤销。{' '}
          <button onClick={() => void api.restoreWish(restored).then(() => setParams({}))}>恢复</button>{' '}
          <button onClick={() => setParams({})}>知道了</button>
        </div>
      )}
      {list && (
        <>
          <div className="wish-counts" role="group" aria-label="按状态筛选">
            <button aria-pressed={status === ''} onClick={() => setParams({})}>
              待处理 <span className="num">{(list.counts.open ?? 0) + (list.counts.accepted ?? 0)}</span>
            </button>
            {Object.entries(list.statuses).map(([key, label]) => (
              <button key={key} aria-pressed={status === key} onClick={() => setParams({ status: key })}>
                <span aria-hidden="true">{MARK[key]}</span> {label} <span className="num">{list.counts[key] ?? 0}</span>
              </button>
            ))}
          </div>
          {list.wishes.length > 0 && (
            <div className="wish-kinds" aria-label="按种类">
              {Object.entries(list.kind_labels)
                .filter(([key]) => (list.kinds[key] ?? 0) > 0)
                .map(([key, label]) => (
                  <div key={key} className="wish-kind">
                    <span>{label}</span>
                    <span className="bar" aria-hidden="true">
                      <span style={{ width: `${((list.kinds[key] ?? 0) / list.wishes.length) * 100}%` }} />
                    </span>
                    <span className="num">{list.kinds[key]}</span>
                  </div>
                ))}
            </div>
          )}
          {list.unreadable > 0 && <div className="notice warn">愿望记录里有 {list.unreadable} 行读不出来，已跳过。</div>}
          {list.wishes.length === 0 ? (
            <Empty>{total === 0 ? '还没有愿望。打开右下角的小助手，问它点什么，或者告诉它哪里不顺手。' : '这个状态下没有愿望。'}</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">愿望</th>
                  <th scope="col">种类</th>
                  <th scope="col">出在哪一页</th>
                  <th scope="col" className="r">遇到几次</th>
                  <th scope="col">状态</th>
                  <th scope="col">最近变化</th>
                </tr>
              </thead>
              <tbody>
                {list.wishes.map((w) => (
                  <tr key={w.wish_id}>
                    <td>
                      <Link to={`/wishes/${w.wish_id}`}>{w.title}</Link>
                    </td>
                    <td className="muted">{w.kind_label}</td>
                    <td>{w.where?.url ? <Link to={w.where.url}>{w.where.title || w.where.url}</Link> : <span className="muted">—</span>}</td>
                    <td className="r num">{w.occurrences}</td>
                    <td>
                      <WishBadge status={w.status} label={w.status_label} />
                      {w.pr != null && <span className="muted small"> 合并请求 #{w.pr}</span>}
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

  const reload = () => api.wish(id).then(setWish, (e: Error) => setError(e.message))
  useEffect(() => {
    setWish(null)
    setError(null)
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  if (error && !wish) return <Page title="愿望"><div className="notice bad" role="alert">{error}</div></Page>
  if (!wish) return <Page title="愿望"><p className="muted">正在读取…</p></Page>
  const open = wish.status === 'open'

  return (
    <Page
      title={wish.title}
      lead={`${wish.kind_label} · 遇到 ${wish.occurrences} 次`}
      actions={
        open &&
        !editing && (
          <div className="row">
            <button onClick={() => (setDraft({ title: wish.title, stuck: wish.stuck, suggestion: wish.suggestion }), setEditing(true))}>改写</button>
            <button
              onClick={() =>
                void api.withdrawWish(wish.wish_id).then(() => {
                  void refresh()
                  navigate(`/wishes?withdrawn=${wish.wish_id}`)
                }, (e: Error) => setError(e.message))
              }
            >
              撤销
            </button>
          </div>
        )
      }
    >
      <div className="meta-row">
        <WishBadge status={wish.status} label={wish.status_label} />
        {wish.status_note && <span className="muted">{wish.status_note}</span>}
        <span className="muted small">记于 {formatTime(wish.created_at)}</span>
        <span className="muted small">最近变化 {formatTime(wish.updated_at)}</span>
        {wish.where?.url && (
          <span className="small">
            出在 <Link to={wish.where.url}>{wish.where.title || wish.where.url}</Link>
          </span>
        )}
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      {!open && wish.status !== 'withdrawn' && (
        <p className="muted small after-meta">已经是"{wish.status_label}"，不能再改写或撤销。还想改，跟处理它的 Claude 说，或者让小助手另记一条。</p>
      )}
      {wish.status === 'withdrawn' && (
        <p className="after-meta">
          <button onClick={() => void api.restoreWish(wish.wish_id).then(() => (void reload(), void refresh()))}>恢复这条愿望</button>
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
            一句话
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </label>
          <label>
            卡在哪
            <textarea rows={3} value={draft.stuck} onChange={(e) => setDraft({ ...draft, stuck: e.target.value })} />
          </label>
          <label>
            建议怎么改
            <textarea rows={3} value={draft.suggestion} onChange={(e) => setDraft({ ...draft, suggestion: e.target.value })} />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={!draft.title.trim()}>
              保存
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </form>
      ) : (
        <div className="halves">
          <Section title="卡在哪">
            <p className="pre">{wish.stuck || '（没有写）'}</p>
          </Section>
          <Section title="建议">
            <p className="pre">{wish.suggestion || '（没有写）'}</p>
          </Section>
        </div>
      )}

      <div className="halves">
        <Section title="方案和合并请求" note="由处理它的 Claude Code 标回来，这里只显示">
          {wish.links.length === 0 ? (
            <Empty>还没有。</Empty>
          ) : (
            <ul className="plain">
              {wish.links.map((l, i) => (
                <li key={i}>
                  <span className="badge">{l.kind === 'pr' ? `合并请求${l.pr != null ? ` #${l.pr}` : ''}` : l.kind === 'plan' ? '方案' : '作业'}</span>{' '}
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
        <Section title="说明" note="最近的在前">
          {wish.notes.length === 0 ? (
            <Empty>还没有。</Empty>
          ) : (
            <ul className="plain">
              {wish.notes.map((n, i) => (
                <li key={i}>
                  <span className="pre">{n.text}</span>{' '}
                  <span className="muted small">
                    {n.by_label} · {formatTime(n.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title="交给 Claude 去做">
        <p className="muted">
          以后可以在这里点"开工"让 Claude Code 先出方案、你批准后再动手（还没有做好）。现在可以把下面这句话贴到一个新的 Claude Code 会话里，
          它用命令 <code>idea-loom wishes</code> 把采纳、做完、不做标回来。
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
              {copied ? '已复制' : '复制这句话'}
            </button>
          </figcaption>
        </figure>
      </Section>

      <Section title="遇到的每一次" note={`${wish.seen.length} 次`}>
        <ul className="plain">
          {wish.seen.map((s, i) => (
            <li key={i}>
              <span className="muted small">{formatTime(s.at)}</span> {s.question || '（没有记下当时的问题）'}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="经过">
        <ol className="history">
          {wish.history.map((h, i) => (
            <li key={i} className="hist">
              <div className="hist-head">
                <span className="badge">{h.event_label}</span>
                <span>{h.text}</span>
                <span className="muted small">
                  {formatTime(h.at)} · {h.by_label}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </Section>
    </Page>
  )
}
