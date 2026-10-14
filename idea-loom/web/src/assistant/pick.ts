// 点选：在页面上点一个元素，或拖一个框选几个，把它们的引用插进小助手的输入框。
// 选中的元素带上固定的编号（data-apick="p1"），发问时的页面提纲照这个编号标出它们，并单列一节。
// Picking: click an element on the page, or drag a box around several, and a reference to them
// goes into the assistant's input. Picked elements keep a fixed number (data-apick="p1"); the
// page outline sent with the question marks them by that number and lists them in a section.
import type { T } from '../i18n'
import { INTERACTIVE, nameOf } from './pageSnapshot'

export type Rect = { left: number; top: number; right: number; bottom: number }
export type Picked = { ref: string; role: string; name: string }

// 点到一个字或一个图标时，往上找到值得指的那一层。 / When the pointer lands on a word or an icon, climb to the level worth pointing at.
const BLOCKS = 'li, tr, td, th, p, h1, h2, h3, h4, dt, dd, figure, img, svg, canvas, iframe, pre, blockquote, label, section, article'
const DRAG = 5 // 按下后移动超过这么多像素算拖框 / moving further than this after pressing counts as a drag
const NAME_MAX = 24

// ---------- 纯函数 / pure parts ----------

export function rectFrom(x0: number, y0: number, x1: number, y1: number): Rect {
  return { left: Math.min(x0, x1), top: Math.min(y0, y1), right: Math.max(x0, x1), bottom: Math.max(y0, y1) }
}

export const within = (inner: Rect, outer: Rect): boolean => inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom
const overlaps = (a: Rect, b: Rect): boolean => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
const empty = (r: Rect): boolean => r.right - r.left <= 0 || r.bottom - r.top <= 0

// 框里的元素：完全落在框里的最外层那些，不再往里取它们的子元素；压在框边上的往里找。
// rectOf 返回 null 的整棵跳过；没有大小的（例如 display: contents）只往里找。
// The elements in a box: the outermost ones lying wholly inside it, without their children;
// those straddling the edge are searched inside. A node whose rectOf is null is skipped with
// everything under it; one without size (display: contents, say) is only searched inside.
export function topmostInside<N>(roots: N[], children: (n: N) => N[], rectOf: (n: N) => Rect | null, box: Rect): N[] {
  const out: N[] = []
  const visit = (n: N) => {
    const r = rectOf(n)
    if (r === null) return
    if (empty(r)) children(n).forEach(visit)
    else if (within(r, box)) out.push(n)
    else if (overlaps(r, box)) children(n).forEach(visit)
  }
  roots.forEach(visit)
  return out
}

export function roleLabel(role: string, t: T): string {
  if (role === 'a' || role === 'link') return t('链接', 'link')
  if (role === 'button' || role === 'summary' || role === 'tab') return t('按钮', 'button')
  if (role === 'input' || role === 'textarea' || role === 'select' || role === 'textbox') return t('输入框', 'field')
  if (role === 'li' || role === 'listitem') return t('列表项', 'list item')
  if (role === 'tr' || role === 'row') return t('表格行', 'table row')
  if (role === 'td' || role === 'th' || role === 'cell') return t('格子', 'cell')
  if (role === 'p') return t('段落', 'paragraph')
  if (/^h[1-6]$/.test(role) || role === 'heading') return t('标题', 'heading')
  if (role === 'img' || role === 'figure') return t('图', 'image')
  if (role === 'svg' || role === 'canvas') return t('图形', 'graphic')
  if (role === 'iframe') return t('嵌入的页面', 'embedded page')
  if (role === 'section' || role === 'article') return t('区块', 'section')
  return t('元素', 'element')
}

// 插进输入框的那段引用：短、看得懂；编号就是发问时页面提纲里的编号。
// The reference put into the input: short and readable; its numbers are those in the outline sent with the question.
export function referenceText(picks: Picked[], t: T): string {
  if (picks.length === 0) return ''
  const one = (p: Picked) => {
    const name = p.name.length > NAME_MAX ? `${p.name.slice(0, NAME_MAX)}…` : p.name
    return `${p.ref} ${roleLabel(p.role, t)}${name ? t(`「${name}」`, ` "${name}"`) : ''}`
  }
  if (picks.length <= 3) return t(`【${picks.map(one).join('、')}】`, `[${picks.map(one).join(', ')}]`)
  const span = `${picks[0]!.ref}–${picks[picks.length - 1]!.ref}`
  return t(`【${span} 框选的 ${picks.length} 处】`, `[${span}, ${picks.length} boxed elements]`)
}

