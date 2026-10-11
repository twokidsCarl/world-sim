import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { api } from '../api'
import type { State, ThreadId } from '../contract'
import { pick } from '../i18n'
import { useLang, useStore, useT } from '../state/store'
import { Page } from '../ui/Page'
import { levelName } from '../ui/bits'

const THREADS: ThreadId[] = ['A', 'B', 'C', 'D', 'E']

export function NewIdeaPage({ state }: { state: State }) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const load = useStore((s) => s.load)
  const lang = useLang()
  const t = useT()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [level, setLevel] = useState(params.get('level') ?? 'L1')
  const [threads, setThreads] = useState<ThreadId[]>((params.get('threads') ?? '').split('').filter((t): t is ThreadId => THREADS.includes(t as ThreadId)))
  const [kernel, setKernel] = useState(params.get('kernel') ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const made = await api.create({ title, body, level, threads, kernel: kernel || null })
      await load()
      navigate(`/ideas/${encodeURIComponent(made.id)}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Page
      title={t('手写一条', 'Write one')}
      lead={t(
        '写法：标题加三行左右。说清对象和一个具体的问题，再指出去哪里查、和什么对齐。只给方向，不替后面的 Claude 做设计。',
        'How to write it: a title and about three lines. Name the subject and one concrete question, then say where to look and what to check it against. Give a direction only; leave the design to the Claude that picks it up.',
      )}
    >
      <form
        className="form wide"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label>
          {t('标题', 'Title')}
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('比如：一片雪花', 'For example: a snowflake')} />
        </label>
        <label>
          {t('正文', 'Body')}
          <textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div className="row wrap">
          <label>
            {t('层', 'Level')}
            <select value={level} onChange={(e) => setLevel(e.target.value)}>
              {state.frame.levels.map((l) => (
                <option key={l.id} value={l.id}>
                  {levelName(state, l.id, lang)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('内核', 'Kernel')}
            <select value={kernel} onChange={(e) => setKernel(e.target.value)}>
              <option value="">{t('先不归类', 'Leave unclassified for now')}</option>
              {state.frame.kernels.map((k) => (
                <option key={k.name} value={k.name}>
                  {pick(lang, k.name, k.name_en)}
                </option>
              ))}
            </select>
          </label>
          <div>
            <div className="label">{t('横线', 'Threads')}</div>
            <div className="thread-toggles" role="group" aria-label={t('横线', 'Threads')}>
              {THREADS.map((id) => {
                const on = threads.includes(id)
                const info = state.frame.threads.find((x) => x.id === id)
                return (
                  <button type="button" key={id} aria-pressed={on} className={`chip thread thread-${id}${on ? ' on' : ''}`} onClick={() => setThreads(on ? threads.filter((x) => x !== id) : [...threads, id])}>
                    {id} {pick(lang, info?.short, info?.short_en)}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
        <p className="muted small">{t('编号由层自动决定，取这一层的下一个号；层定了以后不能改。', 'The number follows from the level: the next free one on that level. The level cannot be changed afterwards.')}</p>
        {error && <p className="err" role="alert">{error}</p>}
        <div className="row">
          <button type="submit" className="primary" disabled={busy || !title.trim() || !body.trim()}>
            {t('放进想法池', 'Add to the idea pool')}
          </button>
          <button type="button" onClick={() => navigate(-1)}>
            {t('取消', 'Cancel')}
          </button>
        </div>
      </form>
    </Page>
  )
}
