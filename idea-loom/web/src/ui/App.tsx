import { type ReactNode, useEffect, useState } from 'react'
import { NavLink, Route, Routes } from 'react-router'
import { IdeaPage } from '../pages/IdeaPage'
import { InboxPage } from '../pages/InboxPage'
import { LineagePage } from '../pages/LineagePage'
import { NewIdeaPage } from '../pages/NewIdeaPage'
import { MapPage } from '../pages/MapPage'
import { PlayPage } from '../pages/PlayPage'
import { PoolPage } from '../pages/PoolPage'
import { StatsPage } from '../pages/StatsPage'
import { SuggestPage } from '../pages/SuggestPage'
import { WorkPage } from '../pages/WorkPage'
import { WishPage, WishesPage } from '../pages/WishesPage'
import { AssistantDock } from '../assistant/AssistantDock'
import { useAssistant } from '../assistant/store'
import { install as installTrail } from '../assistant/trail'
import { applyLang, plural } from '../i18n'
import { type PushState, pushState, turnOff, turnOn } from '../push'
import { useStore, useT } from '../state/store'

const NAV = [
  { to: '/play', zh: '玩', en: 'Play', end: false, owner: false },
  { to: '/', zh: '地图', en: 'Map', end: true, owner: false },
  { to: '/ideas', zh: '想法池', en: 'Idea pool', end: false, owner: false },
  { to: '/inbox', zh: '生成与候选', en: 'Generate & candidates', end: false, owner: true },
  { to: '/lineage', zh: '血缘', en: 'Lineage', end: false, owner: false },
  { to: '/work', zh: '开发', en: 'Work', end: false, owner: true },
  { to: '/wishes', zh: '许愿池', en: 'Wish pool', end: false, owner: true },
  { to: '/stats', zh: '统计', en: 'Statistics', end: false, owner: true },
]

