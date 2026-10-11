import { useState } from 'react'
import { api } from '../api'
import type { IdeaDetail, State, ThreadId } from '../contract'
import { LIVE } from '../state/derive'
import { label, pick } from '../i18n'
import { useLang, useStore, useT } from '../state/store'
import { ideaTitle } from './bits'

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
  const t = useT()
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
        {t('标题', 'Title')}
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        {t('正文', 'Body')}
        <textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <p className="muted small">{t('改写会留下旧版本，在历史里可以看前后对比。', 'A rewrite keeps the old version; the history shows before and after.')}</p>
      {error && <p className="err" role="alert">{error}</p>}
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !changed || !title.trim() || !body.trim()}>
          {t('保存改写', 'Save rewrite')}
        </button>
        <button type="button" onClick={onDone}>
          {t('取消', 'Cancel')}
        </button>
      </div>
    </form>
  )
}

export function PositionEditor({ idea, state }: { idea: IdeaDetail; state: State }) {
  const { busy, error, run } = useAction()
  const lang = useLang()
  const t = useT()
  const toggle = (id: ThreadId) => {
    const next = idea.threads.includes(id) ? idea.threads.filter((x) => x !== id) : [...idea.threads, id]
    void run(() => api.move(idea.id, { threads: next }))
  }
  return (
    <div className="pos-edit">
      <div className="thread-toggles" role="group" aria-label={t('横线', 'Threads')}>
        {THREADS.map((id) => {
          const info = state.frame.threads.find((x) => x.id === id)
          const on = idea.threads.includes(id)
          return (
            <button key={id} disabled={busy} aria-pressed={on} title={pick(lang, info?.desc, info?.desc_en)} className={`chip thread thread-${id}${on ? ' on' : ''}`} onClick={() => toggle(id)}>
              {id} {pick(lang, info?.short, info?.short_en)}
            </button>
          )
        })}
      </div>
      <select
        aria-label={t('内核', 'Kernel')}
        disabled={busy}
        value={idea.kernel ?? ''}
        onChange={(e) => void run(() => (e.target.value ? api.move(idea.id, { kernel: e.target.value }) : api.move(idea.id, { clear_kernel: true })))}
      >
        <option value="">{t('还没归类', 'Not classified yet')}</option>
        {state.frame.kernels.map((k) => (
          <option key={k.name} value={k.name}>
            {pick(lang, k.name, k.name_en)}
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
  const lang = useLang()
  const t = useT()
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
          {t('恢复到想法池', 'Restore to the idea pool')}
        </button>
        {error && <p className="err" role="alert">{error}</p>}
      </div>
    )
  }
  return (
    <div className="actions">
      <div className="row">
        <button onClick={onEdit}>{t('改写', 'Rewrite')}</button>
        <button aria-expanded={open === 'merge'} onClick={() => setOpen(open === 'merge' ? null : 'merge')}>
          {t('并入另一条', 'Merge into another')}
        </button>
        <button aria-expanded={open === 'discard'} onClick={() => setOpen(open === 'discard' ? null : 'discard')}>
          {t('丢弃', 'Discard')}
        </button>
        <select aria-label={t('状态', 'Status')} disabled={busy} value={idea.status} onChange={(e) => void run(() => api.setStatus(idea.id, e.target.value))}>
          {(['draft', 'pool', 'building', 'built'] as const).map((s) => (
            <option key={s} value={s}>
              {label(lang, 'status', s, state.labels.status?.[s])}
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
            {t('把这一条并入', 'Merge this one into')}
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">{t('选一条…', 'Choose one…')}</option>
              <optgroup label={t('同一层', 'Same level')}>
                {sameLevel.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.id} {ideaTitle(lang, i)}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t('其他层', 'Other levels')}>
                {others.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.id} {ideaTitle(lang, i)}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label>
            {t('为什么（可以不填）', 'Why (optional)')}
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('比如：做出来会是同一个项目', 'For example: built, they would be the same project')} />
          </label>
          <p className="muted small">{t('这一条会标成"已并入"，编号保留不再使用。目标那一条的正文不会自动改，需要的话去改写它。', 'This one will be marked "Merged"; its number is kept and not reused. The body of the target does not change by itself; rewrite it if needed.')}</p>
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !target}>
              {t('并入', 'Merge')}
            </button>
            <button type="button" onClick={close}>
              {t('取消', 'Cancel')}
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
            {t('为什么丢弃（可以不填）', 'Why discard it (optional)')}
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <p className="muted small">{t('丢弃的条目留在历史里，可以恢复。', 'Discarded ideas stay in the history and can be restored.')}</p>
          <div className="row">
            <button type="submit" className="primary" disabled={busy}>
              {t('丢弃', 'Discard')}
            </button>
            <button type="button" onClick={close}>
              {t('取消', 'Cancel')}
            </button>
          </div>
        </form>
      )}
      {error && <p className="err" role="alert">{error}</p>}
    </div>
  )
}
