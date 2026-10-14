import { describe, expect, it } from 'vitest'
import { type Action, Dwell, stuck } from '../src/assistant/stuck'
import { emptyTurn, fold, imageUrls, parseSse } from '../src/assistant/turnView'

const T0 = new Date('2026-10-11T08:00:00Z').getTime()
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString()
const act = (sec: number, kind: Action['kind'], url = '/', text = ''): Action => ({ at: at(sec), kind, url, text })

describe('stuck rules', () => {
  it('bounce: A→B→A→B→A within two minutes', () => {
    const navs = ['/a', '/b', '/a?x=1', '/b', '/a'].map((u, i) => act(i * 10, 'navigate', u))
    expect(stuck(navs, T0 + 60_000)).toBe('bounce')
    expect(stuck(navs, T0 + 5 * 60_000)).toBe(null) // 太久以前 / too long ago
    expect(stuck(['/a', '/b', '/c', '/b', '/a'].map((u, i) => act(i, 'navigate', u)), T0 + 10_000)).toBe(null)
    expect(stuck(['/a', '/a', '/a', '/a', '/a'].map((u, i) => act(i, 'navigate', u)), T0 + 10_000)).toBe(null)
  })
  it('errors: three within a minute', () => {
    expect(stuck([act(0, 'error'), act(10, 'error'), act(20, 'error')], T0 + 30_000)).toBe('errors')
    expect(stuck([act(0, 'error'), act(10, 'error'), act(90, 'error')], T0 + 95_000)).toBe(null)
  })
  it('spin: twelve clicks on one page without leaving', () => {
    const clicks = Array.from({ length: 12 }, (_, i) => act(10 + i * 5, 'click'))
    expect(stuck([act(0, 'navigate', '/x'), ...clicks], T0 + 80_000)).toBe('spin')
    expect(stuck([...clicks.slice(0, 6), act(41, 'navigate', '/y'), ...clicks.slice(6)], T0 + 80_000)).toBe(null)
  })
})

describe('dwell time', () => {
  it('counts foreground time with recent activity only', () => {
    const d = new Dwell(0)
    d.activity(10_000)
    expect(d.seconds(30_000)).toBe(30)
    d.setVisible(false, 30_000) // 切到后台 20 秒 / 20 s in the background
    d.setVisible(true, 50_000)
    expect(d.seconds(60_000)).toBe(40)
    expect(d.seconds(10 * 60_000)).toBe(90) // 发呆：只算到最后一次操作（50 秒时回到前台）后一分钟 / idle: counted up to a minute after the last activity (back in front at 50 s)
    d.activity(10 * 60_000)
    expect(d.seconds(10 * 60_000 + 5_000)).toBe(95)
  })
})

describe('turn view', () => {
  const events = [
    { seq: 1, type: 'started', question: '这一页讲什么？', page_title: '地图' },
    { seq: 2, type: 'step', id: 't1', label: '在读 README.md', state: 'running' },
    { seq: 3, type: 'text', delta: '这一页' },
    { seq: 4, type: 'step', id: 't1', label: '在读 README.md', state: 'done' },
    { seq: 5, type: 'text', delta: '是地图。' },
    { seq: 6, type: 'wish', wish_id: 'w1', title: '空格要显眼', kind_label: '界面不清楚', occurrences: 1, new: true },
    { seq: 7, type: 'text', delta: '已经记下。' },
    { seq: 8, type: 'done', seconds: 4.2, text: '这一页是地图。已经记下。' },
  ]
  it('folds text, steps and cards in order', () => {
    const v = fold(emptyTurn(), events)
    expect(v.question).toBe('这一页讲什么？')
    expect(v.steps).toEqual([{ id: 't1', label: '在读 README.md', state: 'done' }])
    expect(v.blocks.map((b) => b.kind)).toEqual(['text', 'wish', 'text'])
    expect(v.blocks[0]).toEqual({ kind: 'text', text: '这一页是地图。' })
    expect([v.status, v.seconds, v.lastSeq]).toEqual(['done', 4.2, 8])
  })
  it('keeps the wish number when the event carries one, and leaves it out for older events', () => {
    // 新的事件带序号，旧对话回放时没有。 / New events carry the number; replayed older conversations do not.
    const card = (extra: object) => fold(emptyTurn(), [{ seq: 1, type: 'wish', wish_id: 'w1', title: 't', kind_label: 'k', occurrences: 1, new: true, ...extra }]).blocks[0]
    expect(card({ number: 3 })).toMatchObject({ kind: 'wish', wish_id: 'w1', number: 3 })
    expect(card({})).not.toHaveProperty('number')
  })
  it('is the same whether fed live in pieces or replayed at once, and ignores repeats', () => {
    let live = emptyTurn()
    for (const e of events) live = fold(live, [e])
    live = fold(live, events.slice(2, 5))
    expect(live).toEqual(fold(emptyTurn(), events))
  })
  it('shows a failure and closes running steps', () => {
    const v = fold(emptyTurn('q'), [events[1]!, { seq: 3, type: 'failed', message: '额度用完了', seconds: 1 }])
    expect([v.status, v.message, v.steps[0]!.state]).toEqual(['failed', '额度用完了', 'done'])
  })
  it('uses the final text when nothing was streamed', () => {
    expect(fold(emptyTurn(), [{ seq: 1, type: 'done', text: '整段回答', seconds: 1 }]).blocks).toEqual([{ kind: 'text', text: '整段回答' }])
  })
  it('finds the thumbnails of a question by the backend turn number, not by position', () => {
    // 刚发的：本地的图。 / Fresh: the local images.
    expect(imageUrls(emptyTurn('q', '', ['data:image/png;base64,AA']), 'c-1')).toEqual(['data:image/png;base64,AA'])
    // 回看：第 3 问（前面有一问没开成）就去取第 3 问的图。 / Looking back: turn 3 (after a question that failed to start) fetches turn 3's images.
    const back = fold(emptyTurn('q', '', [], 3), [{ seq: 1, type: 'started', question: 'q', images: 2 }])
    expect(imageUrls(back, 'c-1')).toEqual(['/api/assistant/conversations/c-1/turns/3/images/0', '/api/assistant/conversations/c-1/turns/3/images/1'])
    expect(imageUrls({ ...back, turn: null }, 'c-1')).toEqual([])
    expect(imageUrls(back, null)).toEqual([])
  })
})

describe('sse parsing', () => {
  it('keeps the incomplete tail in the buffer', () => {
    const a = parseSse('event: turn\ndata: {"turn": 3}\n\ndata: {"seq": 1, "type": "started"}\n\ndata: {"seq": 2, "ty')
    expect(a.turn).toBe(3)
    expect(a.events.map((e) => e.seq)).toEqual([1])
    const b = parseSse(a.rest + 'pe": "text", "delta": "好"}\n\n')
    expect(b.events).toEqual([{ seq: 2, type: 'text', delta: '好' }])
    expect(b.rest).toBe('')
  })
})
