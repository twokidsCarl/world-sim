import { useEffect } from 'react'
import { NavLink, Route, Routes } from 'react-router'
import { IdeaPage } from '../pages/IdeaPage'
import { InboxPage } from '../pages/InboxPage'
import { LineagePage } from '../pages/LineagePage'
import { NewIdeaPage } from '../pages/NewIdeaPage'
import { MapPage } from '../pages/MapPage'
import { PlayPage } from '../pages/PlayPage'
import { PoolPage } from '../pages/PoolPage'
import { StatsPage } from '../pages/StatsPage'
import { WorkPage } from '../pages/WorkPage'
import { WishPage, WishesPage } from '../pages/WishesPage'
import { AssistantDock } from '../assistant/AssistantDock'
import { useAssistant } from '../assistant/store'
import { applyLang, plural } from '../i18n'
import { useStore, useT } from '../state/store'

const NAV = [
  { to: '/play', zh: '玩', en: 'Play', end: false },
  { to: '/', zh: '地图', en: 'Map', end: true },
  { to: '/ideas', zh: '想法池', en: 'Idea pool', end: false },
  { to: '/inbox', zh: '生成与候选', en: 'Generate & candidates', end: false },
  { to: '/lineage', zh: '血缘', en: 'Lineage', end: false },
  { to: '/work', zh: '开发', en: 'Work', end: false },
  { to: '/wishes', zh: '许愿池', en: 'Wish pool', end: false },
  { to: '/stats', zh: '统计', en: 'Statistics', end: false },
]

export function App() {
  const { state, error, load, theme, toggleTheme, lang, toggleLang, sync, syncing, syncResult, runSync, clearSyncResult, proposals } = useStore()
  const t = useT()
  const openWishes = useAssistant((a) => a.openWishes)
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
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className="nav-item">
            {t(n.zh, n.en)}
            {n.to === '/ideas' && state && <span className="count num">{state.counts.live}</span>}
            {n.to === '/wishes' && openWishes > 0 && <span className="count pill num">{openWishes}</span>}
            {n.to === '/inbox' && proposals && proposals.open > 0 && <span className="count pill num">{proposals.open}</span>}
          </NavLink>
        ))}
        <NavLink to="/new" className="nav-item nav-new">
          {t('＋ 手写一条', '＋ Write one')}
        </NavLink>
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
          <div className="row">
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
            <Route path="/inbox" element={<InboxPage state={state} />} />
            <Route path="/lineage" element={<LineagePage state={state} />} />
            <Route path="/play" element={<PlayPage state={state} />} />
            <Route path="/work" element={<WorkPage state={state} />} />
            <Route path="/stats" element={<StatsPage state={state} />} />
            <Route path="/wishes" element={<WishesPage />} />
            <Route path="/wishes/:id" element={<WishPage />} />
            <Route path="/new" element={<NewIdeaPage state={state} />} />
            <Route path="*" element={<p className="pad">{t('没有这个页面。', 'There is no such page.')}</p>} />
          </Routes>
        )}
      </main>
      <AssistantDock />
    </div>
  )
}
