// 精修循环：改完直接比较，没变好就退回 / the review loop: compare directly after a change, undo it unless better
import { describe, expect, it } from 'vitest'
import { runRounds, type Proposal, type Verdict } from '../src/refine/rounds'

/** 外观就是一个数；“画面”是它的字符串 / the look is one number; the "picture" is its string */
function driver(proposals: Proposal<number>[], verdicts: Verdict[]) {
  let look = 0
  const seen: { histories: string[][]; compared: [string, string][] } = { histories: [], compared: [] }
  const logs = runRounds<number, number, string>({
    maxRounds: 6,
    maxEdits: 2,
    getLook: () => look,
    setLook: (l) => (look = l),
    capture: async () => `look ${look}`,
    propose: async (_shot, history, k) => (seen.histories.push(history.slice()), proposals[k] ?? { comment: '', overall: null, edits: [], done: true }),
    apply: (edits) => edits.forEach((e) => (look += e)),
    compare: async (a, b) => (seen.compared.push([a, b]), { verdict: verdicts.shift() ?? 'same', reason: 'r' }),
    describe: (e) => e.join('+'),
  })
  return { logs, seen, look: () => look }
}
const p = (...edits: number[]): Proposal<number> => ({ comment: 'c', overall: 7, edits, done: false })

describe('runRounds', () => {
  it('keeps a change judged better and builds on it', async () => {
    const d = driver([p(1), p(10)], ['better', 'better'])
    const logs = await d.logs
    expect(d.look()).toBe(11)
    expect(logs.map((l) => l.kept)).toEqual([true, true, false])
    // 第二次比较的“之前”是第一轮留下的结果 / the second comparison's "before" is what the first round left
    expect(d.seen.compared).toEqual([['look 0', 'look 1'], ['look 1', 'look 11']])
  })

  it('undoes a change that is worse or merely no better, and tells the next round', async () => {
    const d = driver([p(1), p(10), p(100)], ['worse', 'same', 'better'])
    const logs = await d.logs
    // 连续两轮没有改进就停了，第三轮没有机会 / two rounds in a row without improvement end it; the third never runs
    expect(logs.length).toBe(2)
    expect(d.look()).toBe(0)
    expect(logs.map((l) => [l.verdict, l.kept])).toEqual([['worse', false], ['same', false]])
    expect(d.seen.histories[1]![0]).toMatch(/tried 1 .*worse.*undone/)
  })

  it('resets the count of misses after an improvement', async () => {
    const d = driver([p(1), p(10), p(100), p(1000)], ['worse', 'better', 'worse', 'better'])
    await d.logs
    expect(d.look()).toBe(1010)
  })

  it('takes only the first few edits of a round, and stops when the reviewer has nothing to change', async () => {
    const d = driver([p(1, 2, 4, 8), { comment: 'fine', overall: 8, edits: [], done: false }, p(100)], ['better'])
    const logs = await d.logs
    expect(d.look()).toBe(3)
    expect(logs.length).toBe(2)
    expect(logs[0]!.proposal.edits).toEqual([1, 2])
    expect(d.seen.compared.length).toBe(1)
  })

  it('makes no comparison when the first answer is "done"', async () => {
    const d = driver([{ comment: 'ready', overall: 9, edits: [5], done: true }], [])
    await d.logs
    expect(d.look()).toBe(0)
    expect(d.seen.compared).toEqual([])
  })
})
