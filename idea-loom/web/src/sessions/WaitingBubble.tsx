import { Link } from 'react-router'
import { useT } from '../state/store'
import { bubbles, useWaiting } from './waiting'

// 有会话在等主人回答时，不管他在哪一页，左下角都冒一个小气泡；点它直接去那个会话。那个会话自己的视图开着时不弹，回答完就消失。
// While a session waits for the owner's answer, a small bubble appears at the bottom left whatever page he is on; clicking it goes straight to that session. None appears while that session's own view is open, and it goes once answered.
export function WaitingBubbles() {
  const t = useT()
  const waiting = useWaiting((s) => s.waiting)
  const onScreen = useWaiting((s) => s.onScreen)
  const shown = bubbles(waiting, onScreen)
  if (shown.length === 0) return null
  return (
    <div className="waiting-bubbles" role="status" aria-live="polite">
      {shown.map((s) => (
        <Link key={s.id} to={`/sessions/${s.id}`} className="waiting-bubble">
          <span className="waiting-dot" aria-hidden="true" />
          <span className="waiting-text">
            <strong>{t('Claude Code 在等你回答', 'Claude Code needs your answer')}</strong>
            <span className="small">
              {s.title}
              {s.waiting_for && ` · ${s.waiting_for}`}
            </span>
          </span>
        </Link>
      ))}
    </div>
  )
}