// 在光标处（或替换选中的字）插入一段，前后补空格；返回新的文字和光标位置。
// Insert at the cursor (or over the selected text), padding with spaces; returns the new text and cursor.
export function insertAt(value: string, start: number, end: number, text: string): { value: string; cursor: number } {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const head = before + (before && !/\s$/.test(before) ? ' ' : '') + text + (after.startsWith(' ') ? '' : ' ')
  return { value: head + after, cursor: head.length }
}

// ---------- 页面上 / on the page ----------

let next = 1 // 编号在这次打开的页面里一直往上数，不和前面问过的重复 / numbers keep counting up for this page load, never repeating earlier ones

const inDock = (el: Element) => !!el.closest('[data-assistant]')

export function target(el: Element): Element {
  return el.closest(INTERACTIVE) ?? el.closest(BLOCKS) ?? el
}

export function tag(els: Element[]): Picked[] {
  return els.map((el) => {
    let ref = el.getAttribute('data-apick')
    if (!ref) {
      ref = `p${next++}`
      el.setAttribute('data-apick', ref)
    }
    return { ref, role: el.getAttribute('role') ?? el.tagName.toLowerCase(), name: nameOf(el) }
  })
}

export function clearPicks() {
  document.querySelectorAll('[data-apick]').forEach((el) => el.removeAttribute('data-apick'))
}

function inBox(box: Rect): Element[] {
  const rectOf = (el: Element): Rect | null => {
    if (inDock(el) || el.getAttribute('aria-hidden') === 'true' || /^(script|style|template)$/i.test(el.tagName)) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  }
  return topmostInside([...document.body.children], (el) => [...el.children], rectOf, box)
}

function layer(className: string): HTMLDivElement {
  const div = document.createElement('div')
  div.className = className
  div.setAttribute('data-assistant', '') // 提纲和点选都不算它 / left out of the outline and of picking
  div.setAttribute('aria-hidden', 'true')
  div.hidden = true
  document.body.appendChild(div)
  return div
}

const place = (div: HTMLDivElement, r: Rect | null) => {
  div.hidden = !r
  if (r) Object.assign(div.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` })
}

// 进入点选：悬停高亮，点一下选一个，拖一个框选框里的，Esc 退出。小助手自己身上的点击照常。返回退出用的函数。
// Enter pick mode: hovering highlights, a click picks one element, a drag picks those inside the box, Esc leaves.
// Clicks on the assistant itself work as usual. Returns the function that leaves.
export function startPicking(onPick: (picks: Picked[]) => void, onExit: () => void): () => void {
  const hover = layer('a-pick-hover')
  const band = layer('a-pick-band')
  let start: { x: number; y: number; el: Element } | null = null
  let dragging = false
  document.documentElement.classList.add('a-picking')

  const ours = (e: Event) => e.target instanceof Element && !inDock(e.target)
  const swallow = (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
  }
  const move = (e: PointerEvent) => {
    if (start) {
      dragging ||= Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG
      if (dragging) {
        place(hover, null)
        place(band, rectFrom(start.x, start.y, e.clientX, e.clientY))
      }
      return
    }
    if (!ours(e)) return place(hover, null)
    const r = target(e.target as Element).getBoundingClientRect()
    place(hover, { left: r.left, top: r.top, right: r.right, bottom: r.bottom })
  }
  const down = (e: PointerEvent) => {
    if (!ours(e) || e.button !== 0) return
    swallow(e)
    start = { x: e.clientX, y: e.clientY, el: e.target as Element }
    dragging = false
  }
  const up = (e: PointerEvent) => {
    if (!start) return
    swallow(e)
    const els = dragging ? inBox(rectFrom(start.x, start.y, e.clientX, e.clientY)) : [target(start.el)]
    start = null
    dragging = false
    place(band, null)
    if (els.length) onPick(tag(els))
  }
  const click = (e: MouseEvent) => ours(e) && swallow(e) // 不让页面上的链接和按钮动 / keep the page's links and buttons still
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    swallow(e)
    onExit()
  }
  const options = { capture: true }
  window.addEventListener('pointermove', move, options)
  window.addEventListener('pointerdown', down, options)
  window.addEventListener('pointerup', up, options)
  window.addEventListener('click', click, options)
  window.addEventListener('dragstart', click, options)
  window.addEventListener('keydown', key, options)
  return () => {
    window.removeEventListener('pointermove', move, options)
    window.removeEventListener('pointerdown', down, options)
    window.removeEventListener('pointerup', up, options)
    window.removeEventListener('click', click, options)
    window.removeEventListener('dragstart', click, options)
    window.removeEventListener('keydown', key, options)
    hover.remove()
    band.remove()
    document.documentElement.classList.remove('a-picking')
  }
}
