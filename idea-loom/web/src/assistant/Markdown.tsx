import type { ReactNode } from 'react'

// 回答里用得到的那一点 Markdown：段落、列表、粗体、行内代码。别的原样显示。
// The little Markdown an answer needs: paragraphs, lists, bold, inline code. Anything
// else is shown as it is.
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>
    return part
  })
}

export function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) out.push(<ul key={out.length}>{list.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>)
    list = []
  }
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const item = /^\s*(?:[-*]|\d+[.、])\s+(.*)$/.exec(line)
    if (item) {
      list.push(item[1]!)
      continue
    }
    flush()
    if (!line.trim()) continue
    const heading = /^#{1,4}\s+(.*)$/.exec(line)
    out.push(heading ? <p key={out.length} className="md-h">{inline(heading[1]!)}</p> : <p key={out.length}>{inline(line)}</p>)
  }
  flush()
  return <div className="md">{out}</div>
}
