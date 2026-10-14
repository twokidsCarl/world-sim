// 把当前页面读成一份文字提纲，交给小助手。不是截图；不带输入框里打的字；不带小助手自己。
// Read the current page into a text outline for the assistant. Not a screenshot; no
// typed input values; not the assistant's own DOM.
export type PageElement = { ref: string; role: string; name: string }
// 他点选的元素：编号、类型、名字、所在的标题，和它自己那一段提纲。
// An element he picked: its number, type, name, the heading it sits under, and its own stretch of outline.
export type PickedElement = PageElement & { where: string; text: string }
export type PageSnapshot = { url: string; title: string; lead: string; content: string; elements: PageElement[]; truncated: boolean; picked: PickedElement[] }

const MAX_CHARS = 24_000
const MAX_ELEMENTS = 200
const MAX_PICKED_CHARS = 8_000 // 点选的那一节总共这么长 / the picked section in all
const MAX_PICK_CHARS = 1_200 // 一个点选的元素最多带这么长的提纲 / outline carried per picked element at most
export const INTERACTIVE = 'a[href], button, select, input, textarea, [role="tab"], summary'

export function nameOf(el: Element): string {
  const label = el.getAttribute('aria-label') || el.getAttribute('title')
  if (label) return label.trim()
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return (el.placeholder || el.name || el.type || '').trim()
  if (el instanceof HTMLSelectElement) return el.selectedOptions[0]?.textContent?.trim() ?? ''
  if (el instanceof HTMLImageElement) return el.alt.trim()
  // 一段一段的字之间补空格，免得"1.2"和"沙堆"粘在一起。 / Put spaces between text pieces so "1.2" and the title do not run together.
  const pieces: string[] = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n && pieces.join(' ').length < 80; n = walker.nextNode()) pieces.push(n.textContent ?? '')
  return pieces.join(' ').replace(/\s+/g, ' ').trim().slice(0, 80)
}

export function clearRefs(root: ParentNode = document) {
  root.querySelectorAll('[data-aref]').forEach((el) => el.removeAttribute('data-aref'))
}

// 一棵子树的提纲。ref 决定元素后面跟什么编号；点选的元素（data-apick）在它的第一行后面标上自己的编号。
// The outline of a subtree. ref decides the number after an element; a picked element (data-apick)
// gets its own number after its first line.
function outline(root: Element, maxChars: number, ref: (el: Element) => string): { lines: string[]; truncated: boolean } {
  const lines: string[] = []
  let size = 0
  let truncated = false
  const push = (line: string) => {
    if (truncated || !line.trim()) return
    if (size + line.length > maxChars) {
      truncated = true
      return
    }
    lines.push(line)
    size += line.length + 1
  }
  const skip = (el: Element) => el.closest('[data-assistant]') || el.getAttribute('aria-hidden') === 'true'
  const inline = (el: Element): string => {
    let out = ''
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) out += node.textContent ?? ''
      else if (node instanceof Element) {
        if (skip(node)) continue
        if (node.matches(INTERACTIVE)) out += `${nameOf(node)}${ref(node)} `
        else out += inline(node) + (node.hasAttribute('data-apick') ? `${ref(node)} ` : '')
      }
    }
    return out.replace(/\s+/g, ' ')
  }
  const body = (el: Element) => {
    const tag = el.tagName.toLowerCase()
    if (/^h[1-4]$/.test(tag)) return push(`${'#'.repeat(Number(tag[1]))} ${inline(el).trim()}`)
    if (tag === 'tr') return push(`| ${[...el.children].map((c) => inline(c).trim()).join(' | ')} |`)
    if (tag === 'li' && !el.querySelector('li, table, h1, h2, h3, h4')) return push(`- ${inline(el).trim()}`)
    if (tag === 'p' || tag === 'dt' || tag === 'dd' || tag === 'blockquote' || tag === 'summary' || tag === 'figcaption' || tag === 'label') return push(inline(el).trim())
    if (el.matches(INTERACTIVE)) return push(`${nameOf(el)}${ref(el)}`)
    const section = el.getAttribute('aria-label')
    if ((tag === 'section' || tag === 'nav' || tag === 'form') && section) push(`【${section}】`)
    const before = lines.length
    for (const child of el.children) walk(child)
    if (lines.length === before && el.children.length === 0) push((el.textContent ?? '').replace(/\s+/g, ' ').trim())
  }
  const walk = (el: Element) => {
    if (truncated || skip(el)) return
    if (!el.hasAttribute('data-apick') || el.matches(INTERACTIVE)) return body(el)
    const start = lines.length
    body(el)
    const mark = ref(el)
    if (lines.length > start) lines[start] += mark
    else push(`（${nameOf(el) || el.tagName.toLowerCase()}）${mark}`)
  }
  walk(root)
  return { lines, truncated }
}

// 元素前面最近的一个标题，用来说它在页面的哪一块。 / The nearest heading before an element, to say which part of the page it is in.
function headingBefore(el: Element): string {
  let found = ''
  for (const h of document.querySelectorAll('h1, h2, h3, h4')) {
    if (h.closest('[data-assistant]')) continue
    if (h === el || h.contains(el) || h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = (h.textContent ?? '').replace(/\s+/g, ' ').trim()
    else break
  }
  return found.slice(0, 80)
}

export function snapshot(root: Element | null, identity: { title: string; lead: string }, url: string): PageSnapshot {
  const elements: PageElement[] = []
  if (root) clearRefs(root)
  clearRefs(document) // 点选的元素可能在 root 外面 / picked elements may lie outside root
  const register = (el: Element, id: string) => {
    el.setAttribute('data-aref', id)
    elements.push({ ref: id, role: el.getAttribute('role') ?? el.tagName.toLowerCase(), name: nameOf(el) })
    return ` [${id}]`
  }
  const ref = (el: Element): string => {
    const known = el.getAttribute('data-aref')
    if (known) return ` [${known}]`
    const pick = el.getAttribute('data-apick')
    if (pick) return register(el, pick) // 点选的元素用自己固定的编号，不受上限 / picked elements keep their fixed number, outside the cap
    if (elements.length >= MAX_ELEMENTS) return ''
    return register(el, `e${elements.length + 1}`)
  }
  const main = root ? outline(root, MAX_CHARS, ref) : { lines: [], truncated: false }

  // 点选的元素单列一节：每个带上它自己的那一段提纲（里面的编号和上面一致）。
  // Picked elements get a section of their own, each with its own stretch of outline (numbers as above).
  const picked: PickedElement[] = []
  let budget = MAX_PICKED_CHARS
  for (const el of document.querySelectorAll('[data-apick]')) {
    if (el.closest('[data-assistant]')) continue
    const id = el.getAttribute('data-apick')!
    if (!el.hasAttribute('data-aref')) register(el, id)
    const own = outline(el, Math.max(0, Math.min(MAX_PICK_CHARS, budget)), (e) => (e.getAttribute('data-aref') ? ` [${e.getAttribute('data-aref')}]` : ''))
    const text = own.lines.join('\n') + (own.truncated ? '\n…' : '')
    budget -= text.length
    picked.push({ ref: id, role: el.getAttribute('role') ?? el.tagName.toLowerCase(), name: nameOf(el), where: headingBefore(el), text })
  }
  return { url, title: identity.title, lead: identity.lead, content: main.lines.join('\n'), elements, truncated: main.truncated, picked }
}
