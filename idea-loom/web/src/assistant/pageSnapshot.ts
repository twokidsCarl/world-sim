// 把当前页面读成一份文字提纲，交给小助手。不是截图；不带输入框里打的字；不带小助手自己。
// Read the current page into a text outline for the assistant. Not a screenshot; no
// typed input values; not the assistant's own DOM.
export type PageElement = { ref: string; role: string; name: string }
export type PageSnapshot = { url: string; title: string; lead: string; content: string; elements: PageElement[]; truncated: boolean }

const MAX_CHARS = 24_000
const MAX_ELEMENTS = 200
const INTERACTIVE = 'a[href], button, select, input, textarea, [role="tab"], summary'

function nameOf(el: Element): string {
  const label = el.getAttribute('aria-label') || el.getAttribute('title')
  if (label) return label.trim()
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return (el.placeholder || el.name || el.type || '').trim()
  if (el instanceof HTMLSelectElement) return el.selectedOptions[0]?.textContent?.trim() ?? ''
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

export function clearRefs(root: ParentNode = document) {
  root.querySelectorAll('[data-aref]').forEach((el) => el.removeAttribute('data-aref'))
}

export function snapshot(root: Element | null, identity: { title: string; lead: string }, url: string): PageSnapshot {
  const elements: PageElement[] = []
  const lines: string[] = []
  let size = 0
  let truncated = false
  if (root) clearRefs(root)

  const push = (line: string) => {
    if (truncated || !line.trim()) return
    if (size + line.length > MAX_CHARS) {
      truncated = true
      return
    }
    lines.push(line)
    size += line.length + 1
  }
  const ref = (el: Element): string => {
    if (elements.length >= MAX_ELEMENTS) return ''
    const id = `e${elements.length + 1}`
    el.setAttribute('data-aref', id)
    elements.push({ ref: id, role: el.getAttribute('role') ?? el.tagName.toLowerCase(), name: nameOf(el) })
    return ` [${id}]`
  }
  const inline = (el: Element): string => {
    let out = ''
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) out += node.textContent ?? ''
      else if (node instanceof Element) {
        if (node.closest('[data-assistant]') || node.getAttribute('aria-hidden') === 'true') continue
        if (node.matches(INTERACTIVE)) out += `${nameOf(node)}${ref(node)} `
        else out += inline(node)
      }
    }
    return out.replace(/\s+/g, ' ')
  }
  const walk = (el: Element) => {
    if (truncated || el.closest('[data-assistant]') || el.getAttribute('aria-hidden') === 'true') return
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
  if (root) walk(root)
  return { url, title: identity.title, lead: identity.lead, content: lines.join('\n'), elements, truncated }
}
