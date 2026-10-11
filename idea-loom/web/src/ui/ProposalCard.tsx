import { useState } from 'react'
import { api } from '../api'
import type { Proposal, State } from '../contract'
import { label } from '../i18n'
import { useLang, useStore, useT } from '../state/store'
import { IdeaLink, ThreadChips, kernelName, levelName } from './bits'

// 模型的一条提议：看、改、接受或不要。接受之前想法池不变。
// One proposal from the model: read it, edit it, accept or dismiss. The pool does
// not change until it is accepted.
export function ProposalCard({ proposal: p, state }: { proposal: Proposal; state: State }) {
  const load = useStore((s) => s.load)
  const lang = useLang()
  const t = useT()
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
        <span className="badge">{label(lang, 'op', p.op, p.op_label)}</span>
        <span className="muted small">{label(lang, 'proposalKind', p.kind, p.kind_label)}</span>
        {p.direction && <span className="chip">{p.direction}</span>}
        {p.status !== 'open' && <span className="badge">{p.status === 'accepted' ? t('已接受', 'Accepted') : t('没要', 'Dismissed')}</span>}
        {p.result_id && p.status === 'accepted' && <IdeaLink id={p.result_id} state={state} />}
      </header>

      {hasText &&
        (editing ? (
          <div className="form">
            <input aria-label={t('标题', 'Title')} value={title} onChange={(e) => setTitle(e.target.value)} />
            <textarea aria-label={t('正文', 'Body')} rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
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
          <span className="chip">{p.kernel ? kernelName(state, p.kernel, lang) : t('不归类', 'Unclassified')}</span>
        </p>
      )}
      {p.kind === 'merge' && p.idea_id && p.target && (
        <p>
          {t('把 ', 'Merge ')}<IdeaLink id={p.idea_id} state={state} />{t(' 并入 ', ' into ')}<IdeaLink id={p.target} state={state} />
        </p>
      )}

      {hasText && (
        <div className="p-where">
          {p.level && <span className="muted small">{levelName(state, p.level, lang)}</span>}
          <ThreadChips threads={p.threads as never} state={state} />
          <span className="muted small">{p.kernel ? kernelName(state, p.kernel, lang) : t('还没归类', 'Not classified yet')}</span>
        </div>
      )}
      {p.why && <p className="muted small p-why">{t('它的理由：', 'Its reason: ')}{p.why}</p>}
      {(p.sources?.length ?? 0) > 0 && p.kind === 'idea' && (
        <p className="muted small">
          {p.op === 'fuse' ? t('融合自 ', 'Fused from ') : t('由它想到 ', 'Inspired by ')}
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
                {t('用它替换原文', 'Replace the original with it')}
              </button>
              <button disabled={busy} onClick={() => void act(() => api.accept(p.id, { ...text, as_new: true }))}>
                {t('另存为新的一条', 'Save as a new idea')}
              </button>
            </>
          ) : (
            <button className="primary" disabled={busy} onClick={() => void act(() => api.accept(p.id, text))}>
              {p.kind === 'idea'
                ? p.op === 'fuse'
                  ? t('接受融合', 'Accept the fusion')
                  : t('放进想法池', 'Add to the idea pool')
                : p.kind === 'merge'
                  ? t('并入', 'Merge')
                  : t('照这样归类', 'Classify like this')}
            </button>
          )}
          {hasText && <button onClick={() => setEditing(!editing)}>{editing ? t('改好了', 'Done editing') : t('先改一改', 'Edit first')}</button>}
          <button disabled={busy} onClick={() => void act(() => api.dismiss(p.id))}>
            {t('不要', 'Dismiss')}
          </button>
        </div>
      )}
    </article>
  )
}
