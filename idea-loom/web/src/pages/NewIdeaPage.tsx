import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { api } from '../api'
import type { State, ThreadId } from '../contract'
import { useStore } from '../state/store'
import { Page } from '../ui/Page'
import { levelName } from '../ui/bits'

const THREADS: ThreadId[] = ['A', 'B', 'C', 'D', 'E']

export function NewIdeaPage({ state }: { state: State }) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const load = useStore((s) => s.load)
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
    <Page title="手写一条" lead="写法：标题加三行左右。说清对象和一个具体的问题，再指出去哪里查、和什么对齐。只给方向，不替后面的 Claude 做设计。">
      <form
        className="form wide"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label>
          标题
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="比如：一片雪花" />
        </label>
        <label>
          正文
          <textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div className="row wrap">
          <label>
            层
            <select value={level} onChange={(e) => setLevel(e.target.value)}>
              {state.frame.levels.map((l) => (
                <option key={l.id} value={l.id}>
                  {levelName(state, l.id)}
                </option>
              ))}
            </select>
          </label>
          <label>
            内核
            <select value={kernel} onChange={(e) => setKernel(e.target.value)}>
              <option value="">先不归类</option>
              {state.frame.kernels.map((k) => (
                <option key={k.name} value={k.name}>
                  {k.name}
                </option>
              ))}
            </select>
          </label>
          <div>
            <div className="label">横线</div>
            <div className="thread-toggles" role="group" aria-label="横线">
              {THREADS.map((t) => {
                const on = threads.includes(t)
                const info = state.frame.threads.find((x) => x.id === t)
                return (
                  <button type="button" key={t} aria-pressed={on} className={`chip thread thread-${t}${on ? ' on' : ''}`} onClick={() => setThreads(on ? threads.filter((x) => x !== t) : [...threads, t])}>
                    {t} {info?.short}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
        <p className="muted small">编号由层自动决定，取这一层的下一个号；层定了以后不能改。</p>
        {error && <p className="err" role="alert">{error}</p>}
        <div className="row">
          <button type="submit" className="primary" disabled={busy || !title.trim() || !body.trim()}>
            放进想法池
          </button>
          <button type="button" onClick={() => navigate(-1)}>
            取消
          </button>
        </div>
      </form>
    </Page>
  )
}
