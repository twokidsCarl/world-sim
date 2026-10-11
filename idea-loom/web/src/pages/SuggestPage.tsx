import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { type VisitorWish, api } from '../api'
import { useStore, useT } from '../state/store'
import { Empty, Page, Section } from '../ui/Page'

// 访客提愿望的那一页：一个简单的表单，加上自己提过的。提了之后等主人过目，这里不调用模型。
// The page where a visitor sends a wish: a plain form plus what they sent before. A wish waits for the owner to look it over; no model is called here.
export function SuggestPage() {
  const me = useStore((s) => s.me)
  const t = useT()
  const [title, setTitle] = useState('')
  const [stuck, setStuck] = useState('')
  const [mine, setMine] = useState<VisitorWish[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const signedIn = me != null && me.role !== 'guest'

  useEffect(() => {
    if (signedIn) api.mySuggestions().then(setMine, () => undefined)
  }, [signedIn])

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      // 从哪一页来的，帮主人看懂上下文。 / Which page the visitor came from, to give the owner context.
      const from = document.referrer.startsWith(location.origin) ? new URL(document.referrer).pathname : ''
      await api.sendSuggestion({ title, stuck, where_url: from, where_title: '' })
      setTitle('')
      setStuck('')
      setSent(true)
      setMine(await api.mySuggestions())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  const status = (s: VisitorWish) => ({ waiting: t('等主人过目', 'Waiting for the owner'), accepted: t('已放进许愿池', 'In the wish pool'), dismissed: t('没有采纳', 'Not taken up') })[s.status]

  return (
    <Page
      title={t('提个愿望', 'Send a wish')}
      lead={t(
        '觉得这里哪里不好用、想要什么，写下来。它会先到主人那里；主人看过、觉得该做，才会进许愿池。',
        'Write down what is awkward here or what you would like. It goes to the owner first, and only enters the wish pool once the owner has read it and thinks it should be done.',
      )}
    >
      {!signedIn ? (
        <p>
          <a className="button inline" href="/auth/login">{t('用 GitHub 登录', 'Sign in with GitHub')}</a>{' '}
          <span className="muted small">{t('登录之后才能提，这样主人知道是谁提的。', 'Sign in to send one, so the owner knows who it came from.')}</span>
        </p>
      ) : (
        <>
          <div className="form">
            <label>
              {t('想要什么（一句话）', 'What you would like (one sentence)')}
              <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              {t('卡在哪了（可以不填）', 'Where you got stuck (optional)')}
              <textarea value={stuck} maxLength={1000} rows={4} onChange={(e) => setStuck(e.target.value)} />
            </label>
            <div className="row">
              <button className="primary" disabled={busy || !title.trim()} onClick={() => void send()}>
                {busy ? t('正在提交…', 'Sending…') : t('提交', 'Send')}
              </button>
              {sent && <span className="muted small" role="status">{t('收到了，等主人过目。', 'Received; waiting for the owner.')}</span>}
              {error && <span className="err" role="alert">{error}</span>}
            </div>
          </div>
          <Section title={t('我提过的', 'What I have sent')}>
            {mine.length === 0 ? (
              <Empty>{t('还没有。', 'Nothing yet.')}</Empty>
            ) : (
              <ul className="plain-list">
                {mine.map((s) => (
                  <li key={s.id}>
                    <strong>{s.title}</strong> <span className="muted small">{status(s)}{s.note && t(`：${s.note}`, `: ${s.note}`)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </Page>
  )
}

// 主人这边：访客提的、还没过目的。放进许愿池之后它和别的愿望一样，要不要做仍然由你决定。
// The owner's side: what visitors sent and has not been looked over. Once in the wish pool it is like any other wish, and whether to act on it is still your decision.
export function VisitorQueue({ onAccepted }: { onAccepted: () => void }) {
  const t = useT()
  const [items, setItems] = useState<VisitorWish[]>([])
  const [error, setError] = useState<string | null>(null)
  const load = () => api.suggestions().then((all) => setItems(all.filter((s) => s.status === 'waiting')), () => undefined)
  useEffect(() => {
    void load()
  }, [])
  const act = async (run: () => Promise<unknown>, accepted: boolean) => {
    setError(null)
    try {
      await run()
      await load()
      if (accepted) onAccepted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  if (items.length === 0) return null
  return (
    <Section title={t('访客提的，等你过目', 'From visitors, waiting for you')} note={t('这是别人写的原文。放进许愿池不会触发任何改动。', 'This is what other people wrote, unedited. Putting one into the wish pool triggers no change by itself.')}>
      {error && <div className="notice bad" role="alert">{error}</div>}
      <ul className="plain-list">
        {items.map((s) => (
          <li key={s.id} className="visitor-item">
            <div>
              <strong>{s.title}</strong> <span className="muted small">{s.by}{s.where_url && <> · <Link to={s.where_url}>{s.where_url}</Link></>}</span>
              {s.stuck && <p className="pre small">{s.stuck}</p>}
            </div>
            <div className="row">
              <button className="primary" onClick={() => void act(() => api.acceptSuggestion(s.id), true)}>{t('放进许愿池', 'Put into the wish pool')}</button>
              <button onClick={() => void act(() => api.dismissSuggestion(s.id), false)}>{t('不要', 'Dismiss')}</button>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  )
}
