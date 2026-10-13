import { describe, expect, it } from 'vitest'
import { ICON_NAMES } from '../src/ui/icons'
import { IDEA_VIEWS, NAV, ideaView, navEntry, whereLabel } from '../src/ui/nav'

describe('navEntry', () => {
  it('每个菜单项的地址唯一，并且归自己管 / every entry has a unique address that it covers itself', () => {
    expect(new Set(NAV.map((n) => n.to)).size).toBe(NAV.length)
    for (const n of NAV) expect(navEntry(n.to)).toBe(n)
  })

  it('每个菜单项有自己的图标，而且图标是画过的 / every entry has an icon of its own, and it is one that exists', () => {
    expect(new Set(NAV.map((n) => n.icon)).size).toBe(NAV.length)
    for (const n of NAV) expect(ICON_NAMES).toContain(n.icon)
  })

  it('一个地址前缀只归一个菜单项 / a prefix belongs to one entry only', () => {
    const all = NAV.flatMap((n) => n.under)
    expect(new Set(all).size).toBe(all.length)
  })

  it('想法的几个视图和旧地址都归「想法」 / the idea views and the old addresses all belong to Ideas', () => {
    for (const path of ['/', '/ideas', '/ideas/1.1', '/inbox', '/lineage', '/new', '/inbox?tab=tidy']) expect(navEntry(path)?.zh).toBe('想法')
  })

  it('深层地址归到所在的菜单项 / a deeper address maps to its entry', () => {
    expect(navEntry('/wishes/wish-x')?.to).toBe('/wishes')
    expect(navEntry('/sessions/abc/')?.to).toBe('/sessions')
    expect(navEntry('/connect')?.to).toBe('/work')
  })

  it('不认识的地址没有菜单项，前缀相近的也不算 / an unknown address has no entry, and a look-alike prefix does not count', () => {
    expect(navEntry('/nowhere')).toBeUndefined()
    expect(navEntry('/playground')).toBeUndefined()
    expect(navEntry('/suggest')).toBeUndefined()
  })
})

describe('whereLabel', () => {
  it('详情页先说是哪一页，再接它自己的标题 / a detail page names its menu entry first, then its own title', () => {
    expect(whereLabel('/wishes/wish-x', '左侧栏可以收窄', 'zh')).toBe('许愿池 › 左侧栏可以收窄')
    expect(whereLabel('/sessions/s-1', 'Triage', 'en')).toBe('Self-evolution › Triage')
  })

  it('菜单项自己的页面就是页面名 / an entry\'s own page is just its name', () => {
    expect(whereLabel('/wishes', '许愿池', 'zh')).toBe('许愿池')
    expect(whereLabel('/wishes', '', 'en')).toBe('Wish pool')
    expect(whereLabel('/ideas?level=L1', '列表', 'zh')).toBe('列表')
  })

  it('详情页的标题就是页面名时不重复 / a detail page titled like its entry is not repeated', () => {
    expect(whereLabel('/sessions/s-1', '自我进化', 'zh')).toBe('自我进化')
    expect(whereLabel('/sessions/s-1', '自我进化', 'en')).toBe('Self-evolution')
  })

  it('不认识的地址用标题，没有标题用地址 / an unknown address uses its title, or the address without one', () => {
    expect(whereLabel('/nowhere', '某页', 'zh')).toBe('某页')
    expect(whereLabel('/nowhere', '', 'zh')).toBe('/nowhere')
  })
})

describe('ideaView', () => {
  it('视图的地址都能认出来 / every view address is recognised', () => {
    for (const v of IDEA_VIEWS) expect(ideaView(v.to)).toBe(v.to)
    expect(ideaView('/ideas?level=L1')).toBe('/ideas')
  })

  it('idea 详情页和别的页面不是视图 / an idea page and other pages are not views', () => {
    expect(ideaView('/ideas/1.1')).toBeUndefined()
    expect(ideaView('/new')).toBeUndefined()
    expect(ideaView('/work')).toBeUndefined()
  })
})
