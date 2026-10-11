// 重采样：汉宁窗 sinc 内插，纯函数，结果完全确定。
// Resampling by Hann-windowed sinc interpolation; a pure function with fully deterministic output.

// x 的采样率从 rateIn 变为 rateOut。zeroCrossings 是核在较低采样率下单侧的过零点数。
// Changes the sample rate of x from rateIn to rateOut. zeroCrossings is the kernel's one-sided
// number of zero crossings at the lower of the two rates.
export function resample(x: Float32Array, rateIn: number, rateOut: number, zeroCrossings = 16): Float32Array {
  if (rateIn === rateOut) return Float32Array.from(x)
  const ratio = rateIn / rateOut
  // 截止频率取较低那个奈奎斯特频率的 0.94 倍 / cutoff at 0.94 of the lower Nyquist frequency
  const fc = Math.min(1, 1 / ratio) * 0.94
  const half = zeroCrossings / fc
  const n = Math.max(1, Math.round(x.length / ratio))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i * ratio
    const k0 = Math.max(0, Math.ceil(t - half))
    const k1 = Math.min(x.length - 1, Math.floor(t + half))
    let s = 0
    for (let k = k0; k <= k1; k++) {
      const d = t - k
      const a = Math.PI * fc * d
      const sinc = Math.abs(a) < 1e-9 ? 1 : Math.sin(a) / a
      s += x[k]! * sinc * (0.5 + 0.5 * Math.cos((Math.PI * d) / half))
    }
    out[i] = s * fc
  }
  return out
}
