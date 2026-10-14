import { describe, expect, it } from 'vitest'
import { type Rect, insertAt, rectFrom, referenceText, topmostInside, within } from '../src/assistant/pick'

const zh = (z: string) => z
const en = (_: string, e: string) => e

describe('reference text', () => {
  it('names one or a few picked elements, and gives a range for many', () => {
    expect(referenceText([{ ref: 'p1', role: 'button', name: '改写' }], zh)).toBe('【p1 按钮「改写」】')
    expect(referenceText([{ ref: 'p1', role: 'button', name: 'Rewrite' }], en)).toBe('[p1 button "Rewrite"]')
    expect(referenceText([{ ref: 'p2', role: 'canvas', name: '' }, { ref: 'p3', role: 'li', name: '1.2 沙堆' }], zh)).toBe('【p2 图形、p3 列表项「1.2 沙堆」】')
    const many = ['p4', 'p5', 'p6', 'p7'].map((ref) => ({ ref, role: 'tr', name: 'x' }))
    expect(referenceText(many, zh)).toBe('【p4–p7 框选的 4 处】')
    expect(referenceText(many, en)).toBe('[p4–p7, 4 boxed elements]')
    expect(referenceText([{ ref: 'p8', role: 'p', name: '一'.repeat(40) }], zh)).toBe(`【p8 段落「${'一'.repeat(24)}…」】`)
    expect(referenceText([], zh)).toBe('')
  })
})

describe('inserting at the cursor', () => {
  it('pads with spaces and puts the cursor after the reference', () => {
    expect(insertAt('', 0, 0, '【p1】')).toEqual({ value: '【p1】 ', cursor: 5 })
    expect(insertAt('这个为什么是灰的', 2, 2, '【p1】')).toEqual({ value: '这个 【p1】 为什么是灰的', cursor: 8 })
    expect(insertAt('看 这里', 2, 4, '【p2】')).toEqual({ value: '看 【p2】 ', cursor: 7 }) // 替换选中的字 / replaces the selection
    expect(insertAt('a ', 2, 2, '[p3]')).toEqual({ value: 'a [p3] ', cursor: 7 })
  })
})

type Node = { id: string; rect: Rect | null; kids?: Node[] }
const r = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom })

describe('elements inside a box', () => {
  // 一个列表：外框 0..400，三行，每行里有标题和按钮；旁边还有一个被跳过的（小助手）。
  // A list: frame 0..400, three rows each with a title and a button; beside it one that is skipped (the assistant).
  const row = (n: number): Node => ({ id: `row${n}`, rect: r(0, n * 100, 400, n * 100 + 90), kids: [{ id: `title${n}`, rect: r(10, n * 100 + 10, 200, n * 100 + 40) }, { id: `btn${n}`, rect: r(300, n * 100 + 10, 380, n * 100 + 40) }] })
  const tree: Node[] = [
    { id: 'page', rect: r(0, 0, 1000, 1000), kids: [{ id: 'list', rect: r(0, 0, 400, 400), kids: [row(0), row(1), row(2)] }, { id: 'contents', rect: r(0, 0, 0, 0), kids: [{ id: 'inner', rect: r(500, 500, 520, 520) }] }] },
    { id: 'dock', rect: null, kids: [{ id: 'dock-btn', rect: r(10, 10, 20, 20) }] },
  ]
  const pick = (box: Rect) => topmostInside(tree, (n) => n.kids ?? [], (n) => n.rect, box).map((n) => n.id)

  it('takes the outermost elements wholly inside, not their children', () => {
    expect(pick(rectFrom(-5, 95, 405, 295))).toEqual(['row1', 'row2'])
    expect(pick(r(-1, -1, 401, 401))).toEqual(['list'])
  })
  it('searches inside what straddles the edge', () => {
    expect(pick(r(0, 0, 250, 300))).toEqual(['title0', 'title1', 'title2'])
    expect(pick(r(290, 105, 390, 145))).toEqual(['btn1'])
  })
  it('skips what is left out, looks through elements without size, and finds nothing in empty space', () => {
    expect(pick(r(0, 0, 30, 30))).toEqual([]) // 小助手里的按钮不算 / the assistant's button does not count
    expect(pick(r(490, 490, 530, 530))).toEqual(['inner'])
    expect(pick(r(600, 600, 700, 700))).toEqual([])
  })
  it('normalises a box dragged in any direction', () => {
    expect(rectFrom(300, 200, 100, 50)).toEqual(r(100, 50, 300, 200))
    expect(within(r(1, 1, 2, 2), r(0, 0, 3, 3)) && !within(r(1, 1, 4, 2), r(0, 0, 3, 3))).toBe(true)
  })
})
