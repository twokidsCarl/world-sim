import { useEffect, useRef, useState } from 'react'
import { type SessionMeta, api } from '../api'
import { type Attached, MAX_IMAGES, fromFile, imagesIn } from '../assistant/images'
import { Markdown } from '../assistant/Markdown'
import { useT } from '../state/store'
import { useRestartNeeded } from '../version'
import { useDraft } from './drafts'
import { mark, tell } from './notify'
import { type Item, type Question, type SessionEvent, type View, emptyView, fold, pending } from './view'

const MODEL_NAMES: Record<string, string> = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5', 'claude-fable-5-1': 'Fable 5.1' }
const MODELS = Object.keys(MODEL_NAMES)
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// 一个 Claude Code 会话的对话：它说的话、它做的每一步、等你回答的卡片（计划、权限确认、它的提问），和你的输入框。
// One Claude Code session as a conversation: what it says, each step it takes, the cards awaiting
// your answer (a plan, a permission, its question) and your input box.
export function SessionView({ id, onChange }: { id: string; onChange?: (meta: SessionMeta) => void }) {
  const t = useT()
  const [view, setView] = useState<View>(emptyView)
  const [meta, setMeta] = useState<SessionMeta | null>(null)
  // 草稿每个会话一份，换会话、刷新都还在。 / One draft per session, surviving a switch and a reload.
  const { text: draft, setText: setDraft, images: attached, setImages: setAttached } = useDraft(`session:${id}`)
  const [error, setError] = useState<string | null>(null)
  const log = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const refresh = () => api.session(id).then((m) => (setMeta(m), onChange?.(m)), () => undefined)

  useEffect(() => {
    setView(emptyView())
    void refresh()
    let source: EventSource | null = null
    let last = 0
    let closed = false
    const open = () => {
      source = new EventSource(`/api/sessions/${id}/events?after=${last}`)
      source.onmessage = (message) => {
        const event = JSON.parse(message.data) as SessionEvent
        last = Math.max(last, event.seq)
        setView((v) => fold(v, [event]))
        if (event.type === 'status' || event.type === 'result' || event.type === 'mode') void refresh()
      }
      // 断了就带着读到的序号重连，不会漏也不会重。 / On a drop, reconnect from the last sequence number: nothing missed, nothing repeated.
      source.onerror = () => {
        source?.close()
        if (!closed) setTimeout(open, 1500)
      }
    }
    open()
    return () => {
      closed = true
      source?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (stick.current && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [view.items.length, view.status])

  const act = async (run: () => Promise<unknown>) => {
    setError(null)
    try {
      await run()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  // 以服务器说的为准：idea-loom 重启过的话，事件里最后一个状态可能还是"在跑"，其实进程已经不在了。
  // The server's word wins: after an idea-loom restart the last status in the events may still say running although the process is gone.
  const status = meta && !meta.live && meta.status !== 'closed' && meta.status !== 'error' ? 'idle' : (meta?.status ?? view.status)
  // 进程还在的时候，每一张没回答的卡片都能回答；进程不在了（重启过、结束了），它们才算"没有回答"。
  // While the process is up every unanswered card can be answered; only when it is gone (restarted, closed) do they count as "not answered".
  const alive = !!meta?.live && status !== 'closed' && status !== 'error'
  const waiting = alive ? pending(view) : []
  const busy = status === 'running' || status === 'waiting'
  const send = () => {
    if ((!draft.trim() && attached.length === 0) || busy) return
    const text = draft.trim() || t('看这张图。', 'Look at this image.')
    const images = attached.map(({ media_type, data, name }) => ({ media_type, data, name }))
    setDraft('')
    setAttached([])
    stick.current = true
    void act(() => api.sessionSay(id, text, images))
  }
  const addImages = async (files: File[]) => {
    const made = (await Promise.all(files.map(fromFile))).filter((x): x is Attached => x !== null)
    setAttached((now) => [...now, ...made].slice(0, MAX_IMAGES))
  }
  const mode = meta?.mode ?? view.mode ?? 'default'
  // 后端还是旧代码时，它不认识"自动"也不报模型：把这些控件灰掉并说明，而不是点了没反应。
  // While the backend still runs old code it knows neither "auto" nor the model: grey those controls out and say why, instead of clicks doing nothing.
  const restartNeeded = useRestartNeeded()
  const oldBackend = !!meta && (meta as { model?: string }).model === undefined
  // 会话是不是独立的进程（后端报了 stale 这一项就是）：是的话重启后端不影响它。
  // Whether sessions are their own processes (the backend reports `stale` when they are): if so a backend restart leaves them alone.
  const detached = !!meta && meta.stale !== undefined
  const backgroundTasks = (meta as { tasks?: number } | null)?.tasks ?? 0
  const modes: [string, string, string, string, string][] = [
    ['plan', '先出计划', 'Plan first', '只调研、写计划，不动手；计划等你批准', 'It only investigates and plans; the plan waits for your approval'],
    ['default', '每次问我', 'Ask every time', '改文件、跑命令都先问你', 'File edits and commands all ask you first'],
    ['acceptEdits', '改文件不用问', 'Edits without asking', '改文件直接做，跑命令仍然问', 'File edits just happen; commands still ask'],
    ['auto', '自动', 'Auto', 'Claude Code 原样的自动模式：它自己的安全分类器判断每一步，常规的事直接做，不停下来；它有问题要问你、交计划时会停', 'The auto mode of Claude Code as it is: its own safety classifier judges each step and routine ones just happen without stopping; it stops when it has a question for you or a plan to hand in'],
  ]
  // 需要你、或者做完了：不在这一页时通知，并在标签页标题上做记号。 / Needs you, or done: notify when you are elsewhere and mark the tab title.
  const was = useRef<string>('')
  const now = waiting.length ? 'waiting' : status
  useEffect(() => {
    if (was.current && was.current !== now) {
      if (now === 'waiting') tell(t('Claude Code 在等你', 'Claude Code needs you'), meta?.waiting_for ?? meta?.title ?? '', id)
      else if (now === 'idle') tell(t('Claude Code 做完了一轮', 'Claude Code finished a turn'), meta?.title ?? '', id)
    }
    was.current = now
    mark(now === 'waiting' ? '●' : now === 'idle' && document.visibilityState !== 'visible' ? '✓' : null)
    const clear = () => {
      if (document.visibilityState === 'visible' && now !== 'waiting') mark(null)
    }
    document.addEventListener('visibilitychange', clear)
    return () => document.removeEventListener('visibilitychange', clear)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now])
  useEffect(() => () => mark(null), [])

  return (
    <div className="session">
      {(oldBackend || restartNeeded) && (
        <div className="notice warn" role="status">
          {oldBackend
            ? t('后端还在跑旧的代码，所以"自动"模式和模型选择现在用不了。在跑着服务的终端里按 Ctrl+C，再运行 uv run idea-loom serve。这个会话的对话会保留，重启后发一句话就接上。', 'The backend is still running old code, so auto mode and the model choice are unavailable for now. Press Ctrl+C in the terminal running the service, then run uv run idea-loom serve. This conversation is kept and continues with your next message after the restart.')
            : detached
              ? t('后端的代码有更新，重启后端才生效：在跑着服务的终端里按 Ctrl+C，再运行 uv run idea-loom serve。会话是独立的进程，不受影响，可以放心重启。', 'The backend code has been updated and takes effect after a restart: press Ctrl+C in the terminal running the service, then run uv run idea-loom serve. Sessions are separate processes and are not affected, so restarting is safe.')
              : t('后端的代码有更新，重启后端才生效：在跑着服务的终端里按 Ctrl+C，再运行 uv run idea-loom serve。这一次重启会打断正在进行的那一轮（对话会保留）；之后会话是独立的进程，重启不再影响它。', 'The backend code has been updated and takes effect after a restart: press Ctrl+C in the terminal running the service, then run uv run idea-loom serve. This one restart interrupts the turn in progress (the conversation is kept); afterwards sessions are separate processes and restarts no longer affect them.')}
        </div>
      )}
      <div className="session-bar">
        <span className={`badge session-status ${status}`}>
          {status === 'running' && <span className="spin" aria-hidden="true">◌</span>}{' '}
          {{ idle: t('等你说话', 'Waiting for you to speak'), running: t('在干活', 'Working'), waiting: t('等你回答', 'Waiting for your answer'), closed: t('已结束', 'Closed'), error: t('出错了', 'Failed') }[status]}
        </span>
        {/* 这一轮说完了，后台的子 Agent 还在跑：它们做完后 Claude Code 会自己接着做。 / The turn is over but background subagents still run; when they finish Claude Code carries on by itself. */}
        {meta?.live && backgroundTasks > 0 && (
          <span className="badge" title={t('它们做完后，Claude Code 会自己接着做一轮', 'When they finish, Claude Code carries on with a turn by itself')}>
            <span className="spin" aria-hidden="true">◌</span> {t(`后台 ${backgroundTasks} 个任务在跑`, `${backgroundTasks} background task${backgroundTasks === 1 ? '' : 's'} running`)}
          </span>
        )}
        <span className="seg" role="group" aria-label={t('模式', 'Mode')}>
          {modes.map(([key, zh, en, hintZh, hintEn]) => (
            <button key={key} title={t(hintZh, hintEn)} aria-pressed={mode === key} aria-selected={mode === key} disabled={status === 'closed' || (oldBackend && key === 'auto')} onClick={() => void act(() => api.sessionMode(id, key))}>
              {t(zh, en)}
            </button>
          ))}
        </span>
        {meta && !oldBackend && (
          <span className="session-engine" title={t('用哪个模型、想得多深。它闲着的时候才能换；换了之后下一句话生效，对话接着原来的。', 'Which model and how hard it thinks. Changeable only while it is idle; it takes effect on the next message and the conversation carries on.')}>
            <select aria-label={t('模型', 'Model')} value={meta.model} disabled={busy || status === 'closed'} onChange={(e) => void act(() => api.sessionEngine(id, e.target.value, meta.effort))}>
              {(MODELS.includes(meta.model) ? MODELS : [meta.model, ...MODELS]).map((m) => <option key={m} value={m}>{MODEL_NAMES[m] ?? m}</option>)}
            </select>
            <select aria-label={t('思考的努力程度', 'Reasoning effort')} value={meta.effort} disabled={busy || status === 'closed'} onChange={(e) => void act(() => api.sessionEngine(id, meta.model, e.target.value))}>
              {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            {meta.model_used && meta.model_used !== meta.model && <span className="muted small">{t(`实际在用 ${meta.model_used}`, `actually using ${meta.model_used}`)}</span>}
            {detached && status !== 'closed' && (
              <span className="muted small session-process" title={t('每个会话是一个独立的进程，重启后端不会打断它。闲了 30 分钟它会自己歇下来，下一句话接上原来的对话。', 'Each session is its own process and a backend restart does not interrupt it. After 30 idle minutes it rests by itself, and the next message picks the conversation up.')}>
                {meta.live
                  ? meta.stale
                    ? t(`进程 ${meta.pid ?? ''} 在跑 · 用的是旧代码，这一轮做完后自动换成新的`, `process ${meta.pid ?? ''} up · on old code, replaced by itself once this turn is done`)
                    : t(`进程 ${meta.pid ?? ''} 在跑`, `process ${meta.pid ?? ''} up`)
                  : t('进程歇着，下一句话接上', 'process resting; the next message resumes it')}
              </span>
            )}
          </span>
        )}
        <span className="muted small num">{meta ? `$${meta.cost_usd.toFixed(2)}` : ''}</span>
        {status === 'running' && <button onClick={() => void act(() => api.sessionInterrupt(id))}>{t('打断', 'Interrupt')}</button>}
        {status !== 'closed' && !busy && <button onClick={() => void act(() => api.sessionClose(id))}>{t('结束会话', 'End session')}</button>}
      </div>

      <div
        className="session-log"
        ref={log}
        onScroll={() => {
          const el = log.current
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {view.items.map((item) => (
          <ItemView key={item.seq} item={item} live={waiting.some((w) => w.seq === item.seq)} onAnswer={(decision, note, answers) => void act(() => api.sessionAnswer(id, (item as { request_id: string }).request_id, decision, note, answers))} />
        ))}
        {waiting.length > 1 && <p className="session-needs small">{t(`上面有 ${waiting.length} 张卡片在等你回答。`, `${waiting.length} cards above are waiting for your answer.`)}</p>}
        {status === 'running' && waiting.length === 0 && <p className="muted small"><span className="spin" aria-hidden="true">◌</span> {t('它在干活…', 'It is working…')}</p>}
      </div>

      {error && <div className="notice bad" role="alert">{error}</div>}
      {status !== 'closed' && (
        <form
          className="a-compose session-compose"
          onSubmit={(e) => (e.preventDefault(), send())}
          onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
          onDrop={(e) => {
            const files = imagesIn(e.dataTransfer.items)
            if (files.length) (e.preventDefault(), void addImages(files))
          }}
        >
          {attached.length > 0 && (
            <div className="a-thumbs">
              {attached.map((image, i) => (
                <span key={i} className="a-thumb">
                  <img src={image.url} alt="" />
                  <button type="button" aria-label={t('去掉这张图', 'Remove this image')} onClick={() => setAttached(attached.filter((_, j) => j !== i))}>×</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            rows={2}
            value={draft}
            aria-label={t('对 Claude Code 说', 'Say to Claude Code')}
            placeholder={waiting.length ? t('先回答上面那一张卡片…', 'Answer the card above first…') : busy ? t('它在干活；可以先打断', 'It is working; you can interrupt first') : t('接着说…（可以粘贴图片）', 'Go on… (images can be pasted)')}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const files = imagesIn(e.clipboardData.items)
              if (files.length) (e.preventDefault(), void addImages(files))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), send())
            }}
          />
          <div className="a-compose-foot">
            <span className="muted small a-hint">{t('Enter 发出 · 这是你本机的 Claude Code，能改文件、能跑命令', 'Enter to send · this is Claude Code on your machine; it can edit files and run commands')}</span>
            <button type="submit" className="primary" disabled={busy || (!draft.trim() && attached.length === 0)}>{t('发出', 'Send')}</button>
          </div>
        </form>
      )}
    </div>
  )
}

function ItemView({ item, live, onAnswer }: { item: Item; live: boolean; onAnswer: (decision: string, note?: string, answers?: Record<string, string | string[]>) => void }) {
  const t = useT()
  if (item.kind === 'user') {
    return (
      <div className="a-q">
        <div className="a-bubble">{item.text}</div>
        {item.images > 0 && <div className="muted small">{t(`附了 ${item.images} 张图`, `${item.images} image${item.images === 1 ? '' : 's'} attached`)}</div>}
      </div>
    )
  }
  if (item.kind === 'text') return <Markdown text={item.text} />
  if (item.kind === 'note') {
    const text = { resumed: t('后台的任务做完了，Claude Code 接着做。', 'A background task finished and Claude Code carries on.'), interrupted: t('被你打断了。', 'Interrupted by you.'), failed: t(`这一轮没有正常结束（${item.message}）。`, `This turn did not end normally (${item.message}).`), error: item.message }[item.code]
    return <p className={item.tone === 'bad' ? 'err small' : 'muted small'}>{text}</p>
  }
  if (item.kind === 'tool') {
    // 子 Agent 在后台跑时，派它的那一步早就"返回"了，要看的是它自己的近况。
    // While a subagent runs in the background the step that launched it has long "returned"; what counts is how the subagent itself is doing.
    const task = item.task
    const state = task ? (task.state !== 'done' ? 'running' : task.status === 'completed' ? 'done' : 'failed') : item.state
    const steps = item.children.filter((c) => c.kind === 'tool').length
    // 子 Agent 报步数；放到后台跑的命令只说在跑还是做完了。 / A subagent reports its steps; a command run in the background only says running or done.
    const agent = item.name === 'Agent' || item.name === 'Task'
    return (
      <details className={`session-step ${state}`} open={!!task && task.state !== 'done' ? true : undefined}>
        <summary>
          <span aria-hidden="true" className={state === 'running' ? 'spin' : undefined}>{state === 'running' ? '◌' : state === 'failed' ? '×' : '✓'}</span> {item.label}
          {task && (
            <span className="muted small">
              {' · '}
              {!agent
                ? task.state === 'done' ? t('后台跑完了', 'finished in the background') : t('在后台跑', 'running in the background')
                : task.state === 'done'
                  ? t(`做完了，${steps} 步`, `done, ${steps} step${steps === 1 ? '' : 's'}`)
                  : task.lastTool
                    ? t(`在跑，最近在用 ${task.lastTool}，${steps} 步`, `running, last used ${task.lastTool}, ${steps} step${steps === 1 ? '' : 's'}`)
                    : t('在跑', 'running')}
            </span>
          )}
        </summary>
        <ToolInput tool={item.name} input={item.input} />
        {item.children.length > 0 && (
          <div style={{ borderLeft: '2px solid var(--line)', paddingLeft: 12, margin: '6px 0 6px 4px', display: 'grid', gap: 4 }}>
            {item.children.map((child) => <ItemView key={child.seq} item={child} live={false} onAnswer={onAnswer} />)}
          </div>
        )}
        {/* 在后台跑的，派出去时的返回只是一段给模型看的说明；要看的是它做完时的结论。 / For background work the launch result is only a note meant for the model; what matters is its conclusion at the end. */}
        {task ? task.state === 'done' && agent && task.summary && <Markdown text={task.summary} /> : item.result && <pre className="rich-raw">{item.result}</pre>}
      </details>
    )
  }
  return <RequestCard item={item} live={live} onAnswer={onAnswer} />
}

// 一次工具调用要做什么：改文件给出前后对照，命令给出原文，别的给出参数。
// What a tool call is about to do: a before/after for file edits, the command itself for shell commands, the arguments otherwise.
function ToolInput({ tool, input }: { tool: string; input: Record<string, unknown> }) {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  if (tool === 'Bash') return <pre className="rich-raw">$ {text('command')}</pre>
  if (tool === 'Edit') {
    return (
      <div className="session-diff">
        <div className="muted small">{text('file_path')}</div>
        <pre className="del">{text('old_string')}</pre>
        <pre className="add">{text('new_string')}</pre>
      </div>
    )
  }
  if (tool === 'Write') {
    return (
      <div className="session-diff">
        <div className="muted small">{text('file_path')}</div>
        <pre className="add">{text('content')}</pre>
      </div>
    )
  }
  return <pre className="rich-raw">{JSON.stringify(input, null, 2)}</pre>
}

function RequestCard({ item, live, onAnswer }: { item: Extract<Item, { kind: 'request' }>; live: boolean; onAnswer: (decision: string, note?: string, answers?: Record<string, string | string[]>) => void }) {
  const t = useT()
  const [note, setNote] = useState('')
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [own, setOwn] = useState<Record<string, string>>({})
  const outcome: Record<string, string> = {
    allow: t('你允许了', 'You allowed it'), allow_always: t('你允许了，这一类以后不再问', 'You allowed it and this kind is no longer asked about'), deny: t('你拒绝了', 'You declined'),
    answer: t('你回答了', 'You answered'), approve: t('你批准了', 'You approved'), approve_edits: t('你批准了，改文件不用再问', 'You approved; edits no longer ask'), approve_auto: t('你批准了，之后自动', 'You approved; auto from here'), reject: t('你没有批准', 'You did not approve'),
  }
  const settled = item.decision !== null || !live
  const foot = settled && (
    <p className="muted small">
      {item.decision ? outcome[item.decision] ?? item.decision : t('没有回答（会话停了）', 'Not answered (the session stopped)')}
      {item.note && t(`：${item.note}`, `: ${item.note}`)}
    </p>
  )

  if (item.what === 'plan') {
    return (
      <div className={`session-card plan${settled ? ' settled' : ''}`}>
        <h4>{t('计划', 'Plan')}</h4>
        <Markdown text={String(item.input.plan ?? '')} />
        {!settled && (
          <>
            <textarea rows={2} value={note} placeholder={t('有意见就写在这里，然后点"提意见"', 'Write your comments here, then choose "Send comments"')} onChange={(e) => setNote(e.target.value)} />
            <div className="row">
              <button className="primary" onClick={() => onAnswer('approve_auto')} title={t('批准，之后常规的事它直接做、不再一步步问；删除、推送这类仍然每次问你', 'Approve; routine steps then just happen without asking one by one, while deleting, pushing and the like still ask every time')}>{t('批准，之后自动', 'Approve; auto from here')}</button>
              <button onClick={() => onAnswer('approve')} title={t('批准，之后改文件、跑命令每一步都问你', 'Approve; every file edit and command then asks you')}>{t('批准，每步问我', 'Approve; ask each step')}</button>
              <button onClick={() => onAnswer('approve_edits')} title={t('批准，并且之后改文件不用每次问我（跑命令仍然会问）', 'Approve, and do not ask me for each file edit afterwards (commands still ask)')}>{t('批准，改文件不用问', 'Approve; edits without asking')}</button>
              <button disabled={!note.trim()} onClick={() => onAnswer('reject', note)}>{t('提意见', 'Send comments')}</button>
            </div>
          </>
        )}
        {foot}
      </div>
    )
  }
  if (item.what === 'question') {
    const questions = (Array.isArray(item.input.questions) ? item.input.questions : []) as Question[]
    const answers = () => Object.fromEntries(questions.map((q) => [q.question, own[q.question]?.trim() ? own[q.question]!.trim() : q.multiSelect ? (picked[q.question] ?? []) : (picked[q.question]?.[0] ?? '')]))
    const ready = questions.every((q) => own[q.question]?.trim() || (picked[q.question] ?? []).length > 0)
    return (
      <div className={`session-card question${settled ? ' settled' : ''}`}>
        <h4>{t('它有问题要问你', 'It has a question for you')}</h4>
        {questions.map((q) => (
          <div key={q.question} className="session-question">
            <p><strong>{q.question}</strong></p>
            <div className="card-picks">
              {q.options.map((o) => {
                const on = (picked[q.question] ?? []).includes(o.label)
                return (
                  <button key={o.label} disabled={settled} aria-pressed={on} onClick={() => setPicked({ ...picked, [q.question]: q.multiSelect ? (on ? picked[q.question]!.filter((x) => x !== o.label) : [...(picked[q.question] ?? []), o.label]) : [o.label] })}>
                    <strong>{o.label}</strong>
                    {o.description && <span className="muted small"> {o.description}</span>}
                  </button>
                )
              })}
            </div>
            {!settled && <input value={own[q.question] ?? ''} placeholder={t('或者自己写', 'Or write your own')} onChange={(e) => setOwn({ ...own, [q.question]: e.target.value })} />}
          </div>
        ))}
        {!settled && (
          <div className="row">
            <button className="primary" disabled={!ready} onClick={() => onAnswer('answer', '', answers())}>{t('回答', 'Answer')}</button>
          </div>
        )}
        {foot}
      </div>
    )
  }
  return (
    <div className={`session-card permission${settled ? ' settled' : ''}`}>
      <h4>{t('它要做这件事，等你确认', 'It wants to do this and awaits your confirmation')}</h4>
      <p className="small">{item.summary}</p>
      <ToolInput tool={item.tool} input={item.input} />
      {item.segments.length > 1 && (
        <p className="small muted">
          {t('这条命令分成几段：', 'This command has several parts: ')}
          {item.segments.map((s, i) => (
            <span key={i} className={`chip${s.known ? '' : ' unseen'}`} title={s.text}>{s.kind}{s.known ? ' ✓' : t(' 没见过', ' new')}</span>
          ))}
        </p>
      )}
      {!settled && (
        <>
          <input value={note} placeholder={t('拒绝的话，可以写一句为什么', 'If you decline, you may say why')} onChange={(e) => setNote(e.target.value)} />
          <div className="row">
            <button className="primary" onClick={() => onAnswer('allow')}>{t('允许', 'Allow')}</button>
            {<button onClick={() => onAnswer('allow_always')} title={t('这个会话里，同一类操作以后不再问。命令按每一段的程序和子命令算（比如 git status、uv run），每一段都允许过才不再问', 'Within this session the same kind of action is no longer asked about. A command goes by the program and subcommand of each part (git status, uv run…) and is skipped only when every part was allowed before')}>{t('这一类以后都允许', 'Always allow this kind')}</button>}
            <button onClick={() => onAnswer('deny', note)}>{t('拒绝', 'Decline')}</button>
          </div>
        </>
      )}
      {foot}
    </div>
  )
}
