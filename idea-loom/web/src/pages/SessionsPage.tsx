import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { type SessionList, api } from '../api'
import { SessionView } from '../sessions/SessionView'
import { useT } from '../state/store'
import { Empty, Page } from '../ui/Page'

// 会话：网页里的 Claude Code。左边是会话，右边是对话。只在本机、只有主人。
// Sessions: Claude Code in the page. Sessions on the left, the conversation on the right. Local only, owner only.
export function SessionsPage() {
  const t = useT()
  const { id } = useParams()
  const navigate = useNavigate()
  const [list, setList] = useState<SessionList | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const load = () => api.sessions().then(setList, (e: Error) => setError(e.message))
  useEffect(() => {
    void load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [])
  const start = async () => {
    setError(null)
    try {
      const made = await api.startSession({ text: draft, mode: 'plan' })
      setDraft('')
      await load()
      navigate(`/sessions/${made.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const label: Record<string, string> = { idle: t('等你说话', 'idle'), running: t('在干活', 'working'), waiting: t('等你回答', 'needs you'), closed: t('已结束', 'closed'), error: t('出错了', 'failed') }
  return (
    <Page
      title={t('会话', 'Sessions')}
      lead={t(
        '网页里的 Claude Code：和终端里是同一个，读得到 CLAUDE.md 和记忆，全套工具。它交计划、要改文件、要跑命令、要问你问题的时候，都停下来等你在这里回答。',
        'Claude Code in the page: the same one as in a terminal, with CLAUDE.md, memory and every tool. When it hands in a plan, wants to edit a file, run a command or ask you something, it stops and waits for your answer here.',
      )}
    >
      {error && <div className="notice bad" role="alert">{error}</div>}
      {list?.unavailable && <div className="notice warn">{list.unavailable}</div>}
      {list?.billing === 'api_key' && <div className="notice warn">{t('环境里有 ANTHROPIC_API_KEY：这些会话会按量计费，不走订阅。', 'ANTHROPIC_API_KEY is set in the environment: these sessions are billed per token, not through the subscription.')}</div>}
      <div className="sessions">
        <aside className="sessions-list">
          <div className="form">
            <textarea rows={2} value={draft} placeholder={t('新开一个会话：想让它做什么（例如 /wishes）', 'Start a session: what should it do (e.g. /wishes)')} onChange={(e) => setDraft(e.target.value)} />
            <button className="primary" disabled={!draft.trim() || !!list?.unavailable} onClick={() => void start()}>{t('开始，先出计划', 'Start, plan first')}</button>
          </div>
          {list && list.sessions.length === 0 && <Empty>{t('还没有会话。', 'No sessions yet.')}</Empty>}
          <ul className="plain-list">
            {(list?.sessions ?? []).map((s) => (
              <li key={s.id}>
                <button className={`session-pick${s.id === id ? ' on' : ''}`} onClick={() => navigate(`/sessions/${s.id}`)}>
                  <strong>{s.title}</strong>
                  <span className={`small ${s.status === 'waiting' ? 'session-needs' : 'muted'}`}>
                    {label[s.live || s.status === 'closed' || s.status === 'error' ? s.status : 'idle']}
                    {s.waiting_for && ` · ${s.waiting_for}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <section className="sessions-main">{id ? <SessionView key={id} id={id} onChange={() => void load()} /> : <Empty>{t('从左边选一个会话，或者新开一个。', 'Pick a session on the left, or start one.')}</Empty>}</section>
      </div>
    </Page>
  )
}
