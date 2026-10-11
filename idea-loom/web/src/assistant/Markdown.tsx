import type { ReactNode } from 'react'
import { Chart, DataTable, LiveCard } from './Rich'

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
  // 围栏块：chart、table、card 交给各自的组件去画，别的当代码显示。回答还在往外写、围栏没闭合时先当代码显示着。
  // Fenced blocks: chart, table and card go to their own components; anything else shows as code.
  // While the answer is still streaming and a fence is not closed yet, it shows as code for the moment.
  let fence: { kind: string; lines: string[] } | null = null
  const closeFence = (complete: boolean) => {
    if (!fence) return
    const body = fence.lines.join('\n')
    const key = out.length
    if (complete && fence.kind === 'chart') out.push(<Chart key={key} text={body} />)
    else if (complete && fence.kind === 'table') out.push(<DataTable key={key} text={body} />)
    else if (complete && fence.kind === 'card') out.push(<LiveCard key={key} text={body} />)
    else out.push(<pre key={key} className="rich-raw">{body}</pre>)
    fence = null
  }
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const mark = /^\s*```\s*([A-Za-z0-9_-]*)\s*$/.exec(line)
    if (mark) {
      if (fence) closeFence(true)
      else {
        flush()
        fence = { kind: mark[1]!.toLowerCase(), lines: [] }
      }
      continue
    }
    if (fence) {
      fence.lines.push(raw)
      continue
    }
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
  closeFence(false)
  return <div className="md">{out}</div>
}
