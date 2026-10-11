import type { CardView } from '../api'
import { pick } from '../i18n'
import { useLang } from '../state/store'

// 卡片的地址加上 embed=1：各项目按嵌入约定只留舞台。还没做嵌入模式的项目会忽略它。
// The card address with embed=1 added: by the embed contract a project then shows only its
// stage. A project without an embed mode simply ignores it.
export function embedUrl(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.set('embed', '1')
    return u.toString()
  } catch {
    return url
  }
}

// 一个模拟的沙盒框架。模拟在自己的子域名下，是另一个源：它的脚本碰不到这个页面，
// 也调不了 idea-loom 的接口。allow-same-origin 说的是它保有自己那个源的身份（本地存储等），不是和这里同源。
// The sandboxed frame of one simulation. The simulation lives on its own subdomain, a
// different origin: its scripts cannot reach this page or call idea-loom's API.
// allow-same-origin lets it keep its own origin's identity (local storage and so on); it
// does not make it same-origin with this page.
export function SimFrame({ card, className = '' }: { card: CardView; className?: string }) {
  const lang = useLang()
  return (
    <iframe
      key={card.key}
      className={className}
      src={embedUrl(card.url)}
      title={pick(lang, card.title.zh, card.title.en)}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-pointer-lock"
      allow="fullscreen; clipboard-write"
      referrerPolicy="no-referrer"
    />
  )
}
