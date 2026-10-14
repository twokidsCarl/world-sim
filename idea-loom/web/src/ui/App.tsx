import { type ReactNode, useEffect, useState } from 'react'
import { Link, NavLink, Route, Routes, useLocation } from 'react-router'
import { IdeaPage } from '../pages/IdeaPage'
import { InboxPage } from '../pages/InboxPage'
import { LineagePage } from '../pages/LineagePage'
import { NewIdeaPage } from '../pages/NewIdeaPage'
import { MapPage } from '../pages/MapPage'
import { PlayPage } from '../pages/PlayPage'
import { PoolPage } from '../pages/PoolPage'
import { ConnectPage } from '../pages/ConnectPage'
import { SessionsPage } from '../pages/SessionsPage'
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
import { useStale } from '../version'
import { Icon } from './icons'
import { IDEA_VIEWS, NAV, ideaView, navEntry } from './nav'
import { watch } from './watch'

export function App() {
  const { me, state, error, load, theme, toggleTheme, lang, toggleLang, navNarrow, toggleNav, sync, syncing, syncResult, runSync, clearSyncResult, proposals } = useStore()
  const t = useT()
  const pendingWishes = useAssistant((a) => a.pendingWishes)
  const refreshAssistant = useAssistant((a) => a.refresh)
  const owner = me?.role === 'owner'
  // 现在这一页属于哪个菜单项，是不是「想法」的某个视图。
  // Which menu entry the current page belongs to, and whether it is one of the views of "Ideas".
  const { pathname } = useLocation()
  const here = navEntry(pathname)
  const view = ideaView(pathname)
  // 后端重启过或界面重新构建过，这一页就过时了；只提示，不自己刷新，免得打断正在写的东西。
  // After a backend restart or a UI rebuild this page is out of date; it only says so and never reloads by itself, so nothing being typed is lost.
  const stale = useStale()
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
  // 许愿池的数（还有小助手能不能用）跟着后端走：进来、回到前台、看得见时每隔一会儿各取一次。命令行里改了状态也跟得上。
  // The wish pool count (and whether the assistant can be used) follows the backend: fetched on arrival, on coming back to the front, and every so often while visible. Status changes made from the command line show up too.
  useEffect(() => (owner ? watch(() => void refreshAssistant()) : undefined), [owner, refreshAssistant])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  // 把 <html lang> 对上界面语言。 / Keep <html lang> in step with the UI language.
  useEffect(() => {
    applyLang(lang, false)
  }, [lang])

  return (
    <div className={navNarrow ? 'shell nav-narrow' : 'shell'}>
      <nav className="nav" aria-label={t('主导航', 'Main navigation')}>
        <div className="mark">
          <span className="nav-full">idea-loom</span>
          <span className="nav-short" aria-hidden="true"><Icon name="loom" /></span>
          <small>{t('想法经纬', 'Idea loom')}</small>
        </div>
        {NAV.filter((n) => (owner || !n.owner) && (n.to !== '/sessions' || me?.auth_enabled === false)).map((n) => (
          <Link key={n.to} to={n.to} className={n === here ? 'nav-item active' : 'nav-item'} aria-current={n === here ? 'page' : undefined} aria-label={t(n.zh, n.en)} title={navNarrow ? t(n.zh, n.en) : undefined}>
            <span className="nav-full">{t(n.zh, n.en)}</span>
            <span className="nav-short" aria-hidden="true"><Icon name={n.icon} /></span>
            {n.to === '/' && state && <span className="count num">{state.counts.live}</span>}
            {n.to === '/wishes' && pendingWishes > 0 && <span className="count pill num">{pendingWishes}</span>}
            {n.to === '/' && owner && proposals && proposals.open > 0 && <span className="count pill num">{proposals.open}</span>}
          </Link>
        ))}
        {me?.auth_enabled && !owner && (
          <NavLink to="/suggest" className="nav-item nav-new" aria-label={t('提个愿望', 'Send a wish')} title={navNarrow ? t('提个愿望', 'Send a wish') : undefined}>
            <span className="nav-full">{t('提个愿望', 'Send a wish')}</span>
            <span className="nav-short" aria-hidden="true"><Icon name="plus" /></span>
          </NavLink>
        )}
        <div className="nav-foot">
          {sync && (
            <div className="sync">
              {sync.can_sync ? (
                <>
                  <div className="small nav-full">
                    {sync.pending > 0
                      ? t(`${sync.pending} 处改动还没进仓库`, `${plural(sync.pending, 'change')} not in the repository yet`)
                      : sync.ideas_md_stale
                        ? t('IDEAS.md 需要更新', 'IDEAS.md needs an update')
                        : t('愿望或任务有改动还没进仓库', 'Wish or task changes not in the repository yet')}
                  </div>
                  <button className="primary" disabled={syncing} onClick={() => void runSync()} aria-label={syncing ? t('正在同步…', 'Syncing…') : t('同步到仓库', 'Sync to repository')} title={navNarrow ? t('同步到仓库', 'Sync to repository') : undefined}>
                    <span className="nav-full">{syncing ? t('正在同步…', 'Syncing…') : t('同步到仓库', 'Sync to repository')}</span>
                    <span className="nav-short" aria-hidden="true"><Icon name={syncing ? 'dots' : 'upload'} /></span>
                  </button>
                </>
              ) : (
                <div className="muted small nav-full">{sync.reason ?? t('已和仓库同步', 'In sync with the repository')}</div>
              )}
            </div>
          )}
          {me?.auth_enabled && (
            <div className="who">
              {me.role === 'guest' ? (
                <a className="button" href="/auth/login" aria-label={t('用 GitHub 登录', 'Sign in with GitHub')} title={navNarrow ? t('用 GitHub 登录', 'Sign in with GitHub') : undefined}>
                  <span className="nav-full">{t('用 GitHub 登录', 'Sign in with GitHub')}</span>
                  <span className="nav-short" aria-hidden="true"><Icon name="login" /></span>
                </a>
              ) : (
                <form method="post" action="/auth/logout" className="row">
                  <span className="small who-name nav-full" title={me.role === 'owner' ? t('主人', 'Owner') : t('访客', 'Member')}>
                    {me.name || me.login}
                  </span>
                  <button type="submit" aria-label={t('退出', 'Sign out')} title={navNarrow ? t('退出', 'Sign out') : undefined}>
                    <span className="nav-full">{t('退出', 'Sign out')}</span>
                    <span className="nav-short" aria-hidden="true"><Icon name="logout" /></span>
                  </button>
                </form>
              )}
            </div>
          )}
          <div className="row">
            {owner && (push === 'on' || push === 'off') && (
              <button
                aria-pressed={push === 'on'}
                aria-label={t('通知', 'Alerts')}
                title={push === 'on' ? t('通知开着：方案待批、作业结果、访客的愿望会推到这台设备', 'Notifications are on: plans to approve, job results and visitors’ wishes are pushed to this device') : t('打开通知', 'Turn notifications on')}
                onClick={() => void (push === 'on' ? turnOff() : turnOn()).then(setPush)}
              >
                <span className="nav-full">{push === 'on' ? t('通知 ✓', 'Alerts ✓') : t('通知', 'Alerts')}</span>
                <span className="nav-short" aria-hidden="true"><Icon name={push === 'on' ? 'bell' : 'bellOff'} /></span>
              </button>
            )}
            {owner && push === 'blocked' && <span className="muted small nav-full" title={t('浏览器里把这个站点的通知禁掉了，要到浏览器的设置里放开', 'Notifications for this site are blocked in the browser; allow them in its settings')}>{t('通知被禁', 'Alerts blocked')}</span>}
            <button onClick={toggleTheme} aria-label={t('切换昼夜配色', 'Switch between light and dark')}>
              <span className="nav-full">{theme === 'dark' ? t('昼', 'Light') : t('夜', 'Dark')}</span>
              <span className="nav-short" aria-hidden="true"><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></span>
            </button>
            {/* 两种语言都写上，不管现在是哪种都读得懂。 / Both languages, readable whichever is showing. */}
            <button onClick={toggleLang} aria-label="切换到英文 / Switch to Chinese" lang={lang === 'en' ? 'zh-CN' : 'en'}>
              {lang === 'en' ? '中' : 'EN'}
            </button>
            {/* 收窄 / 展开左侧栏；选择记在浏览器里。手机上导航是底部标签栏，这个按钮不显示。 */}
            {/* Collapse / expand the navigation; the choice is kept in the browser. On a phone the navigation is a bottom tab bar and this button is hidden. */}
            <button className="nav-toggle" onClick={toggleNav} aria-pressed={navNarrow} aria-label={t('收窄或展开左侧栏', 'Collapse or expand the navigation')} title={navNarrow ? t('展开左侧栏', 'Expand the navigation') : t('收窄左侧栏', 'Collapse the navigation')}>
              <Icon name={navNarrow ? 'chevronsRight' : 'chevronsLeft'} />
            </button>
          </div>
        </div>
      </nav>
      <main className="main">
        {stale && (
          <div className="notice warn" role="status">
            {t('工具已经更新，这一页还是旧的。', 'The tool has been updated and this page is still the old one.')}{' '}
            <button onClick={() => location.reload()}>{t('刷新', 'Refresh')}</button>
          </div>
        )}
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
        {/* 「想法」的几个视图之间切换；手写一条也从这里进。 */}
        {/* Switch between the views of "Ideas"; writing one by hand starts here too. */}
        {state && view && (
          <div className="views">
            <div className="seg" role="tablist" aria-label={t('想法的几种看法', 'Views of the ideas')}>
              {IDEA_VIEWS.filter((v) => owner || !v.owner).map((v) => (
                <Link key={v.to} to={v.to} role="tab" aria-selected={v.to === view}>
                  {t(v.zh, v.en)}
                  {v.to === '/inbox' && proposals && proposals.open > 0 && <span className="count pill num">{proposals.open}</span>}
                </Link>
              ))}
            </div>
            {owner && (
              <Link className="button" to="/new">
                {t('＋ 手写一条', '＋ Write one')}
              </Link>
            )}
          </div>
        )}
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
            <Route path="/sessions" element={gate(<SessionsPage />)} />
            <Route path="/sessions/:id" element={gate(<SessionsPage />)} />
            <Route path="/connect" element={gate(<ConnectPage />)} />
            <Route path="*" element={<p className="pad">{t('没有这个页面。', 'There is no such page.')}</p>} />
          </Routes>
        )}
      </main>
      {owner && <AssistantDock />}
    </div>
  )
}
