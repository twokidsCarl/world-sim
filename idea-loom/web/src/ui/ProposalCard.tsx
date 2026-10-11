import { useState } from 'react'
import { api } from '../api'
import type { Proposal, State } from '../contract'
import { useStore } from '../state/store'
import { IdeaLink, ThreadChips, levelName } from './bits'

// 模型的一条提议：看、改、接受或不要。接受之前想法池不变。
// One proposal from the model: read it, edit it, accept or dismiss. The pool does
// not change until it is accepted.
export function ProposalCard({ proposal: p, state }: { proposal: Proposal; state: State }) {
  const load = useStore((s) => s.load)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(p.title ?? '')
  const [body, setBody] = useState(p.body ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasText = p.kind === 'idea' || p.kind === 'rewrite'

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  const text = hasText ? { title, body } : {}

  return (
    <article className={`proposal p-${p.status}`}>
      <header>
        <span className="badge">{p.op_label}</span>
        <span className="muted small">{p.kind_label}</span>
        {p.direction && <span className="chip">{p.direction}</span>}
        {p.status !== 'open' && <span className="badge">{p.status === 'accepted' ? '已接受' : '没要'}</span>}
        {p.result_id && p.status === 'accepted' && <IdeaLink id={p.result_id} state={state} />}
      </header>

      {hasText &&
        (editing ? (
          <div className="form">
            <input aria-label="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
            <textarea aria-label="正文" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
        ) : (
          <>
            <h3>{title}</h3>
            <div className="p-body">
              {body.split('\n').map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </>
        ))}

      {p.kind === 'position' && p.idea_id && (
        <p>
          <IdeaLink id={p.idea_id} state={state} /> → <ThreadChips threads={p.threads as never} state={state} />{' '}
          <span className="chip">{p.kernel ?? '不归类'}</span>
        </p>
      )}
      {p.kind === 'merge' && p.idea_id && p.target && (
        <p>
          把 <IdeaLink id={p.idea_id} state={state} /> 并入 <IdeaLink id={p.target} state={state} />
        </p>
      )}

      {hasText && (
        <div className="p-where">
          {p.level && <span className="muted small">{levelName(state, p.level)}</span>}
          <ThreadChips threads={p.threads as never} state={state} />
          <span className="muted small">{p.kernel ?? '还没归类'}</span>
        </div>
      )}
      {p.why && <p className="muted small p-why">它的理由：{p.why}</p>}
      {(p.sources?.length ?? 0) > 0 && p.kind === 'idea' && (
        <p className="muted small">
          {p.op === 'fuse' ? '融合自 ' : '由它想到 '}
          {p.sources.map((s) => (
            <span key={s}>
              <IdeaLink id={s} state={state} />{' '}
            </span>
          ))}
        </p>
      )}

      {error && <p className="err" role="alert">{error}</p>}
      {p.status === 'open' && (
        <div className="row">
          {p.kind === 'rewrite' ? (
            <>
              <button className="primary" disabled={busy} onClick={() => void act(() => api.accept(p.id, text))}>
                用它替换原文
              </button>
              <button disabled={busy} onClick={() => void act(() => api.accept(p.id, { ...text, as_new: true }))}>
                另存为新的一条
              </button>
            </>
          ) : (
            <button className="primary" disabled={busy} onClick={() => void act(() => api.accept(p.id, text))}>
              {p.kind === 'idea' ? (p.op === 'fuse' ? '接受融合' : '放进想法池') : p.kind === 'merge' ? '并入' : '照这样归类'}
            </button>
          )}
          {hasText && <button onClick={() => setEditing(!editing)}>{editing ? '改好了' : '先改一改'}</button>}
          <button disabled={busy} onClick={() => void act(() => api.dismiss(p.id))}>
            不要
          </button>
        </div>
      )}
    </article>
  )
}
