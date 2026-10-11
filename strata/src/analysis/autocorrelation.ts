// 时间序列的自相关与它的累积积分，用于 Green–Kubo 关系。
// Autocorrelation of a time series and its running integral, for Green–Kubo relations.

/**
 * 自相关 C(k) = ⟨x(t) x(t + k)⟩，k = 0..maxLag，先减去均值。
 * Autocorrelation C(k) = ⟨x(t) x(t + k)⟩ for k = 0..maxLag, after subtracting the mean.
 */
export function autocorrelation(x: ArrayLike<number>, maxLag: number): Float64Array {
  const n = x.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += x[i]! / n
  const lags = Math.min(maxLag, n - 1)
  const out = new Float64Array(lags + 1)
  for (let k = 0; k <= lags; k++) {
    let sum = 0
    for (let i = 0; i + k < n; i++) sum += (x[i]! - mean) * (x[i + k]! - mean)
    out[k] = sum / (n - k)
  }
  return out
}

/**
 * 梯形法的累积积分：out[k] = ∫₀^{k dt} C。
 * Running integral by the trapezoid rule: out[k] = ∫₀^{k dt} C.
 */
export function runningIntegral(c: ArrayLike<number>, dt: number): Float64Array {
  const out = new Float64Array(c.length)
  for (let k = 1; k < c.length; k++) out[k] = out[k - 1]! + 0.5 * dt * (c[k - 1]! + c[k]!)
  return out
}

/**
 * 逐个样本累计的自相关估计：每来一个样本，就把它与此前 maxLag 个样本的乘积加进各自的和里。
 * 这样记录可以任意长，估计随时间不断收敛，而不必保存整个序列。
 *
 * An autocorrelation estimate accumulated one sample at a time: each new sample's
 * products with the previous maxLag samples are added to running sums. The record can
 * then be arbitrarily long and the estimate keeps converging, without storing the series.
 */
export class Correlator {
  private recent: Float64Array
  private sums: Float64Array
  private counts: Float64Array
  private total = 0
  /** 已加入的样本数 / Number of samples added */
  samples = 0

  constructor(readonly maxLag: number) {
    this.recent = new Float64Array(maxLag + 1)
    this.sums = new Float64Array(maxLag + 1)
    this.counts = new Float64Array(maxLag + 1)
  }

  add(x: number): void {
    const size = this.maxLag + 1
    this.recent[this.samples % size] = x
    const lags = Math.min(this.maxLag, this.samples)
    for (let k = 0; k <= lags; k++) {
      this.sums[k]! += x * this.recent[(this.samples - k) % size]!
      this.counts[k]!++
    }
    this.total += x
    this.samples++
  }

  /** C(k)，k = 0..maxLag，已减去均值的平方。 / C(k) for k = 0..maxLag, with the squared mean subtracted. */
  result(): Float64Array {
    const mean = this.samples > 0 ? this.total / this.samples : 0
    return Float64Array.from(this.sums, (s, k) => (this.counts[k]! > 0 ? s / this.counts[k]! - mean * mean : 0))
  }
}
