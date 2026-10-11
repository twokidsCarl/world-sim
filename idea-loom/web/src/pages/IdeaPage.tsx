import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { api } from '../api'
import type { HistoryItem, IdeaDetail, Link as Edge, State } from '../contract'
import { formatTime } from '../state/derive'
import { Empty, Page, Section } from '../ui/Page'
import { IdeaLink, StatusBadge, ThreadChips, levelName } from '../ui/bits'

export function IdeaPage({ state }: { state: State }) {
  const { id = '' } = useParams()
  const [idea, setIdea] = useState<IdeaDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setIdea(null)
    setError(null)
    api.idea(id).then(
      (d) => live && setIdea(d),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [id, state])

  if (error) return <Page title={id}><div className="notice bad" role="alert">{error}</div></Page>
  if (!idea) return <Page title={id}><p className="muted">正在读取…</p></Page>

  const kernel = state.frame.kernels.find((k) => k.name === idea.kernel)
  const projects = state.projects.filter((p) => (idea.projects ?? []).includes(p.dir))

  return (
    <Page title={`${idea.id} ${idea.title}`} lead={kernel ? `${levelName(state, idea.level)} · ${kernel.name}` : levelName(state, idea.level)}>
      <div className="meta-row">
        <StatusBadge idea={idea} />
        {idea.merged_into && (
          <span>
            并入了 <IdeaLink id={idea.merged_into} state={state} />
          </span>
        )}
        {idea.reason && <span className="muted">原因：{idea.reason}</span>}
        <span className="muted small">创建于 {formatTime(idea.created_at)}</span>
        {(idea.versions ?? 1) > 1 && <span className="muted small">改写过 {(idea.versions ?? 1) - 1} 次</span>}
      </div>

      <div className="two-col">
        <div>
          <Section title="正文" note="这段就是给 Claude 的输入">
            <Prompt text={idea.prompt_text} />
          </Section>

          <Section title="血缘" note="它从哪来，谁接着它">
            <Lineage idea={idea} state={state} />
          </Section>

          <Section title="历史" note={`${idea.history.length} 件事，最近的在前`}>
            <ol className="history">
              {idea.history.map((h, i) => (
                <HistoryRow key={i} item={h} />
              ))}
            </ol>
          </Section>
        </div>

        <aside>
          <Section title="位置">
            <dl className="facts">
              <dt>层</dt>
              <dd>
                <Link to={`/ideas?level=${idea.level}`}>{levelName(state, idea.level)}</Link>
              </dd>
              <dt>横线</dt>
              <dd>
                <ThreadChips threads={idea.threads} state={state} />
              </dd>
              <dt>内核</dt>
              <dd>
                {kernel ? (
                  <>
                    <Link to={`/ideas?kernel=${encodeURIComponent(kernel.name)}`}>{kernel.name}</Link>
                    <div className="muted small">{kernel.desc}</div>
                  </>
                ) : (
                  <span className="muted">还没归类</span>
                )}
              </dd>
            </dl>
          </Section>

          <Section title="相关的子项目">
            {projects.length === 0 ? (
              <Empty>正文里没有提到已有的子项目。</Empty>
            ) : (
              <ul className="plain">
                {projects.map((p) => (
                  <li key={p.dir}>
                    <Link to={`/ideas?project=${p.dir}`} className="chip project">
                      {p.dir}
                    </Link>{' '}
                    <span className="muted small">{p.tagline}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="来历">
            <dl className="facts">
              <dt>怎么来的</dt>
              <dd>{idea.origin?.subject ?? state.labels.by?.[idea.origin?.how ?? ''] ?? idea.origin?.how}</dd>
              {idea.origin?.pr != null && (
                <>
                  <dt>合并请求</dt>
                  <dd>
                    <a href={`https://github.com/twokidsCarl/world-sim/pull/${idea.origin.pr}`} target="_blank" rel="noreferrer">
                      #{idea.origin.pr}
                    </a>
                  </dd>
                </>
              )}
            </dl>
          </Section>
        </aside>
      </div>
    </Page>
  )
}

function Prompt({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }
  return (
    <figure className="prompt">
      <blockquote>
        {text.split('\n').map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </blockquote>
      <figcaption>
        <button onClick={() => void copy()}>{copied ? '已复制' : '复制给 Claude'}</button>
        <span className="muted small">贴到一个新的 Claude Code 会话里，它会从这段开始规划。</span>
      </figcaption>
    </figure>
  )
}

const UP: Record<string, string> = { merged_into: '并入了它的', mentions: '它提到的', refined_from: '细化自', fused_from: '融合自', split_from: '拆分自' }
const DOWN: Record<string, string> = { merged_into: '它并入了', mentions: '提到它的', refined_from: '细化出的', fused_from: '融合成了', split_from: '拆分出的' }

function Lineage({ idea, state }: { idea: IdeaDetail; state: State }) {
  const group = (edges: Edge[], pick: (e: Edge) => string) => {
    const out = new Map<string, string[]>()
    for (const e of edges) out.set(e.kind, [...(out.get(e.kind) ?? []), pick(e)])
    return [...out.entries()]
  }
  const up = group(idea.links_in, (e) => e.source)
  const down = group(idea.links_out, (e) => e.target)
  if (up.length === 0 && down.length === 0) return <Empty>这条 idea 现在和别的没有连线。</Empty>
  return (
    <div className="lineage">
      <div className="lin-col">
        <div className="lin-label">上游</div>
        {up.length === 0 && <span className="muted small">没有</span>}
        {up.map(([kind, ids]) => (
          <LinGroup key={kind} label={UP[kind] ?? kind} ids={ids} state={state} />
        ))}
      </div>
      <div className="lin-self" aria-hidden="true">
        <span className="arrow">→</span>
        <span className="self num">{idea.id}</span>
        <span className="arrow">→</span>
      </div>
      <div className="lin-col">
        <div className="lin-label">下游</div>
        {down.length === 0 && <span className="muted small">没有</span>}
        {down.map(([kind, ids]) => (
          <LinGroup key={kind} label={DOWN[kind] ?? kind} ids={ids} state={state} />
        ))}
      </div>
    </div>
  )
}

function LinGroup({ label, ids, state }: { label: string; ids: string[]; state: State }) {
  return (
    <div className="lin-group">
      <div className="muted small">{label}</div>
      <ul className="plain">
        {ids.map((id) => (
          <li key={id}>
            <IdeaLink id={id} state={state} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function HistoryRow({ item }: { item: HistoryItem }) {
  const changed = item.event === 'edited' && item.before && item.after
  return (
    <li className={`hist hist-${item.event}`}>
      <div className="hist-head">
        <span className="badge">{item.event_label}</span>
        <span>{item.text}</span>
        <span className="muted small">
          {formatTime(item.at)} · {item.by_label}
          {item.pr != null && (
            <>
              {' · '}
              <a href={`https://github.com/twokidsCarl/world-sim/pull/${item.pr}`} target="_blank" rel="noreferrer">
                #{item.pr}
              </a>
            </>
          )}
        </span>
      </div>
      {changed && (
        <details>
          <summary>看改写前后</summary>
          <div className="diff">
            <div>
              <div className="muted small">之前</div>
              <h4>{item.before!.title}</h4>
              <p>{item.before!.body}</p>
            </div>
            <div>
              <div className="muted small">之后</div>
              <h4>{item.after!.title}</h4>
              <p>{item.after!.body}</p>
            </div>
          </div>
        </details>
      )}
    </li>
  )
}
