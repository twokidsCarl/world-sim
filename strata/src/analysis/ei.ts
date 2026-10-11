// 有效信息（effective information，Hoel, Albantakis & Tononi 2013）：把系统等概率地置于
// 每一个状态，看它的下一个状态能告诉我们多少关于“被置于哪个状态”的信息。
//   EI = (1/n) Σ_i D_KL(T_i ‖ T̄)，T_i 是转移矩阵的第 i 行，T̄ 是各行的平均。
// 动力学越确定、不同状态的去向越不重叠，EI 越大；上限是 log₂ n。
//
// Effective information (Hoel, Albantakis & Tononi 2013): set the system into each state
// with equal probability and ask how much its next state tells us about which state that was.
//   EI = (1/n) Σ_i D_KL(T_i ‖ T̄), with T_i row i of the transition matrix and T̄ the mean row.
// It is large when the dynamics are deterministic and different states lead to different
// places; its maximum is log₂ n.

/**
 * 由转移计数估计有效信息，单位比特。counts 按行优先排成 n × n，counts[i * n + j] 是
 * 从状态 i 到状态 j 的次数。从未出现过的状态（整行为零）不参与：它们的转移概率无从估计。
 *
 * Effective information in bits, estimated from transition counts. `counts` is n × n in
 * row-major order: counts[i * n + j] is the number of transitions from state i to state j.
 * States never observed (all-zero rows) are left out: their transition probabilities
 * cannot be estimated.
 */
export function effectiveInformation(counts: ArrayLike<number>, n: number): number {
  const rows: number[][] = []
  for (let i = 0; i < n; i++) {
    let total = 0
    for (let j = 0; j < n; j++) total += counts[i * n + j]!
    if (total > 0) rows.push(Array.from({ length: n }, (_, j) => counts[i * n + j]! / total))
  }
  if (rows.length === 0) return 0
  const mean = Array.from({ length: n }, (_, j) => rows.reduce((s, r) => s + r[j]!, 0) / rows.length)
  let ei = 0
  for (const row of rows) {
    for (let j = 0; j < n; j++) if (row[j]! > 0) ei += (row[j]! * Math.log2(row[j]! / mean[j]!)) / rows.length
  }
  return ei
}
