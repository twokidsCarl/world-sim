import { useState } from 'react'
import { api } from '../api'
import type { IdeaDetail, State, ThreadId } from '../contract'
import { LIVE } from '../state/derive'
import { useStore } from '../state/store'

const THREADS: ThreadId[] = ['A', 'B', 'C', 'D', 'E']

// 一次改动：调接口、出错就显示在原地、成功后重新读状态。
// One change: call the API, show an error in place, reload the state on success.
function useAction() {
  const load = useStore((s) => s.load)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await load()
      after?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }
  return { busy, error, run }
}

export function EditText({ idea, onDone }: { idea: IdeaDetail; onDone: () => void }) {
  const [title, setTitle] = useState(idea.title)
  const [body, setBody] = useState(idea.body)
  const { busy, error, run } = useAction()
  const changed = title.trim() !== idea.title || body.trim() !== idea.body
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault()
        void run(() => api.edit(idea.id, { title, body }), onDone)
      }}
    >
      <label>
        标题
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        正文
        <textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <p className="muted small">改写会留下旧版本，在历史里可以看前后对比。</p>
      {error && <p className="err" role="alert">{error}</p>}
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !changed || !title.trim() || !body.trim()}>
          保存改写
        </button>
        <button type="button" onClick={onDone}>
          取消
        </button>
      </div>
    </form>
  )
}

export function PositionEditor({ idea, state }: { idea: IdeaDetail; state: State }) {
  const { busy, error, run } = useAction()
  const toggle = (t: ThreadId) => {
    const next = idea.threads.includes(t) ? idea.threads.filter((x) => x !== t) : [...idea.threads, t]
    void run(() => api.move(idea.id, { threads: next }))
  }
  return (
    <div className="pos-edit">
      <div className="thread-toggles" role="group" aria-label="横线">
        {THREADS.map((t) => {
          const info = state.frame.threads.find((x) => x.id === t)
          const on = idea.threads.includes(t)
          return (
            <button key={t} disabled={busy} aria-pressed={on} title={info?.desc} className={`chip thread thread-${t}${on ? ' on' : ''}`} onClick={() => toggle(t)}>
              {t} {info?.short}
            </button>
          )
        })}
      </div>
      <select
        aria-label="内核"
        disabled={busy}
        value={idea.kernel ?? ''}
        onChange={(e) => void run(() => (e.target.value ? api.move(idea.id, { kernel: e.target.value }) : api.move(idea.id, { clear_kernel: true })))}
      >
        <option value="">还没归类</option>
        {state.frame.kernels.map((k) => (
          <option key={k.name} value={k.name}>
            {k.name}
          </option>
        ))}
      </select>
      {error && <p className="err" role="alert">{error}</p>}
    </div>
  )
}

export function IdeaActions({ idea, state, onEdit }: { idea: IdeaDetail; state: State; onEdit: () => void }) {
  const [open, setOpen] = useState<'merge' | 'discard' | null>(null)
  const [target, setTarget] = useState('')
  const [reason, setReason] = useState('')
  const { busy, error, run } = useAction()
  const live = LIVE.includes(idea.status) || idea.status === 'draft'
  const close = () => {
    setOpen(null)
    setReason('')
    setTarget('')
  }
  const candidates = state.ideas.filter((i) => i.id !== idea.id && LIVE.includes(i.status))
  const sameLevel = candidates.filter((i) => i.level === idea.level)
  const others = candidates.filter((i) => i.level !== idea.level)

  if (!live) {
    return (
      <div className="actions">
        <button disabled={busy} onClick={() => void run(() => api.restore(idea.id))}>
          恢复到想法池
        </button>
        {error && <p className="err" role="alert">{error}</p>}
      </div>
    )
  }
  return (
    <div className="actions">
      <div className="row">
        <button onClick={onEdit}>改写</button>
        <button aria-expanded={open === 'merge'} onClick={() => setOpen(open === 'merge' ? null : 'merge')}>
          并入另一条
        </button>
        <button aria-expanded={open === 'discard'} onClick={() => setOpen(open === 'discard' ? null : 'discard')}>
          丢弃
        </button>
        <select aria-label="状态" disabled={busy} value={idea.status} onChange={(e) => void run(() => api.setStatus(idea.id, e.target.value))}>
          {(['draft', 'pool', 'building', 'built'] as const).map((s) => (
            <option key={s} value={s}>
              {state.labels.status?.[s]}
            </option>
          ))}
        </select>
      </div>
      {open === 'merge' && (
        <form
          className="form inline"
          onSubmit={(e) => {
            e.preventDefault()
            void run(() => api.merge(idea.id, target, reason), close)
          }}
        >
          <label>
            把这一条并入
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">选一条…</option>
              <optgroup label="同一层">
                {sameLevel.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.id} {i.title}
                  </option>
                ))}
              </optgroup>
              <optgroup label="其他层">
                {others.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.id} {i.title}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label>
            为什么（可以不填）
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="比如：做出来会是同一个项目" />
          </label>
          <p className="muted small">这一条会标成"已并入"，编号保留不再使用。目标那一条的正文不会自动改，需要的话去改写它。</p>
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !target}>
              并入
            </button>
            <button type="button" onClick={close}>
              取消
            </button>
          </div>
        </form>
      )}
      {open === 'discard' && (
        <form
          className="form inline"
          onSubmit={(e) => {
            e.preventDefault()
            void run(() => api.discard(idea.id, reason), close)
          }}
        >
          <label>
            为什么丢弃（可以不填）
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <p className="muted small">丢弃的条目留在历史里，可以恢复。</p>
          <div className="row">
            <button type="submit" className="primary" disabled={busy}>
              丢弃
            </button>
            <button type="button" onClick={close}>
              取消
            </button>
          </div>
        </form>
      )}
      {error && <p className="err" role="alert">{error}</p>}
    </div>
  )
}
