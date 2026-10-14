import { useState } from 'react'
import { api } from '../api'
import { useT } from '../state/store'
import { expectRestart, useRestart } from '../version'

/**
 * 后端的代码有更新时的提示。用 idea-loom serve 起的后端会在手上的事做完后自己重启，这里给一个"立即重启"；
 * 别的方式起的（或者旧的后端）还是只能手动重启。代码没有更新时什么都不显示。
 * The notice for updated backend code. A backend started with idea-loom serve restarts itself once
 * nothing is in flight, and this offers "restart now"; one started any other way (or an old backend)
 * can only be restarted by hand. Shows nothing while the code is current.
 */
export function RestartNotice({ extra }: { extra?: [string, string] }) {
  const t = useT()
  const restart = useRestart()
  const [asked, setAsked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!restart.needed && !asked) return null
  const now = async () => {
    setError(null)
    try {
      await api.restart()
      setAsked(true)
      expectRestart()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const more = extra ? ` ${t(extra[0], extra[1])}` : ''
  // 后端给的原因是「中文 / English」。 / The backend gives its reason as "中文 / English".
  const waiting = restart.waiting?.split(' / ')
  if (!restart.auto) {
    return (
      <div className="notice warn" role="status">
        {t('后端的代码有更新，重启后端才生效：在跑着服务的终端里按 Ctrl+C，再运行 uv run idea-loom serve。', 'The backend code has been updated and takes effect after a restart: press Ctrl+C in the terminal running the service, then run uv run idea-loom serve.')}
        {more}
      </div>
    )
  }
  return (
    <div className="notice warn" role="status">
      {asked
        ? t('正在重启后端，页面会自己刷新。', 'The backend is restarting; the page will reload by itself.')
        : t('后端的代码有更新，手上的事做完后它会自己重启，页面随后自己刷新。', 'The backend code has been updated; it restarts by itself once nothing is in flight, and the page then reloads by itself.')}
      {waiting && t(`（在等：${waiting[0]}）`, ` (waiting for: ${waiting[1] ?? waiting[0]})`)}
      {more}{' '}
      {!asked && <button onClick={() => void now()}>{t('立即重启', 'Restart now')}</button>}
      {error && <span className="small"> {error}</span>}
    </div>
  )
}
