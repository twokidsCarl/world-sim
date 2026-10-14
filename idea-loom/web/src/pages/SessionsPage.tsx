import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { type SessionList, type Subagent, api } from '../api'
import { useDraft } from '../sessions/drafts'
import { SESSION_SHOWS, type SessionShow, inShow, loadShow, saveShow, shownStatus, tally } from '../sessions/filter'
import { askToNotify, notifyState } from '../sessions/notify'
import { SessionView } from '../sessions/SessionView'
import { useWaiting } from '../sessions/waiting'
import { useT } from '../state/store'
import { Empty, Page } from '../ui/Page'

// 会话：网页里的 Claude Code。左边是会话，右边是对话。只在本机、只有主人。
// Sessions: Claude Code in the page. Sessions on the left, the conversation on the right. Local only, owner only.
export function SessionsPage() {
  const t = useT()
  const { id } = useParams()
  const navigate = useNavigate()
  const [list, setList] = useState<SessionList | null>(null)
  // 新开会话那一框的草稿，刷新也还在。 / The draft in the start box, kept across a reload.
  const { text: draft, setText: setDraft } = useDraft('session:new')
  // 起始的模式、模型、努力程度，记住上次选的。 / The starting mode, model and effort, remembered from last time.
  const [choice, setChoice] = useState(() => {
    let saved: { mode?: string; model?: string; effort?: string } = {}
    try {
      saved = JSON.parse(localStorage.getItem('idea-loom:session-start') ?? '{}')
    } catch {
      /* 没有 localStorage 也能用 / works without localStorage */
    }
    return { mode: 'plan', model: 'claude-opus-5-5', effort: 'high', ...saved }
  })
  const choose = (patch: Partial<typeof choice>) => {
    const next = { ...choice, ...patch }
    setChoice(next)
    try {
      localStorage.setItem('idea-loom:session-start', JSON.stringify(next))
    } catch {
      /* 同上 / as above */
    }
  }
  const [alerts, setAlerts] = useState(notifyState)
  // 默认只看没结束的；选了别的就记住。 / Unfinished only by default; another choice is remembered.
  const [show, setShow] = useState<SessionShow>(loadShow)
  const pick = (next: SessionShow) => (setShow(next), saveShow(next))
  const [error, setError] = useState<string | null>(null)
  // 读到的列表也给全局的「在等回答」用，回答完左侧的数和气泡马上跟上。 / The list also feeds the global waiting state, so the nav count and bubbles follow an answer at once.
  const takeWaiting = useWaiting((w) => w.take)
  const load = () => api.sessions().then((l) => (setList(l), takeWaiting(l.sessions)), (e: Error) => setError(e.message))
  useEffect(() => {
    void load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [])
  const start = async () => {
    setError(null)
    try {
      const made = await api.startSession({ text: draft, ...choice })
      setDraft('')
      await load()
      navigate(`/sessions/${made.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const label: Record<string, string> = { idle: t('等你说话', 'idle'), running: t('在干活', 'working'), waiting: t('等你回答', 'needs you'), closed: t('已结束', 'closed'), error: t('出错了', 'failed') }
  const agentState: Record<Subagent['state'], string> = { running: t('在跑', 'running'), done: t('回来了', 'back'), failed: t('失败了', 'failed'), stopped: t('没做完', 'stopped') }
  const showName: Record<SessionShow, string> = { open: t('没结束的', 'Unfinished'), closed: t('已结束', 'Finished'), all: t('全部', 'All') }
  const sessions = list?.sessions ?? []
  const counts = tally(sessions)
  // 打开着的那个会话即使不在这一组里也留在列表上。 / The open session stays in the list even outside the chosen group.
  const shown = sessions.filter((s) => s.id === id || inShow(show, shownStatus(s)))
  return (
    <Page
      title={t('自我进化', 'Self-evolution')}
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
            <div className="row session-start">
              <select aria-label={t('起始模式', 'Starting mode')} value={choice.mode} onChange={(e) => choose({ mode: e.target.value })}>
                <option value="plan">{t('先出计划', 'Plan first')}</option>
                <option value="default">{t('每次问我', 'Ask every time')}</option>
                <option value="acceptEdits">{t('改文件不用问', 'Edits without asking')}</option>
                <option value="auto">{t('自动', 'Auto')}</option>
              </select>
              <select aria-label={t('模型', 'Model')} value={choice.model} onChange={(e) => choose({ model: e.target.value })}>
                {(list?.models ?? [choice.model]).map((m) => <option key={m} value={m}>{m.replace('claude-', '')}</option>)}
              </select>
              <select aria-label={t('思考的努力程度', 'Reasoning effort')} value={choice.effort} onChange={(e) => choose({ effort: e.target.value })}>
                {(list?.efforts ?? [choice.effort]).map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
            <button className="primary" disabled={!draft.trim() || !!list?.unavailable} onClick={() => void start()}>{t('开始', 'Start')}</button>
            {alerts === 'off' && <button onClick={() => void askToNotify().then(setAlerts)} title={t('它需要你、或者做完一轮而你不在这一页时，弹一条系统通知', 'A system notification when it needs you or finishes a turn while you are on another page')}>{t('开通知', 'Turn on alerts')}</button>}
            {alerts === 'blocked' && <span className="muted small">{t('浏览器里把这个站点的通知禁掉了', 'Notifications for this site are blocked in the browser')}</span>}
          </div>
          {list && list.sessions.length === 0 && <Empty>{t('还没有会话。', 'No sessions yet.')}</Empty>}
          {list && list.sessions.length > 0 && (
            <div className="session-filter">
              <span className="seg" role="group" aria-label={t('按状态筛选', 'Filter by status')}>
                {SESSION_SHOWS.map((key) => (
                  <button key={key} aria-pressed={show === key} aria-selected={show === key} onClick={() => pick(key)}>
                    {showName[key]} <span className="num">{counts.shows[key]}</span>
                  </button>
                ))}
              </span>
              {show !== 'closed' && (
                <span className="muted small">
                  {(['running', 'waiting', 'idle', 'error'] as const).filter((k) => counts.statuses[k]).map((k) => `${label[k]} ${counts.statuses[k]}`).join(' · ')}
                </span>
              )}
            </div>
          )}
          {list && list.sessions.length > 0 && shown.length === 0 && <Empty>{show === 'open' ? t('没有没结束的会话。', 'No unfinished sessions.') : t('没有结束了的会话。', 'No finished sessions.')}</Empty>}
          <ul className="plain-list">
            {shown.map((s) => (
              <li key={s.id}>
                <button className={`session-pick${s.id === id ? ' on' : ''}`} onClick={() => navigate(`/sessions/${s.id}`)}>
                  <strong>{s.title}</strong>
                  <span className={`small ${s.status === 'waiting' ? 'session-needs' : 'muted'}`}>
                    {label[shownStatus(s)]}
                    {s.waiting_for && ` · ${s.waiting_for}`}
                  </span>
                </button>
                {/* 它的子 Agent：谁在跑、谁回来了；点一下打开会话，翻到派它的那一步。 / Its subagents: who runs, who is back; a click opens the session at the step that launched it. */}
                {s.status !== 'closed' && (s.agents ?? []).length > 0 && (
                  <ul className="plain-list session-agents" aria-label={t('子 Agent', 'Subagents')}>
                    {s.agents!.map((a) => (
                      <li key={a.id}>
                        <button className={`session-agent ${a.state}`} title={`${a.label} · ${agentState[a.state]}`} onClick={() => navigate(`/sessions/${s.id}#step-${a.id}`)}>
                          <span aria-hidden="true" className={a.state === 'running' ? 'spin' : undefined}>{{ running: '◌', done: '✓', failed: '×', stopped: '–' }[a.state]}</span>
                          <span className="session-agent-label">{a.label}</span>
                          <span className="muted">{agentState[a.state]}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </aside>
        <section className="sessions-main">{id ? <SessionView key={id} id={id} onChange={() => void load()} /> : <Empty>{t('从左边选一个会话，或者新开一个。', 'Pick a session on the left, or start one.')}</Empty>}</section>
      </div>
    </Page>
  )
}
