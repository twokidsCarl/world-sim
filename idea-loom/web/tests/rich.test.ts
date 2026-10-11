import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/assistant/Markdown'

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }))

// 回答里的图表、表格：画得出来就画，画不出来就原样显示，不能让整条回答坏掉。
// Charts and tables in an answer: drawn when they can be, shown as they are when they cannot; the answer as a whole must never break.
describe('rich blocks in an answer', () => {
  it('draws a bar chart from a chart block and keeps the text around it', () => {
    const out = html('每层的条数：\n\n```chart\n{"type":"bar","title":"每一层","x":["L1","L2"],"series":[{"name":"条数","values":[12,9]}],"unit":"条"}\n```\n\n就这些。')
    expect(out).toContain('<p>每层的条数：</p>')
    expect(out).toContain('<figure class="rich-chart">')
    expect(out).toContain('每一层')
    expect(out).toContain('width:100%')
    expect(out).toContain('width:75%')
    expect(out).toContain('<p>就这些。</p>')
    expect(out).not.toContain('```')
  })

  it('draws lines and scatter points as SVG', () => {
    const line = html('```chart\n{"type":"line","x":["一","二","三"],"series":[{"name":"a","values":[1,3,2]},{"name":"b","values":[2,2,4]}]}\n```')
    expect(line).toContain('<polyline')
    expect(line.match(/<circle/g)?.length).toBe(6)
    expect(line).toContain('rich-legend')
    const scatter = html('```chart\n{"type":"scatter","series":[{"points":[[1,2,"甲"],[3,4],["x",1]]}]}\n```')
    expect(scatter.match(/<circle/g)?.length).toBe(2)
  })

  it('draws a table and limits its size', () => {
    const rows = Array.from({ length: 80 }, (_, i) => [`${i}`, 'x'])
    const out = html('```table\n' + JSON.stringify({ columns: ['编号', '标题'], rows }) + '\n```')
    expect(out).toContain('<th scope="col">编号</th>')
    expect(out.match(/<tr>/g)?.length).toBe(61)
  })

  it('shows what it cannot draw as plain text instead of failing', () => {
    expect(html('```chart\n{not json\n```')).toContain('<pre class="rich-raw">{not json</pre>')
    expect(html('```chart\n{"type":"bar","series":[]}\n```')).toContain('rich-raw')
    expect(html('```table\n{"columns":[],"rows":[]}\n```')).toContain('rich-raw')
    expect(html('```python\nprint(1)\n```')).toContain('<pre class="rich-raw">print(1)</pre>')
  })

  it('shows an unfinished block as text while the answer is still streaming', () => {
    const out = html('看图：\n```chart\n{"type":"bar","x":["L1"],"ser')
    expect(out).toContain('<pre class="rich-raw">')
    expect(out).not.toContain('rich-chart')
  })
})
