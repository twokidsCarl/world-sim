import { useEffect, useRef, useState } from 'react'
import { type SessionMeta, api } from '../api'
import { type Attached, MAX_IMAGES, fromFile, imagesIn } from '../assistant/images'
import { Markdown } from '../assistant/Markdown'
import { useT } from '../state/store'
import { type Item, type Question, type SessionEvent, type View, emptyView, fold, pending } from './view'

// 一个 Claude Code 会话的对话：它说的话、它做的每一步、等你回答的卡片（计划、权限确认、它的提问），和你的输入框。
// One Claude Code session as a conversation: what it says, each step it takes, the cards awaiting
// your answer (a plan, a permission, its question) and your input box.
export function SessionView({ id, onChange }: { id: string; onChange?: (meta: SessionMeta) => void }) {
  const t = useT()
  const [view, setView] = useState<View>(emptyView)
  const [meta, setMeta] = useState<SessionMeta | null>(null)
  const [draft, setDraft] = useState('')
  const [attached, setAttached] = useState<Attached[]>([])
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
  const waiting = status === 'waiting' ? pending(view) : null
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
  const modes: [string, string, string][] = [['plan', '先出计划', 'Plan first'], ['default', '每次问我', 'Ask every time'], ['acceptEdits', '改文件不用问', 'Edits without asking']]

  return (
    <div className="session">
      <div className="session-bar">
        <span className={`badge session-status ${status}`}>
          {status === 'running' && <span className="spin" aria-hidden="true">◌</span>}{' '}
          {{ idle: t('等你说话', 'Waiting for you to speak'), running: t('在干活', 'Working'), waiting: t('等你回答', 'Waiting for your answer'), closed: t('已结束', 'Closed'), error: t('出错了', 'Failed') }[status]}
        </span>
        <span className="seg" role="group" aria-label={t('模式', 'Mode')}>
          {modes.map(([key, zh, en]) => (
            <button key={key} aria-pressed={mode === key} aria-selected={mode === key} disabled={status === 'closed'} onClick={() => void act(() => api.sessionMode(id, key))}>
              {t(zh, en)}
            </button>
          ))}
        </span>
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
          <ItemView key={item.seq} item={item} live={waiting?.seq === item.seq} onAnswer={(decision, note, answers) => void act(() => api.sessionAnswer(id, (item as { request_id: string }).request_id, decision, note, answers))} />
        ))}
        {status === 'running' && <p className="muted small"><span className="spin" aria-hidden="true">◌</span> {t('它在干活…', 'It is working…')}</p>}
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
            placeholder={waiting ? t('先回答上面那一张卡片…', 'Answer the card above first…') : busy ? t('它在干活；可以先打断', 'It is working; you can interrupt first') : t('接着说…（可以粘贴图片）', 'Go on… (images can be pasted)')}
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
    const text = { interrupted: t('被你打断了。', 'Interrupted by you.'), failed: t(`这一轮没有正常结束（${item.message}）。`, `This turn did not end normally (${item.message}).`), error: item.message }[item.code]
    return <p className={item.tone === 'bad' ? 'err small' : 'muted small'}>{text}</p>
  }
  if (item.kind === 'tool') {
    return (
      <details className={`session-step ${item.state}`}>
        <summary>
          <span aria-hidden="true">{item.state === 'running' ? '◌' : item.state === 'failed' ? '×' : '✓'}</span> {item.label}
        </summary>
        <ToolInput tool={item.name} input={item.input} />
        {item.result && <pre className="rich-raw">{item.result}</pre>}
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
    answer: t('你回答了', 'You answered'), approve: t('你批准了', 'You approved'), approve_edits: t('你批准了，改文件不用再问', 'You approved; edits no longer ask'), reject: t('你没有批准', 'You did not approve'),
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
              <button className="primary" onClick={() => onAnswer('approve')}>{t('批准，开始动手', 'Approve and start')}</button>
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
      {!settled && (
        <>
          <input value={note} placeholder={t('拒绝的话，可以写一句为什么', 'If you decline, you may say why')} onChange={(e) => setNote(e.target.value)} />
          <div className="row">
            <button className="primary" onClick={() => onAnswer('allow')}>{t('允许', 'Allow')}</button>
            <button onClick={() => onAnswer('allow_always')} title={t('这个会话里，同一类操作以后不再问（命令按第一个词算）', 'Within this session the same kind of action is no longer asked about (commands go by their first word)')}>{t('这一类以后都允许', 'Always allow this kind')}</button>
            <button onClick={() => onAnswer('deny', note)}>{t('拒绝', 'Decline')}</button>
          </div>
        </>
      )}
      {foot}
    </div>
  )
}
