// 你不在这一页的时候，会话需要你或者做完了一轮，用浏览器自带的通知告诉你，并在标签页的标题上做个记号。
// 不需要任何服务器配置；只在这个标签页不在前台时才弹。
// When you are not on this page and a session needs you or has finished a turn, the browser's own
// notifications tell you, and the tab title carries a mark. No server configuration is needed; it
// only fires while this tab is in the background.

export const canNotify = () => typeof window !== 'undefined' && 'Notification' in window

export const notifyState = (): 'unsupported' | 'on' | 'off' | 'blocked' =>
  !canNotify() ? 'unsupported' : Notification.permission === 'granted' ? 'on' : Notification.permission === 'denied' ? 'blocked' : 'off'

export async function askToNotify(): Promise<ReturnType<typeof notifyState>> {
  if (canNotify() && Notification.permission === 'default') await Notification.requestPermission()
  return notifyState()
}

export function tell(title: string, body: string, tag: string) {
  if (notifyState() !== 'on' || document.visibilityState === 'visible') return
  try {
    const n = new Notification(title, { body, tag, icon: '/icon.svg' })
    n.onclick = () => {
      window.focus()
      n.close()
    }
  } catch {
    /* 有的浏览器只允许 service worker 发通知；发不出来不影响别的 / some browsers only let a service worker notify; failing here affects nothing else */
  }
}

let base: string | null = null
// 标题前的记号：● 等你回答 / ✓ 做完了。回到页面时清掉。 / The mark before the title: ● needs you / ✓ done. Cleared on return.
export function mark(prefix: string | null) {
  if (base === null || !document.title.startsWith('● ') && !document.title.startsWith('✓ ')) base = document.title
  document.title = prefix ? `${prefix} ${base}` : (base ?? document.title)
}
