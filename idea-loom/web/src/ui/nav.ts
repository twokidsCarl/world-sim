// 左侧菜单和「想法」下面的几个视图。放在单独的文件里，别的页面也要用它把地址对回菜单项。
// The left menu and the views under "Ideas". Kept in its own file because other pages also map an address back to a menu entry.

import type { IconName } from './icons'

export type NavEntry = {
  // 点菜单项去的地址。 / Where the menu entry leads.
  to: string
  // 归这一项管的地址前缀；'/' 只认完全相等。 / Address prefixes that belong to this entry; '/' matches only exactly.
  under: readonly string[]
  // 左侧栏收窄时显示的图标，名字见 icons.tsx。 / The icon shown when the navigation is collapsed; names are in icons.tsx.
  icon: IconName
  zh: string
  en: string
  // 只有主人能用。 / For the owner only.
  owner: boolean
}

export const NAV: readonly NavEntry[] = [
  { to: '/play', under: ['/play'], icon: 'compass', zh: '无尽探索', en: 'Explore', owner: false },
  // 地图、列表、生成与候选、血缘是同一批想法的几种看法，合在一项下面。
  // The map, the list, generate & candidates and lineage are views of the same ideas, so they share one entry.
  { to: '/', under: ['/', '/ideas', '/inbox', '/lineage', '/new'], icon: 'bulb', zh: '想法', en: 'Ideas', owner: false },
  { to: '/work', under: ['/work', '/connect'], icon: 'branch', zh: '开发', en: 'Work', owner: true },
  { to: '/wishes', under: ['/wishes'], icon: 'star', zh: '许愿池', en: 'Wish pool', owner: true },
  // 会话只在本机有：它能在这台机器上执行命令。 / Sessions exist locally only: they can run commands on this machine.
  { to: '/sessions', under: ['/sessions'], icon: 'terminal', zh: '自我进化', en: 'Self-evolution', owner: true },
  { to: '/stats', under: ['/stats'], icon: 'bars', zh: '统计', en: 'Statistics', owner: true },
]

// 「想法」的几个视图；每个仍是自己的地址，所以旧链接照常能用。
// The views of "Ideas"; each keeps its own address, so old links go on working.
export const IDEA_VIEWS: readonly { to: string; zh: string; en: string; owner: boolean }[] = [
  { to: '/', zh: '地图', en: 'Map', owner: false },
  { to: '/ideas', zh: '列表', en: 'List', owner: false },
  { to: '/inbox', zh: '生成与候选', en: 'Generate & candidates', owner: true },
  { to: '/lineage', zh: '血缘', en: 'Lineage', owner: false },
]

function covers(prefix: string, pathname: string): boolean {
  if (prefix === '/') return pathname === '/'
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

function clean(pathname: string): string {
  const path = (pathname.split(/[?#]/)[0] ?? '').replace(/\/+$/, '')
  return path === '' ? '/' : path
}

// 一个地址属于哪个菜单项；不属于任何一项时是 undefined。
// Which menu entry an address belongs to; undefined when it belongs to none.
export function navEntry(pathname: string): NavEntry | undefined {
  const path = clean(pathname)
  return NAV.find((n) => n.under.some((u) => covers(u, path)))
}

// 一个记下来的页面（地址加当时的标题）该怎么称呼：先说是哪个菜单项，详情页再接上它自己的标题。
// 只写标题的话，一条愿望的详情页会显示成那条愿望的标题，在列表里看着像是另一条愿望。
// How to name a recorded page (an address plus the title it had): the menu entry first, then the page's own title for a detail page.
// With the title alone, a wish's detail page shows as that wish's title, which in a list reads like another wish.
export function whereLabel(url: string, title: string, lang: 'zh' | 'en'): string {
  const entry = navEntry(url)
  const own = title.trim()
  if (!entry) return own || url
  const name = lang === 'zh' ? entry.zh : entry.en
  const path = clean(url)
  // 菜单项自己的那几个地址：有标题就用标题（「想法」下面的视图各有名字）。
  // The entry's own addresses: use the title when there is one (the views under Ideas each have a name).
  if (entry.under.includes(path)) return own || name
  return own && own !== entry.zh && own !== entry.en ? `${name} › ${own}` : name
}

// 一个地址正好是「想法」的哪个视图；idea 的详情页和手写页不是视图，返回 undefined。
// Which view of "Ideas" an address is exactly; an idea's own page and the write page are not views and give undefined.
export function ideaView(pathname: string): string | undefined {
  const path = clean(pathname)
  return IDEA_VIEWS.find((v) => v.to === path)?.to
}
