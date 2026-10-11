import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { type CardView, type PlayView, api } from '../api'
import { useAssistant } from '../assistant/store'
import { note } from '../assistant/trail'
import type { State } from '../contract'
import { pick } from '../i18n'
import { type Ranked, type Reason, rank } from '../play/feed'
import { useLang, useStore, useT } from '../state/store'
import { Page } from '../ui/Page'
import { SimFrame, embedUrl } from '../ui/SimFrame'
import { IdeaLink, levelName } from '../ui/bits'

const WHY: Record<Reason, [string, string]> = {
  unseen: ['还没看过', 'Not seen yet'],
  'liked-idea': ['你收藏过同一条 idea 的卡', 'You liked a card of the same idea'],
  'liked-level': ['你收藏过同一层的卡', 'You liked a card on the same level'],
  liked: ['你收藏过它', 'You liked it'],
  skipped: ['上次很快就划走了', 'Left quickly last time'],
  seen: ['看过了', 'Seen before'],
  'not-ready': ['还没准备好', 'Not ready yet'],
  explore: ['随机挑的，换换口味', 'Picked at random, for variety'],
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// 单列的卡片流：一屏一张，一次只运行当前这一张。
// A single-column feed: one card per screen, and only the current one runs.
export function PlayPage({ state }: { state: State }) {
  const t = useT()
  const lang = useLang()
  const [params, setParams] = useSearchParams()
  const openAssistant = useAssistant((a) => a.setOpen)
  const me = useStore((s) => s.me)
  const owner = me?.role === 'owner'
  const [view, setView] = useState<PlayView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [order, setOrder] = useState<Ranked<CardView>[]>([])
  const [index, setIndex] = useState(0)
  const [liked, setLiked] = useState<Record<string, boolean>>({})
  const [reload, setReload] = useState(0)
  const [showWhy, setShowWhy] = useState(false)
  // 每次进这一页用一个新的种子：探索位每次不同，但在这一页里顺序不变。
  // A new seed for each visit to the page: exploration slots differ between visits, and the order stays put during one.
  const [seed] = useState(() => Math.floor(Math.random() * 0x100000000))
  const shown = useRef<{ key: string; idea: string; since: number; hidden: number; hiddenAt: number | null } | null>(null)

  const load = useCallback(
    () =>
      api.play().then(
        (v) => (setView(v), setError(null), v),
        (e: Error) => (setError(e.message), null),
      ),
    [],
  )

  // 进来时排一次序，之后不再自己重排：看着看着顺序变了会很怪。
  // Rank once on arrival and never reshuffle by itself: an order that changes under you is disorienting.
  useEffect(() => {
    void load().then((v) => {
      if (!v) return
      const ranked = rank(v.cards, v.history, seed)
      const wanted = params.get('card')
      const at = wanted ? ranked.findIndex((r) => r.card.key === wanted) : -1
      if (at > 0) ranked.unshift(...ranked.splice(at, 1))
      setOrder(ranked)
      setIndex(0)
      setLiked(Object.fromEntries(Object.entries(v.history).map(([k, h]) => [k, h.liked])))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 有项目在构建时，每隔几秒看一眼状态。 / While something is building, look again every few seconds.
  const building = view?.sims.some((s) => s.ready && s.status === 'building') ?? false
  useEffect(() => {
    if (!building) return
    const timer = setInterval(() => void load(), 4000)
    return () => clearInterval(timer)
  }, [building, load])

  // 有项目构建失败在等重试时，隔半分钟看一眼：读这个接口本身就会在到点后重试。
  // While a failed build waits for its retry, look every half minute: reading the view is what triggers the retry.
  const waiting = view?.sims.some((s) => s.ready && s.status === 'failed' && !!s.next_retry) ?? false
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => void load(), 30000)
    return () => clearInterval(timer)
  }, [waiting, load])

  const current = order[index]
  const card = current?.card
  const sim = view?.sims.find((s) => s.name === card?.sim)

  // 记下这张卡看了多久：只算标签页在前台的时间，最多十分钟。
  // Record how long this card was watched: only time with the tab in front, ten minutes at most.
  const close = useCallback(() => {
    const s = shown.current
    if (!s) return
    shown.current = null
    const hidden = s.hidden + (s.hiddenAt ? Date.now() - s.hiddenAt : 0)
    const seconds = Math.min(600, Math.max(0, Math.round((Date.now() - s.since - hidden) / 100) / 10))
    note('play', s.key, { seconds, idea: s.idea, card: s.key })
  }, [])
  useEffect(() => {
    if (!card) return
    shown.current = { key: card.key, idea: card.idea ?? '', since: Date.now(), hidden: 0, hiddenAt: document.hidden ? Date.now() : null }
    const onVisibility = () => {
      const s = shown.current
      if (!s) return
      if (document.hidden) s.hiddenAt = Date.now()
      else if (s.hiddenAt) {
        s.hidden += Date.now() - s.hiddenAt
        s.hiddenAt = null
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', close)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', close)
      close()
    }
  }, [card?.key, reload, close])

  const go = useCallback(
    (delta: number) => {
      setShowWhy(false)
      setIndex((i) => Math.min(order.length - 1, Math.max(0, i + delta)))
    },
    [order.length],
  )
  useEffect(() => {
    if (card && params.get('card') !== card.key) setParams({ card: card.key }, { replace: true })
  }, [card?.key])

  // 键盘上下键和 j / k 切卡。焦点在模拟里面时按键归模拟，所以这里只管页面自己的焦点。
  // Arrow keys and j / k switch cards. With focus inside the simulation the keys belong to it,
  // so this only handles the page's own focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      if (e.key === 'ArrowDown' || e.key === 'j') (e.preventDefault(), go(1))
      if (e.key === 'ArrowUp' || e.key === 'k') (e.preventDefault(), go(-1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])

  // 鼠标在卡片两侧的空白处滚动也能切卡；在模拟里面滚动归模拟自己（很多模拟用滚轮缩放）。
  // Scrolling in the margins beside the card switches cards too; inside the simulation the
  // wheel belongs to it (many simulations zoom with it).
  const lastWheel = useRef(0)
  const onWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaY) < 30 || Date.now() - lastWheel.current < 600) return
    lastWheel.current = Date.now()
    go(e.deltaY > 0 ? 1 : -1)
  }

  const toggleLike = () => {
    if (!card) return
    const next = !liked[card.key]
    setLiked({ ...liked, [card.key]: next })
    note(next ? 'like' : 'unlike', card.key, { card: card.key, idea: card.idea ?? '' })
  }

  const title = card ? pick(lang, card.title.zh, card.title.en) : t('玩', 'Play')
  const lead = useMemo(() => (card ? `${card.sim} · ${pick(lang, card.hint.zh, card.hint.en)}` : ''), [card, lang])

  return (
    <Page title={title} lead={lead} idea={card?.idea ?? undefined}>
      {error && <div className="notice bad" role="alert">{error}</div>}
      {view && view.problems.length > 0 && (
        <div className="notice warn">
          {t('这些项目的名片读不出来：', 'These card files could not be read: ')}
          {view.problems.map((p) => `${p.name}（${p.error}）`).join('；')}
        </div>
      )}
      {!view && !error && <p className="muted">{t('正在准备卡片…', 'Preparing the cards…')}</p>}
      {view && order.length === 0 && <p className="muted">{t('还没有可以玩的卡片。', 'No cards to play yet.')}</p>}

      {card && sim && (
        <div className="play" onWheel={onWheel}>
          <div className="play-stage">
            {sim.playable ? (
              <SimFrame key={`${card.key}:${reload}`} card={card} className="play-frame" />
            ) : (
              <div className="play-wait">
                <h3>{sim.status === 'failed' ? t(`${sim.name} 构建失败`, `${sim.name} failed to build`) : t(`${sim.name} 正在构建…`, `${sim.name} is building…`)}</h3>
                <pre className="job-pre">{sim.log}</pre>
                {sim.status === 'failed' && sim.next_retry && (
                  <p className="muted small">{t(`将在 ${clock(sim.next_retry)} 自动重试（第 ${sim.attempts} 次失败）`, `Retrying automatically at ${clock(sim.next_retry)} (failure ${sim.attempts})`)}</p>
                )}
              </div>
            )}
          </div>

          <div className="play-rail" role="group" aria-label={t('卡片操作', 'Card actions')}>
            <button onClick={() => go(-1)} disabled={index === 0} title={t('上一张（↑ 或 k）', 'Previous (↑ or k)')} aria-label={t('上一张', 'Previous')}>
              ↑
            </button>
            <button className="primary" onClick={() => go(1)} disabled={index >= order.length - 1} title={t('下一张（↓ 或 j）', 'Next (↓ or j)')} aria-label={t('下一张', 'Next')}>
              ↓
            </button>
            {/* 收藏要记到人头上，游客没有；小助手只为主人调用模型。 / A like is recorded per person, so a guest has none; the assistant calls the model for the owner only. */}
            {me?.role !== 'guest' && <button onClick={toggleLike} aria-pressed={!!liked[card.key]} title={t('收藏：以后多推同一条 idea、同一层的卡', 'Like: more cards of the same idea and level later')}>
              {liked[card.key] ? '♥' : '♡'}
              <span className="small">{liked[card.key] ? t('已收藏', 'Liked') : t('收藏', 'Like')}</span>
            </button>}
            {owner && <button onClick={() => openAssistant(true)} title={t('问小助手：它会带上这张卡和它的 idea', 'Ask the assistant: it gets this card and its idea')}>
              ✦<span className="small">{t('问', 'Ask')}</span>
            </button>}
            <button onClick={() => void api.play(true).then((v) => (setView(v), setReload(reload + 1)), () => setReload(reload + 1))} title={t('重来：把这个模拟重新加载一遍', 'Restart: reload this simulation')}>
              ↻<span className="small">{t('重来', 'Restart')}</span>
            </button>
            <a href={embedUrl(card.url).replace(/[?&]embed=1/, '')} target="_blank" rel="noreferrer" title={t('在新窗口打开完整的界面', 'Open the full UI in a new window')}>
              ↗<span className="small">{t('完整版', 'Full')}</span>
            </a>
          </div>

          <div className="play-caption">
            <div className="play-count num muted small">
              {index + 1} / {order.length}
            </div>
            <div className="play-meta">
              <span className="chip project">{card.sim}</span>
              {card.level && <span className="muted small">{levelName(state, card.level, lang)}</span>}
              {card.idea && (
                <span className="small">
                  {t('属于', 'Belongs to')} <IdeaLink id={card.idea} state={state} />
                </span>
              )}
              {sim.stale && sim.status === 'building' && <span className="muted small">{t('main 上有新版本，正在重新构建；现在是上一个版本', 'A newer version on main is building; this is the previous one')}</span>}
              {sim.source === 'interim' && <span className="muted small" title={t('这个项目还没有提交自己的 sim.json', 'This project has not committed its own sim.json yet')}>{t('临时名片', 'interim card file')}</span>}
              <button className="link" aria-expanded={showWhy} onClick={() => setShowWhy(!showWhy)}>
                {t('为什么推这张', 'Why this card')}
              </button>
            </div>
            {showWhy && (
              <p className="small muted">
                {current.reasons.map((r) => t(WHY[r][0], WHY[r][1])).join(t('；', '; '))}
                {t(`。打分 ${current.score}；相邻两张尽量不是同一个项目。`, `. Score ${current.score}; neighbours are kept from the same project where possible.`)}{' '}
                <Link to="/stats">{t('看统计', 'See statistics')}</Link>
              </p>
            )}
          </div>
        </div>
      )}

      {view && (
        <details className="table-view play-sims">
          <summary>{t(`托管的模拟（${view.sims.length} 个，${view.cards.length} 张卡）`, `Hosted simulations (${view.sims.length}, ${view.cards.length} cards)`)}</summary>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('项目', 'Project')}</th>
                <th scope="col">{t('状态', 'State')}</th>
                <th scope="col">{t('版本', 'Version')}</th>
                <th scope="col" className="r">{t('卡片', 'Cards')}</th>
                <th scope="col">{t('后端', 'Backend')}</th>
              </tr>
            </thead>
            <tbody>
              {view.sims.map((s) => (
                <tr key={s.name}>
                  <td>
                    <a href={s.origin} target="_blank" rel="noreferrer">{s.name}</a> <span className="muted small">{pick(lang, s.title.zh, s.title.en)}</span>
                  </td>
                  <td>
                    {{ ready: t('● 就绪', '● Ready'), building: t('◌ 构建中', '◌ Building'), failed: t('× 失败', '× Failed'), missing: t('○ 还没构建', '○ Not built') }[s.status] ?? s.status}
                    {s.status !== 'ready' && s.playable && <span className="muted small"> {t('（在用上一个版本）', '(serving the previous build)')}</span>}
                    {s.status === 'failed' && s.next_retry && <span className="muted small"> {t(`${clock(s.next_retry)} 自动重试`, `retry at ${clock(s.next_retry)}`)}</span>}
                  </td>
                  <td className="num small">{s.version || '—'}</td>
                  <td className="r num">{s.cards}</td>
                  <td className="small">{s.has_api ? (s.api_running ? t('在跑', 'running') : t('用到时启动', 'starts on demand')) : t('不需要', 'none')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </Page>
  )
}
