import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { api } from '../api'
import { formatTime } from '../state/derive'
import { useStore } from '../state/store'
import { Markdown } from './Markdown'
import { clearRefs, snapshot } from './pageSnapshot'
import { MAX_WIDTH, MIN_WIDTH, useAssistant } from './store'
import { stuck } from './stuck'
import { arrive, install, note, recentActions, subscribe } from './trail'
import type { Block, TurnView } from './turnView'

const SUGGESTIONS = ['这一页是讲什么的？', '我下一步该点哪里？', '想法池现在哪里最薄？']
const EXPLAIN = '请解释一下这一页：它在回答什么，我接下来可以做什么。'
const FLOAT_BELOW = 1180 // 窗口比这窄就不停靠，改成浮层 / below this the dock floats instead

function ideaIdFrom(pathname: string): string | null {
  const m = /^\/ideas\/(.+)$/.exec(pathname)
  return m ? decodeURIComponent(m[1]!) : null
}

// 把小助手圈出的元素标出来，直到下一次提问或换页。
// Mark the elements the assistant pointed at, until the next question or navigation.
function showPoints(points: { ref: string; note: string }[]) {
  document.querySelectorAll('.a-pointed').forEach((el) => el.classList.remove('a-pointed'))
  points.forEach((p, i) => {
    const el = document.querySelector(`[data-aref="${p.ref}"]`)
    if (!el) return
    el.classList.add('a-pointed')
    el.setAttribute('data-apoint', String(i + 1))
    if (i === 0) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
}

export function AssistantDock() {
  const a = useAssistant()
  const { page, load } = useStore()
  const location = useLocation()
  const [draft, setDraft] = useState('')
  const [floating, setFloating] = useState(typeof window !== 'undefined' && window.innerWidth < FLOAT_BELOW)
  const [showHistory, setShowHistory] = useState(false)
  const log = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const offered = useRef(new Set<string>())
  const url = location.pathname + location.search

  useEffect(() => {
    install()
    void a.refresh()
    if (a.conversationId) void a.openConversation(a.conversationId)
    const onResize = () => setFloating(window.innerWidth < FLOAT_BELOW)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // 只在挂载时做一次 / once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 换页：记轨迹，收起提示和圈出的标记。 / On navigation: record it, drop the offer and the marks.
  useEffect(() => {
    arrive(url, page.title, ideaIdFrom(location.pathname) ?? '')
    a.setOffer(false)
    document.querySelectorAll('.a-pointed').forEach((el) => el.classList.remove('a-pointed'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, page.title])

  // 卡住的规则：同一个地址只提示一次。 / Stuck rules: one offer per address.
  useEffect(
    () =>
      subscribe(() => {
        const s = useAssistant.getState()
        if (s.open || s.running || offered.current.has(location.pathname)) return
        if (stuck(recentActions(), Date.now())) {
          offered.current.add(location.pathname)
          s.setOffer(true)
        }
      }),
    [location.pathname],
  )

  // 让页面给停靠的边栏让位。 / Make the page give way to the docked sidebar.
  useEffect(() => {
    document.documentElement.style.setProperty('--dock-w', a.open && !floating ? `${a.width}px` : '0px')
  }, [a.open, a.width, floating])

  useEffect(() => {
    const el = log.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  }, [a.turns])

  // 回合结束后：圈出元素，并刷新想法池（它可能记了愿望或提了候选）。
  // After a turn: mark pointed elements and reload the pool (it may have recorded a wish or proposed an idea).
  const lastStatus = a.turns[a.turns.length - 1]?.status
  useEffect(() => {
    const last = a.turns[a.turns.length - 1]
    if (!last || last.status === 'running') return
    const points = last.blocks.filter((b): b is Extract<Block, { kind: 'point' }> => b.kind === 'point').flatMap((b) => b.points)
    if (points.length) showPoints(points)
    if (last.blocks.some((b) => b.kind === 'idea' || b.kind === 'wish')) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastStatus, a.turns.length])

  const ask = (question: string) => {
    if (!question.trim() || a.running) return
    const main = document.querySelector('main.main')
    const snap = snapshot(main, page, url)
    follow.current = true
    setDraft('')
    void a.ask(question, snap, ideaIdFrom(location.pathname))
  }

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    const move = (ev: PointerEvent) => a.setWidth(window.innerWidth - ev.clientX)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!a.open) {
    return (
      <div className="a-launch" data-assistant>
        {a.offer && (
          <span className="a-offer">
            <button
              onClick={() => {
                a.setOpen(true)
                ask(EXPLAIN)
              }}
            >
              要我解释这一页吗
            </button>
            <button className="a-x" aria-label="不用" onClick={() => a.setOffer(false)}>
              ×
            </button>
          </span>
        )}
        <button className={`a-fab${a.running ? ' busy' : a.offer ? ' offer' : ''}`} aria-label="打开小助手" onClick={() => a.setOpen(true)}>
          ✦
        </button>
      </div>
    )
  }

  return (
    <aside
      className={`a-dock${floating ? ' floating' : ''}`}
      style={floating ? undefined : { width: a.width }}
      data-assistant
      aria-label="小助手"
      onKeyDown={(e) => floating && e.key === 'Escape' && a.setOpen(false)}
    >
      {!floating && (
        <div
          className="a-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整宽度"
          tabIndex={0}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={a.width}
          onPointerDown={startDrag}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') a.setWidth(a.width + 16)
            if (e.key === 'ArrowRight') a.setWidth(a.width - 16)
          }}
        />
      )}
      <header className="a-head">
        <div>
          <strong>小助手</strong>
          <div className="muted small">{a.running ? '正在回答…' : '读得到这一页和这个仓库'}</div>
        </div>
        <div className="a-tools">
          <button
            aria-label="以前的对话"
            title="以前的对话"
            aria-expanded={showHistory}
            onClick={() => {
              setShowHistory(!showHistory)
              if (!showHistory) void a.loadHistory()
            }}
          >
            ☰
          </button>
          <button aria-label="新对话" title="新对话" disabled={a.running} onClick={() => (a.newConversation(), setShowHistory(false))}>
            ＋
          </button>
          <Link to="/wishes" className="a-wishes" title="许愿池" aria-label={`许愿池，${a.openWishes} 条未处理`}>
            ✧{a.openWishes > 0 && <span className="num">{a.openWishes}</span>}
          </Link>
          <button aria-label="收起" title="收起" onClick={() => a.setOpen(false)}>
            ⌄
          </button>
        </div>
      </header>

      {showHistory ? (
        <div className="a-log">
          {a.history.length === 0 && <p className="muted">还没有以前的对话。</p>}
          <ul className="plain a-history">
            {a.history.map((c) => (
              <li key={c.id}>
                <button
                  className={c.id === a.conversationId ? 'current' : ''}
                  onClick={() => {
                    void a.openConversation(c.id)
                    setShowHistory(false)
                  }}
                >
                  <span>{c.title || '（没有问题）'}</span>
                  <span className="muted small">
                    {formatTime(c.created_at)} · {c.turns} 问
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div
          className="a-log"
          role="log"
          ref={log}
          onScroll={(e) => {
            const el = e.currentTarget
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {!a.ready && <p className="notice warn">{a.notReadyReason}，小助手现在用不了。</p>}
          {a.turns.length === 0 && (
            <div className="a-empty">
              <p className="a-hello">这一页哪里看不懂，或者想聊哪条 idea，直接问。</p>
              <div className="a-suggest">
                {SUGGESTIONS.map((q) => (
                  <button key={q} disabled={!a.ready} onClick={() => ask(q)}>
                    {q}
                  </button>
                ))}
              </div>
              <p className="muted small">工具本身哪里不顺手，跟我说，我会记进许愿池。</p>
            </div>
          )}
          {a.turns.map((t, i) => (
            <Turn key={i} turn={t} last={i === a.turns.length - 1} />
          ))}
          {a.error && <p className="err" role="alert">{a.error}</p>}
        </div>
      )}

      <form
        className="a-compose"
        onSubmit={(e) => {
          e.preventDefault()
          ask(draft)
        }}
      >
        <textarea
          aria-label="问小助手"
          rows={2}
          value={draft}
          placeholder="问点什么…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              ask(draft)
            }
          }}
        />
        <div className="a-compose-foot">
          <span className="muted small">Enter 发出 · 会带上这一页的内容</span>
          {a.running ? (
            <button type="button" onClick={() => void a.stop()}>
              停
            </button>
          ) : (
            <button type="submit" className="primary" disabled={!draft.trim() || !a.ready}>
              发出
            </button>
          )}
        </div>
      </form>
    </aside>
  )
}

function Turn({ turn, last }: { turn: TurnView; last: boolean }) {
  const running = turn.status === 'running'
  const refused = turn.steps.filter((s) => s.state === 'refused')
  return (
    <div className="a-turn">
      <div className="a-q">
        <div className="a-bubble">{turn.question}</div>
        {turn.page_title && <div className="muted small">在"{turn.page_title}"这一页问的</div>}
      </div>
      {turn.steps.length > 0 &&
        (running ? (
          <ul className="plain a-steps">
            {turn.steps.map((s) => (
              <li key={s.id} className={`s-${s.state}`}>
                <span aria-hidden="true">{s.state === 'running' ? '…' : s.state === 'done' ? '✓' : '⊘'}</span> {s.label}
              </li>
            ))}
          </ul>
        ) : (
          <details className="a-steps-done">
            <summary>
              过程：读了、查了 {turn.steps.length} 处{refused.length > 0 && `，其中 ${refused.length} 处没读到`}
            </summary>
            <ul className="plain a-steps">
              {turn.steps.map((s) => (
                <li key={s.id} className={`s-${s.state}`}>
                  <span aria-hidden="true">{s.state === 'refused' ? '⊘' : '✓'}</span> {s.label}
                  {s.state === 'refused' && '（没读到）'}
                </li>
              ))}
            </ul>
          </details>
        ))}
      {turn.blocks.map((b, i) => (
        <BlockView key={i} block={b} active={last} />
      ))}
      {running && turn.blocks.length === 0 && turn.steps.length === 0 && <p className="muted small">在想…</p>}
      {turn.status === 'done' && turn.seconds !== null && <div className="muted small a-foot">答完了，用时 {Math.round(turn.seconds)} 秒</div>}
      {turn.status === 'stopped' && <div className="muted small a-foot">停下了</div>}
      {turn.status === 'failed' && <div className="err small a-foot">{turn.message}</div>}
    </div>
  )
}

function BlockView({ block, active }: { block: Block; active: boolean }) {
  const load = useStore((s) => s.load)
  const refresh = useAssistant((s) => s.refresh)
  const [undone, setUndone] = useState(false)
  if (block.kind === 'text') return <Markdown text={block.text} />
  if (block.kind === 'wish') {
    return (
      <div className="a-card">
        <div>
          <span aria-hidden="true">✧</span>{' '}
          {undone ? '已撤销：' : block.fresh ? '已记入许愿池：' : `又遇到一次（第 ${block.occurrences} 次），记在这一条上：`}
          <strong>{block.title}</strong>
        </div>
        <div className="a-card-foot">
          <span className="muted small">{block.kind_label}</span>
          <Link to={`/wishes/${block.wish_id}`}>在许愿池里看</Link>
          {block.fresh && !undone && (
            <button
              onClick={() =>
                void api.withdrawWish(block.wish_id).then(() => {
                  setUndone(true)
                  void refresh()
                }, () => undefined)
              }
            >
              撤销
            </button>
          )}
        </div>
      </div>
    )
  }
  if (block.kind === 'idea') {
    return (
      <div className="a-card">
        <div>
          <span aria-hidden="true">＋</span> 提议了一条 idea，放在候选里：<strong>{block.title}</strong>
        </div>
        <div className="a-idea-body">
          {block.body.split('\n').map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
        <div className="a-card-foot">
          <span className="muted small">{block.level}</span>
          <Link to="/inbox" onClick={() => void load()}>
            去候选里决定留不留
          </Link>
        </div>
      </div>
    )
  }
  return (
    <div className="a-card">
      <div>在页面上圈出了 {block.points.length} 处：</div>
      <ol className="a-points">
        {block.points.map((p) => (
          <li key={p.ref}>{p.note}</li>
        ))}
      </ol>
      {active && (
        <button
          onClick={() => {
            clearRefs()
            document.querySelectorAll('.a-pointed').forEach((el) => el.classList.remove('a-pointed'))
            note('click', '收起圈出的标记')
          }}
        >
          收起标记
        </button>
      )}
    </div>
  )
}