export function App() {
  const { me, state, error, load, theme, toggleTheme, lang, toggleLang, sync, syncing, syncResult, runSync, clearSyncResult, proposals } = useStore()
  const t = useT()
  const openWishes = useAssistant((a) => a.openWishes)
  const owner = me?.role === 'owner'
  // 主人的操作轨迹由小助手装上；登录的访客没有小助手，在这里装，记的是他自己的观看和收藏。
  // The assistant installs the owner's action trail; a signed-in member has no assistant, so it is installed here and records their own watching and likes.
  useEffect(() => {
    if (me?.role === 'member') installTrail()
  }, [me?.role])
  // 通知的开关只给主人；浏览器不支持或者服务器没配密钥时不显示。
  // The notification switch is for the owner only and is hidden when the browser lacks support or the server has no keys.
  const [push, setPush] = useState<PushState>('unsupported')
  useEffect(() => {
    if (owner) void pushState().then(setPush)
  }, [owner])
  // 只有主人能用的页面，别人看到的是一句说明。 / Pages only the owner can use show everyone else one line of explanation.
  const gate = (page: ReactNode) => (owner ? page : <p className="pad">{t('这一页只有主人能用。', 'Only the owner can use this page.')}</p>)
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  // 把 <html lang> 对上界面语言。 / Keep <html lang> in step with the UI language.
  useEffect(() => {
    applyLang(lang, false)
  }, [lang])

  return (
    <div className="shell">
      <nav className="nav" aria-label={t('主导航', 'Main navigation')}>
        <div className="mark">
          idea-loom<small>{t('想法池', 'Idea pool')}</small>
        </div>
        {NAV.filter((n) => owner || !n.owner).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className="nav-item">
            {t(n.zh, n.en)}
            {n.to === '/ideas' && state && <span className="count num">{state.counts.live}</span>}
            {n.to === '/wishes' && openWishes > 0 && <span className="count pill num">{openWishes}</span>}
            {n.to === '/inbox' && proposals && proposals.open > 0 && <span className="count pill num">{proposals.open}</span>}
          </NavLink>
        ))}
        {me?.auth_enabled && !owner && (
          <NavLink to="/suggest" className="nav-item nav-new">
            {t('提个愿望', 'Send a wish')}
          </NavLink>
        )}
        {owner && (
          <NavLink to="/new" className="nav-item nav-new">
            {t('＋ 手写一条', '＋ Write one')}
          </NavLink>
        )}
        <div className="nav-foot">
          {sync && (
            <div className="sync">
              {sync.can_sync ? (
                <>
                  <div className="small">
                    {sync.pending > 0
                      ? t(`${sync.pending} 处改动还没进仓库`, `${plural(sync.pending, 'change')} not in the repository yet`)
                      : sync.ideas_md_stale
                        ? t('IDEAS.md 需要更新', 'IDEAS.md needs an update')
                        : t('愿望或任务有改动还没进仓库', 'Wish or task changes not in the repository yet')}
                  </div>
                  <button className="primary" disabled={syncing} onClick={() => void runSync()}>
                    {syncing ? t('正在同步…', 'Syncing…') : t('同步到仓库', 'Sync to repository')}
                  </button>
                </>
              ) : (
                <div className="muted small">{sync.reason ?? t('已和仓库同步', 'In sync with the repository')}</div>
              )}
            </div>
          )}
          {me?.auth_enabled && (
            <div className="who">
              {me.role === 'guest' ? (
                <a className="button" href="/auth/login">
                  {t('用 GitHub 登录', 'Sign in with GitHub')}
                </a>
              ) : (
                <form method="post" action="/auth/logout" className="row">
                  <span className="small who-name" title={me.role === 'owner' ? t('主人', 'Owner') : t('访客', 'Member')}>
                    {me.name || me.login}
                  </span>
                  <button type="submit">{t('退出', 'Sign out')}</button>
                </form>
              )}
            </div>
          )}
          <div className="row">
            {owner && (push === 'on' || push === 'off') && (
              <button
                aria-pressed={push === 'on'}
                title={push === 'on' ? t('通知开着：方案待批、作业结果、访客的愿望会推到这台设备', 'Notifications are on: plans to approve, job results and visitors’ wishes are pushed to this device') : t('打开通知', 'Turn notifications on')}
                onClick={() => void (push === 'on' ? turnOff() : turnOn()).then(setPush)}
              >
                {push === 'on' ? t('通知 ✓', 'Alerts ✓') : t('通知', 'Alerts')}
              </button>
            )}
            {owner && push === 'blocked' && <span className="muted small" title={t('浏览器里把这个站点的通知禁掉了，要到浏览器的设置里放开', 'Notifications for this site are blocked in the browser; allow them in its settings')}>{t('通知被禁', 'Alerts blocked')}</span>}
            <button onClick={toggleTheme} aria-label={t('切换昼夜配色', 'Switch between light and dark')}>
              {theme === 'dark' ? t('昼', 'Light') : t('夜', 'Dark')}
            </button>
            {/* 两种语言都写上，不管现在是哪种都读得懂。 / Both languages, readable whichever is showing. */}
            <button onClick={toggleLang} aria-label="切换到英文 / Switch to Chinese" lang={lang === 'en' ? 'zh-CN' : 'en'}>
              {lang === 'en' ? '中' : 'EN'}
            </button>
          </div>
        </div>
      </nav>
      <main className="main">
        {error && (
          <div className="notice bad" role="alert">
            {error} <button onClick={() => void load()}>{t('重试', 'Retry')}</button>
          </div>
        )}
        {syncResult && (
          <div className={`notice ${syncResult.ok ? 'good' : 'bad'}`} role="status">
            {syncResult.message}
            {syncResult.pr_url && (
              <>
                {' '}
                <a href={syncResult.pr_url} target="_blank" rel="noreferrer">
                  {t('看这个合并请求', 'See the pull request')}
                </a>
              </>
            )}{' '}
            <button onClick={clearSyncResult}>{t('知道了', 'Got it')}</button>
          </div>
        )}
        {state && state.unreadable > 0 && (
          <div className="notice warn">
            {t(`事件日志里有 ${state.unreadable} 行读不出来，已跳过。`, `${plural(state.unreadable, 'line')} in the event log could not be read and ${state.unreadable === 1 ? 'was' : 'were'} skipped.`)}
          </div>
        )}
        {!state && !error && <p className="muted pad">{t('正在读取想法池…', 'Loading the idea pool…')}</p>}
        {state && (
          <Routes>
            <Route path="/" element={<MapPage state={state} />} />
            <Route path="/ideas" element={<PoolPage state={state} />} />
            <Route path="/ideas/:id" element={<IdeaPage state={state} />} />
            <Route path="/inbox" element={gate(<InboxPage state={state} />)} />
            <Route path="/lineage" element={<LineagePage state={state} />} />
            <Route path="/play" element={<PlayPage state={state} />} />
            <Route path="/work" element={gate(<WorkPage state={state} />)} />
            <Route path="/stats" element={gate(<StatsPage state={state} />)} />
            <Route path="/wishes" element={gate(<WishesPage />)} />
            <Route path="/wishes/:id" element={gate(<WishPage />)} />
            <Route path="/new" element={gate(<NewIdeaPage state={state} />)} />
            <Route path="/suggest" element={<SuggestPage />} />
            <Route path="*" element={<p className="pad">{t('没有这个页面。', 'There is no such page.')}</p>} />
          </Routes>
        )}
      </main>
      {owner && <AssistantDock />}
    </div>
  )
}
