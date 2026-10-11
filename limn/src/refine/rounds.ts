/**
 * 精修循环的骨架，和画图、调模型都无关，所以能单独测试。
 *
 * 评审给同一张图打的绝对分自己就会波动半分到一分（实测同一张图四次：6.5、7、7、7），
 * 所以不能靠“这一轮比上一轮分高”来判断改得对不对。这里每一轮改完后，把改之前和改之后的两张图
 * 交给评审直接比较：更好才留下，否则立刻退回，并把“这个改法没用”记进历史。
 *
 * The skeleton of the review loop, independent of drawing and of the model, so it can be tested alone.
 *
 * The absolute score a reviewer gives one picture wanders by half a point to a point on its own
 * (measured on one unchanged picture, four times: 6.5, 7, 7, 7), so "this round scored higher than
 * the last" cannot tell a good change from a bad one. Here, after each round's changes, the
 * pictures before and after are given to the reviewer to compare directly: the change stays only
 * if it is better, is otherwise undone at once, and "that did not help" goes into the history.
 */
export type Verdict = 'better' | 'worse' | 'same'

export interface Proposal<E> {
  /** 评审对当前这张图的评语 / the reviewer's comment on the current picture */
  comment: string
  /** 仅供显示的总分 / an overall score, for display only */
  overall: number | null
  edits: E[]
  /** 评审认为不必再改 / the reviewer sees nothing more worth changing */
  done: boolean
}

export interface RoundLog<E, L, S> {
  /** 这一轮开始时的画面和外观 / the picture and look this round started from */
  shot: S
  look: L
  proposal: Proposal<E>
  /** 改完后与改之前比较的结论；没有改动时为 null / how the result compared with what came before; null when nothing was changed */
  verdict: Verdict | null
  reason: string
  /** 这一轮的修改是否留下了 / whether this round's changes were kept */
  kept: boolean
}

export interface Driver<E, L, S> {
  maxRounds: number
  /** 一轮最多采纳几项修改 / the most edits taken in one round */
  maxEdits: number
  getLook(): L
  setLook(look: L): void
  capture(): Promise<S>
  propose(shot: S, history: string[], round: number): Promise<Proposal<E>>
  apply(edits: E[]): void
  compare(before: S, after: S): Promise<{ verdict: Verdict; reason: string }>
  describe(edits: E[]): string
  onRound?(log: RoundLog<E, L, S>): void
}

/** 连续几轮没有改进就停 / stop after this many rounds in a row without an improvement */
const MAX_MISSES = 2

export async function runRounds<E, L, S>(d: Driver<E, L, S>): Promise<RoundLog<E, L, S>[]> {
  const logs: RoundLog<E, L, S>[] = []
  const history: string[] = []
  let misses = 0
  let shot = await d.capture()
  for (let k = 0; k < d.maxRounds && misses < MAX_MISSES; k++) {
    const look = d.getLook()
    const proposal = await d.propose(shot, history, k)
    const edits = proposal.edits.slice(0, d.maxEdits)
    const log: RoundLog<E, L, S> = { shot, look, proposal: { ...proposal, edits }, verdict: null, reason: '', kept: false }
    logs.push(log)
    if (proposal.done || edits.length === 0) {
      d.onRound?.(log)
      break
    }
    d.apply(edits)
    const after = await d.capture()
    const { verdict, reason } = await d.compare(shot, after)
    log.verdict = verdict
    log.reason = reason
    if (verdict === 'better') {
      log.kept = true
      shot = after
      misses = 0
      history.push(`round ${k + 1}: changed ${d.describe(edits)} — judged an improvement and kept`)
    } else {
      // 没有变好就退回去：不留下一个说不出好处的改动 / not better, so it is undone: a change with no benefit to show is not left in
      d.setLook(look)
      misses++
      history.push(`round ${k + 1}: tried ${d.describe(edits)} — judged ${verdict === 'worse' ? 'worse' : 'no better'} than before (${reason}) and undone; do not propose it again`)
    }
    d.onRound?.(log)
  }
  return logs
}
