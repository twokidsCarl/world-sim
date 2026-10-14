import { useEffect, useRef, useState } from 'react'
import { type Attached, MAX_IMAGES, canCapture, captureTab, fromFile, imagesIn } from './images'
import { Link, useLocation } from 'react-router'
import { api } from '../api'
import { useDraft } from '../sessions/drafts'
import { plural } from '../i18n'
import { formatTime } from '../state/derive'
import { useStore, useT } from '../state/store'
import { Markdown } from './Markdown'
import { clearRefs, snapshot } from './pageSnapshot'
import { MAX_WIDTH, MIN_WIDTH, useAssistant } from './store'
import { stuck } from './stuck'
import { arrive, install, note, recentActions, subscribe } from './trail'
import { type Block, type TurnView, imageUrls } from './turnView'

// 建议的问题和"解释这一页"的那句话：[中文, 英文]。界面是英文时，发出去的也是英文。
// The suggested questions and the canned "explain this page" question: [Chinese, English].
// When the UI is English, the English one is what gets sent.
const SUGGESTIONS: [string, string][] = [
  ['这一页是讲什么的？', 'What is this page about?'],
  ['我下一步该点哪里？', 'Where should I click next?'],
  ['想法池现在哪里最薄？', 'Where is the idea pool thinnest right now?'],
]
const EXPLAIN: [string, string] = ['请解释一下这一页：它在回答什么，我接下来可以做什么。', 'Please explain this page: what it answers and what I can do next.']
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
  const t = useT()
  const location = useLocation()
  // 草稿存起来，刷新页面也还在。 / The draft is stored and survives a page reload.
  const { text: draft, setText: setDraft, images: attached, setImages: setAttached } = useDraft('assistant')
  const [floating, setFloating] = useState(typeof window !== 'undefined' && window.innerWidth < FLOAT_BELOW)
  const [showHistory, setShowHistory] = useState(false)
  const log = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const offered = useRef(new Set<string>())
  const url = location.pathname + location.search

  useEffect(() => {
    install()
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

  const [imageNote, setImageNote] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const addImages = async (files: File[]) => {
    const made = (await Promise.all(files.map(fromFile))).filter((x): x is Attached => x !== null)
    setAttached((now) => {
      const next = [...now, ...made].slice(0, MAX_IMAGES)
      setImageNote(now.length + made.length > MAX_IMAGES ? t(`一次最多带 ${MAX_IMAGES} 张图`, `At most ${MAX_IMAGES} images at a time`) : files.length > made.length ? t('有的文件不是图片，没有加上', 'Some files were not images and were left out') : null)
      return next
    })
  }
  const capture = async () => {
    const shot = await captureTab(t('当前页面的截屏', 'capture of the current page'))
    if (shot) setAttached((now) => [...now, shot].slice(0, MAX_IMAGES))
    else setImageNote(t('没有截到（取消了，或者浏览器不支持）。也可以直接把截图粘贴进来。', 'Nothing was captured (cancelled, or the browser lacks support). You can also paste a screenshot in.'))
  }
  const ask = (question: string) => {
    if ((!question.trim() && attached.length === 0) || a.running) return
    const main = document.querySelector('main.main')
    const snap = snapshot(main, page, url)
    follow.current = true
    setDraft('')
    const images = attached
    setAttached([])
    setImageNote(null)
    void a.ask(question.trim() || t('看这张图。', 'Look at this image.'), snap, page.idea ?? ideaIdFrom(location.pathname), images)
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
                ask(t(...EXPLAIN))
              }}
            >
              {t('要我解释这一页吗', 'Shall I explain this page?')}
            </button>
            <button className="a-x" aria-label={t('不用', 'No thanks')} onClick={() => a.setOffer(false)}>
              ×
            </button>
          </span>
        )}
        <button className={`a-fab${a.running ? ' busy' : a.offer ? ' offer' : ''}`} aria-label={t('打开小助手', 'Open the assistant')} onClick={() => a.setOpen(true)}>
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
      aria-label={t('小助手', 'Assistant')}
      onKeyDown={(e) => floating && e.key === 'Escape' && a.setOpen(false)}
    >
      {!floating && (
        <div
          className="a-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('调整宽度', 'Resize')}
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
          <strong>{t('小助手', 'Assistant')}</strong>
          <div className="muted small">{a.running ? t('正在回答…', 'Answering…') : t('读得到这一页和这个仓库', 'Can read this page and this repository')}</div>
        </div>
        <div className="a-tools">
          <button
            aria-label={t('以前的对话', 'Earlier conversations')}
            title={t('以前的对话', 'Earlier conversations')}
            aria-expanded={showHistory}
            onClick={() => {
              setShowHistory(!showHistory)
              if (!showHistory) void a.loadHistory()
            }}
          >
            ☰
          </button>
          <button aria-label={t('新对话', 'New conversation')} title={t('新对话', 'New conversation')} disabled={a.running} onClick={() => (a.newConversation(), setShowHistory(false))}>
            ＋
          </button>
          <Link to="/wishes" className="a-wishes" title={t('许愿池', 'Wish pool')} aria-label={t(`许愿池，${a.pendingWishes} 条待处理`, `Wish pool, ${a.pendingWishes} to handle`)}>
            ✧{a.pendingWishes > 0 && <span className="num">{a.pendingWishes}</span>}
          </Link>
          <button aria-label={t('收起', 'Collapse')} title={t('收起', 'Collapse')} onClick={() => a.setOpen(false)}>
            ⌄
          </button>
        </div>
      </header>

      {showHistory ? (
        <div className="a-log">
          {a.history.length === 0 && <p className="muted">{t('还没有以前的对话。', 'No earlier conversations yet.')}</p>}
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
                  <span>{c.title || t('（没有问题）', '(no question)')}</span>
                  <span className="muted small">
                    {formatTime(c.created_at)} · {t(`${c.turns} 问`, plural(c.turns, 'question'))}
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
          {!a.ready && <p className="notice warn">{t(`${a.notReadyReason}，小助手现在用不了。`, `${a.notReadyReason}; the assistant is unavailable for now.`)}</p>}
          {a.turns.length === 0 && (
            <div className="a-empty">
              <p className="a-hello">{t('这一页哪里看不懂，或者想聊哪条 idea，直接问。', 'If something on this page is unclear, or you want to talk about an idea, just ask.')}</p>
              <div className="a-suggest">
                {SUGGESTIONS.map((q) => (
                  <button key={q[0]} disabled={!a.ready} onClick={() => ask(t(...q))}>
                    {t(...q)}
                  </button>
                ))}
              </div>
              <p className="muted small">{t('工具本身哪里不顺手，跟我说，我会记进许愿池。', 'If the tool itself gets in your way, tell me and I will record it in the wish pool.')}</p>
            </div>
          )}
          {a.turns.map((t, i) => (
            <Turn key={i} turn={t} last={i === a.turns.length - 1} images={imageUrls(t, a.conversationId)} />
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
        onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
        onDrop={(e) => {
          const files = imagesIn(e.dataTransfer.items)
          if (files.length) {
            e.preventDefault()
            void addImages(files)
          }
        }}
      >
        {attached.length > 0 && (
          <div className="a-thumbs">
            {attached.map((image, i) => (
              <span key={i} className="a-thumb">
                <img src={image.url} alt={image.name || t('附的图', 'attached image')} />
                <button type="button" aria-label={t('去掉这张图', 'Remove this image')} onClick={() => setAttached(attached.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
          </div>
        )}
        {imageNote && <p className="muted small" role="status">{imageNote}</p>}
        <textarea
          aria-label={t('问小助手', 'Ask the assistant')}
          rows={2}
          value={draft}
          placeholder={t('问点什么…', 'Ask something…')}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const files = imagesIn(e.clipboardData.items)
            if (files.length) {
              e.preventDefault()
              void addImages(files)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              ask(draft)
            }
          }}
        />
        <div className="a-compose-foot">
          <span className="a-attach">
            <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => (void addImages([...(e.target.files ?? [])]), (e.target.value = ''))} />
            <button type="button" title={t('附一张图（也可以直接粘贴或拖进来）', 'Attach an image (you can also paste or drop one in)')} aria-label={t('附一张图', 'Attach an image')} onClick={() => picker.current?.click()}>＋{t('图', 'Image')}</button>
            {canCapture() && (
              <button type="button" title={t('把当前这一页截下来带上，嵌着的模拟也截得到；浏览器会问一次要不要共享这个标签页', 'Capture this page and send it along, embedded simulations included; the browser asks once whether to share this tab')} onClick={() => void capture()}>{t('截这一页', 'Capture page')}</button>
            )}
          </span>
          <span className="muted small a-hint">{t('Enter 发出 · 会带上这一页的内容', 'Enter to send · the content of this page goes along')}</span>
          {a.running ? (
            <button type="button" onClick={() => void a.stop()}>
              {t('停', 'Stop')}
            </button>
          ) : (
            <button type="submit" className="primary" disabled={(!draft.trim() && attached.length === 0) || !a.ready}>
              {t('发出', 'Send')}
            </button>
          )}
        </div>
      </form>
    </aside>
  )
}

function Turn({ turn, last, images }: { turn: TurnView; last: boolean; images: string[] }) {
  const running = turn.status === 'running'
  const t = useT()
  const refused = turn.steps.filter((s) => s.state === 'refused')
  return (
    <div className="a-turn">
      <div className="a-q">
        {images.length > 0 && (
          <div className="a-thumbs sent">
            {images.map((src, i) => (
              <a key={i} href={src} target="_blank" rel="noreferrer" className="a-thumb"><img src={src} alt="" /></a>
            ))}
          </div>
        )}
        <div className="a-bubble">{turn.question}</div>
        {turn.page_title && <div className="muted small">{t(`在"${turn.page_title}"这一页问的`, `Asked on the "${turn.page_title}" page`)}</div>}
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
              {t(`过程：读了、查了 ${turn.steps.length} 处`, `Steps: ${plural(turn.steps.length, 'read or lookup')}`)}
              {refused.length > 0 && t(`，其中 ${refused.length} 处没读到`, `, ${refused.length} of them not readable`)}
            </summary>
            <ul className="plain a-steps">
              {turn.steps.map((s) => (
                <li key={s.id} className={`s-${s.state}`}>
                  <span aria-hidden="true">{s.state === 'refused' ? '⊘' : '✓'}</span> {s.label}
                  {s.state === 'refused' && t('（没读到）', ' (not readable)')}
                </li>
              ))}
            </ul>
          </details>
        ))}
      {turn.blocks.map((b, i) => (
        <BlockView key={i} block={b} active={last} />
      ))}
      {running && turn.blocks.length === 0 && turn.steps.length === 0 && <p className="muted small">{t('在想…', 'Thinking…')}</p>}
      {turn.status === 'done' && turn.seconds !== null && <div className="muted small a-foot">{t(`答完了，用时 ${Math.round(turn.seconds)} 秒`, `Answered in ${Math.round(turn.seconds)} s`)}</div>}
      {turn.status === 'stopped' && <div className="muted small a-foot">{t('停下了', 'Stopped')}</div>}
      {turn.status === 'failed' && <div className="err small a-foot">{turn.message || t('出错了', 'Something went wrong')}</div>}
    </div>
  )
}

function BlockView({ block, active }: { block: Block; active: boolean }) {
  const load = useStore((s) => s.load)
  const refresh = useAssistant((s) => s.refresh)
  const [undone, setUndone] = useState(false)
  const t = useT()
  if (block.kind === 'text') return <Markdown text={block.text} />
  if (block.kind === 'wish') {
    return (
      <div className="a-card">
        <div>
          <span aria-hidden="true">✧</span>{' '}
          {undone
            ? t('已撤销：', 'Withdrawn: ')
            : block.fresh
              ? t('已记入许愿池：', 'Recorded in the wish pool: ')
              : t(`又遇到一次（第 ${block.occurrences} 次），记在这一条上：`, `Seen again (time ${block.occurrences}), recorded on this wish: `)}
          <strong>{block.title}</strong>
        </div>
        <div className="a-card-foot">
          <span className="muted small">{block.kind_label}</span>
          <Link to={`/wishes/${block.wish_id}`}>{t('在许愿池里看', 'See it in the wish pool')}</Link>
          {block.fresh && !undone && (
            <button
              onClick={() =>
                void api.withdrawWish(block.wish_id).then(() => {
                  setUndone(true)
                  void refresh()
                }, () => undefined)
              }
            >
              {t('撤销', 'Withdraw')}
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
          <span aria-hidden="true">＋</span> {t('提议了一条 idea，放在候选里：', 'Proposed an idea, now among the candidates: ')}<strong>{block.title}</strong>
        </div>
        <div className="a-idea-body">
          {block.body.split('\n').map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
        <div className="a-card-foot">
          <span className="muted small">{block.level}</span>
          <Link to="/inbox" onClick={() => void load()}>
            {t('去候选里决定留不留', 'Decide whether to keep it, among the candidates')}
          </Link>
        </div>
      </div>
    )
  }
  return (
    <div className="a-card">
      <div>{t(`在页面上圈出了 ${block.points.length} 处：`, `Marked ${plural(block.points.length, 'place')} on the page:`)}</div>
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
            note('click', t('收起圈出的标记', 'Hide the marks'))
          }}
        >
          {t('收起标记', 'Hide the marks')}
        </button>
      )}
    </div>
  )
}
