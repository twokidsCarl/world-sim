// 从声音估计口型：每秒 100 帧的张口度、圆唇/展唇、双唇闭合、唇齿摩擦、舌位权重，各带一个置信度。
// 纯函数，没有依赖；同样的输入总是给出同样的输出。
// Mouth features estimated from audio: jaw opening, lip rounding/spreading, bilabial closure,
// labiodental frication and tongue weights at 100 frames per second, each with a confidence.
// A pure function without dependencies; the same input always gives the same output.
//
// 用到的声学关系和出处（「未打开」= 只核对了书目信息，没有读到原文；这些关系在语音学教科书里是通行说法）：
// - 张口度 ← 第一共振峰 F1：下颌打开、元音变「开」时 F1 升高。Lindblom & Sundberg (1971), JASA 50:1166–1179（未打开）。
// - 前后/圆展 ← 第二共振峰 F2：舌位靠前 F2 高；舌位靠后和圆唇都使 F2 降低，圆唇还使 F3 降低（出处同上，未打开）。
//   只凭声音分不开「舌位靠后」和「圆唇」，所以 round 的置信度定得低，back 和 round 是同一个线索的两种读法。
// - 擦音：咝音（s、sh）强而频谱重心高，非咝音（f、th）弱而平。Jongman, Wayland & Wong (2000), JASA 108:1252–1263
//   （读了摘要：除 locus equation 外的各线索都能区分咝音与非咝音）。f 和 th、h 只凭这些线索分不开；
//   在带音素对齐的语音上检验，dental 这一项区分不了唇齿音和咝音（见 tools/voice/moutheval.ts），所以置信度固定为 0.1，使用方应当忽略它。
// - 塞音：闭合段本身是一段静音或只有低频的浊音，看不出发音部位。部位的线索取闭合两侧 F2 的走向（双唇音两侧 F2 向下）
//   和除阻爆破的频谱（双唇音偏低频、平而下降；齿龈音偏高频）。Stevens & Blumstein (1978), JASA 64:1358–1368（未打开）。
//   这两个线索都不可靠；拿不准时给一个中等的「一般性闭合」(0.5) 和低置信度。
// - 鼻音：闭口时的鼻腔哼鸣能量集中在几百赫兹以下；m、n、ng 的区别同样只能靠两侧的 F2 走向。
// 只凭声音确定不了的：圆唇与舌位靠后的区分；f 与 th、h 的区分；没有除阻也没有过渡的闭合的部位；
// 基频高于 F1 时（尖叫、高音）的张口度——这时 F1 测不准，open 改用响度来估，置信度降低。
// The acoustic relations used and their sources ("not opened" = only the bibliographic record was
// checked, the text was not read; the relations are standard textbook phonetics):
// - opening ← first formant F1: F1 rises as the jaw opens and the vowel becomes more open. Lindblom &
//   Sundberg (1971), JASA 50:1166–1179 (not opened).
// - front/back and rounding ← second formant F2: a fronted tongue raises F2; a backed tongue and
//   rounded lips both lower it, and rounding lowers F3 as well (same source, not opened). Audio alone
//   cannot separate "tongue back" from "lips rounded", so `round` gets a low confidence and `back` and
//   `round` are two readings of one cue.
// - fricatives: sibilants (s, sh) are strong with a high spectral centre, non-sibilants (f, th) weak
//   and flat. Jongman, Wayland & Wong (2000), JASA 108:1252–1263 (abstract read: all cues except locus
//   equations distinguish sibilants from non-sibilants). f cannot be told from th or h by these cues,
//   and on phone-aligned speech `dental` fails to separate labiodentals from sibilants (see
//   tools/voice/moutheval.ts); its confidence is therefore fixed at 0.1 and consumers should ignore it.
// - stops: the closure itself is silence or low-frequency voicing and says nothing about place. Place
//   is read from the direction of F2 on either side (downwards towards a bilabial) and from the burst
//   spectrum (bilabials low and flat-falling, alveolars high). Stevens & Blumstein (1978), JASA
//   64:1358–1368 (not opened). Both cues are unreliable; when in doubt the result is a middling
//   "generic closure" (0.5) with low confidence.
// - nasals: the murmur of a closed mouth keeps its energy below a few hundred hertz; m, n and ng again
//   differ only in the F2 movement around them.
// What audio alone cannot determine: rounding versus tongue backing; f versus th or h; the place of a
// closure with neither release nor transitions; and the opening when F0 lies above F1 (screams, high
// notes), where F1 cannot be measured, `open` falls back on loudness and its confidence drops.

import { fft } from './fft.ts'
import { resample } from './resample.ts'

export interface MouthFrame {
  // 秒 / seconds
  t: number
  // 张口度 0–1 / jaw opening, 0–1
  open: number
  // −1（展唇）… +1（圆唇）/ −1 (spread) … +1 (rounded)
  round: number
  // 双唇闭合 0–1；0.5 左右表示「有闭合但部位不明」/ bilabial closure, 0–1; around 0.5 means "a closure of unknown place"
  closure: number
  // 唇齿摩擦 0–1 / labiodental frication, 0–1
  dental: number
  tongue: { low: number; front: number; back: number; tip: number }
  voiced: boolean
  // 相对响度 0–1 / relative loudness, 0–1
  level: number
  // 各特征的置信度 0–1 / confidence of each feature, 0–1
  confidence: { open: number; round: number; closure: number; dental: number; tongue: number }
  // 测到的共振峰（Hz），测不到为 0 / measured formants (Hz), 0 when not found
  f1: number
  f2: number
  f3: number
}

export const MOUTH_FRAME_RATE = 100
const RATE = 16000
const LPC_RATE = 10000
const LPC_ORDER = 12
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// 线性预测系数（自相关法 + Levinson 递推）的根 → 共振峰频率和带宽。
// Roots of the linear-prediction polynomial (autocorrelation method, Levinson recursion) → formant frequencies and bandwidths.
function lpcFormants(x: Float32Array, centre: number): { f: number; bw: number }[] {
  const n = 250
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const k = centre - n / 2 + i
    const v = k > 0 && k < x.length ? x[k]! - 0.97 * x[k - 1]! : 0
    w[i] = v * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)))
  }
  const r = new Float64Array(LPC_ORDER + 1)
  for (let l = 0; l <= LPC_ORDER; l++) { let s = 0; for (let i = l; i < n; i++) s += w[i]! * w[i - l]!; r[l] = s }
  if (r[0]! < 1e-10) return []
  r[0] = r[0]! * 1.0001
  const a = new Float64Array(LPC_ORDER + 1)
  a[0] = 1
  let err = r[0]!
  const tmp = new Float64Array(LPC_ORDER + 1)
  for (let i = 1; i <= LPC_ORDER; i++) {
    let acc = r[i]!
    for (let j = 1; j < i; j++) acc += a[j]! * r[i - j]!
    const k = -acc / err
    tmp.set(a)
    for (let j = 1; j < i; j++) a[j] = tmp[j]! + k * tmp[i - j]!
    a[i] = k
    err *= 1 - k * k
    if (err <= 0) return []
  }
  // Durand–Kerner 求根 / Durand–Kerner root finding
  const p = LPC_ORDER
  const zr = new Float64Array(p)
  const zi = new Float64Array(p)
  for (let i = 0; i < p; i++) { const ang = (2 * Math.PI * (i + 0.35)) / p; zr[i] = 0.9 * Math.cos(ang); zi[i] = 0.9 * Math.sin(ang) }
  for (let it = 0; it < 60; it++) {
    let move = 0
    for (let i = 0; i < p; i++) {
      let pr = 1
      let pi = 0
      for (let j = 1; j <= p; j++) { const t = pr * zr[i]! - pi * zi[i]! + a[j]!; pi = pr * zi[i]! + pi * zr[i]!; pr = t }
      let dr = 1
      let di = 0
      for (let j = 0; j < p; j++) {
        if (j === i) continue
        const er = zr[i]! - zr[j]!
        const ei = zi[i]! - zi[j]!
        const t = dr * er - di * ei
        di = dr * ei + di * er
        dr = t
      }
      const den = dr * dr + di * di || 1e-30
      const qr = (pr * dr + pi * di) / den
      const qi = (pi * dr - pr * di) / den
      zr[i] = zr[i]! - qr
      zi[i] = zi[i]! - qi
      move += Math.abs(qr) + Math.abs(qi)
    }
    if (move < 1e-10) break
  }
  const out: { f: number; bw: number }[] = []
  for (let i = 0; i < p; i++) {
    if (zi[i]! <= 0.01) continue
    const f = (Math.atan2(zi[i]!, zr[i]!) * LPC_RATE) / (2 * Math.PI)
    const bw = (-Math.log(Math.hypot(zr[i]!, zi[i]!)) * LPC_RATE) / Math.PI
    if (f > 150 && f < 4800 && bw < 600) out.push({ f, bw })
  }
  return out.sort((u, v) => u.f - v.f)
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1]! : 0 }

export function mouthTrack(pcm: Float32Array, sampleRate: number): MouthFrame[] {
  const x = resample(pcm, sampleRate, RATE, 8)
  const xl = resample(pcm, sampleRate, LPC_RATE, 8)
  const count = Math.max(0, Math.ceil((pcm.length / sampleRate) * MOUTH_FRAME_RATE))
  const size = 512
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const db = new Float64Array(count)
  const low = new Float64Array(count)
  const high = new Float64Array(count)
  const centroid = new Float64Array(count)
  const voiced: boolean[] = []
  const f0: number[] = []
  const F: number[][] = []
  for (let i = 0; i < count; i++) {
    const c = Math.round((i / MOUTH_FRAME_RATE) * RATE)
    re.fill(0); im.fill(0)
    let e = 0
    for (let k = 0; k < 400; k++) { const v = x[c - 200 + k] ?? 0; e += v * v; re[k] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / 400)) }
    db[i] = 10 * Math.log10(e / 400 + 1e-12)
    fft(re, im)
    let tot = 1e-20
    let lo = 0
    let hi = 0
    let cn = 0
    for (let k = 2; k < size / 2; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!
      const hz = (k * RATE) / size
      tot += p; cn += p * hz
      if (hz < 500) lo += p
      if (hz > 2500) hi += p
    }
    low[i] = lo / tot; high[i] = hi / tot; centroid[i] = cn / tot
    // 有声判定：40 毫秒窗的归一化自相关，基频范围 70–500 Hz / voicing: normalised autocorrelation over 40 ms, F0 range 70–500 Hz
    let r0 = 0
    for (let k = -320; k < 320; k++) { const v = x[c + k] ?? 0; r0 += v * v }
    let best = 0
    let bestLag = 0
    if (r0 > 1e-9) {
      for (let lag = 32; lag <= 228; lag++) {
        // 隔一个样本取一个（相当于 8 kHz），按重叠长度校正 / every other sample (8 kHz in effect), corrected for the overlap length
        let s = 0
        for (let k = -320; k < 320 - lag; k += 2) s += (x[c + k] ?? 0) * (x[c + k + lag] ?? 0)
        const r = ((2 * s) / r0) * (640 / (640 - lag))
        if (r > best + 0.02 || (r > best && lag < bestLag * 1.5)) { best = r; bestLag = lag }
      }
    }
    voiced.push(best >= 0.5)
    f0.push(best >= 0.5 ? RATE / bestLag : 0)
    F.push(lpcFormants(xl, Math.round((i / MOUTH_FRAME_RATE) * LPC_RATE)).map((q) => q.f))
  }
  let peak = -Infinity
  for (let i = 0; i < count; i++) peak = Math.max(peak, db[i]!)
  const level = (i: number) => (peak > -70 ? clamp((db[i]! - (peak - 40)) / 40, 0, 1) : 0)
  const sounding = (i: number) => peak > -70 && db[i]! > peak - 30
  // 闭口的浊音（鼻音哼鸣、浊塞音的闭合段）：能量几乎全在 500 Hz 以下，而且比前后 120 毫秒内最响的一帧低 6 dB 以上。
  // 只看低频占比不行：闭元音（i、u）的能量也集中在低频。
  // Closed-mouth voicing (nasal murmur, the closure of a voiced stop): energy almost entirely below
  // 500 Hz and more than 6 dB under the loudest frame within 120 ms on either side. The low-frequency
  // share alone will not do: close vowels (i, u) keep their energy low as well.
  const localMax = (i: number) => { let m = -Infinity; for (let k = Math.max(0, i - 12); k <= Math.min(count - 1, i + 12); k++) m = Math.max(m, db[k]!); return m }
  const murmur = (i: number) => sounding(i) && voiced[i]! && low[i]! > 0.9 && db[i]! < localMax(i) - 6
  const sonorant = (i: number) => sounding(i) && voiced[i]! && db[i]! > peak - 22 && !murmur(i)
  // 共振峰：五帧中值平滑 / formants: five-frame median smoothing
  const fk = (k: number) => {
    const raw = F.map((f) => f[k] ?? 0)
    return raw.map((_, i) => median(raw.slice(Math.max(0, i - 2), i + 3).filter((v) => v > 0)))
  }
  const f1 = fk(0)
  const f2 = fk(1)
  const f3 = fk(2)
  // 说话人的声道尺度：有声帧 F3 的中位数相对 2600 Hz（假设中性的成年男声 F3）
  // the speaker's vocal-tract scale: median F3 over voiced frames relative to 2600 Hz (assumed neutral adult male F3)
  const f3s = f3.filter((v, i) => v > 1800 && sonorant(i))
  const scale = f3s.length >= 5 ? clamp(median(f3s) / 2600, 0.8, 1.35) : 1

  const frames: MouthFrame[] = []
  for (let i = 0; i < count; i++) {
    const lv = level(i)
    const son = sonorant(i)
    const n1 = f1[i]! / scale
    const n2 = f2[i]! / scale
    // 基频太高时 F1 测不准（谐波太稀）：改用响度 / with F0 too high F1 cannot be measured (harmonics too sparse): fall back on loudness
    const highPitch = f0[i]! > 0 && (f0[i]! > 350 || f0[i]! > 0.8 * f1[i]!)
    let open = 0
    let cOpen = 0.6
    let round = 0
    let front = 0
    let back = 0
    let cTongue = 0.2
    if (son && n1 > 0 && !highPitch) {
      // F1 280 Hz（闭元音）→ 0，800 Hz（开元音）→ 1；尺度是这里的假设 / F1 280 Hz (close vowel) → 0, 800 Hz (open vowel) → 1; the scale is an assumption of ours
      open = clamp((n1 - 280) / 520, 0.05, 1)
      cOpen = 0.7
      if (n2 > 0) {
        front = clamp((n2 - 1300) / 900, 0, 1)
        back = clamp((1400 - n2) / 600, 0, 1)
        // F2 低且 F3 也低时更像圆唇；F2 高则展唇 / low F2 together with low F3 looks more like rounding; high F2 means spread lips
        const f3low = f3[i]! > 0 && f3[i]! / scale < 2350 ? 0.25 : 0
        // 开元音（F1 高）不算圆唇：[a] 的 F2 也低，但嘴是张开的 / open vowels (high F1) do not count as rounded: [a] has a low F2 too, with the mouth open
        const raw = clamp((1450 - n2) / 600 + (n2 < 1450 ? f3low : 0), -1, 1)
        round = raw > 0 ? raw * clamp((780 - n1) / 250, 0, 1) : raw
        cTongue = 0.5
      }
    } else if (son) {
      open = clamp(0.25 + 0.75 * lv, 0, 1)
      cOpen = 0.3
    } else if (!sounding(i)) {
      open = 0
      cOpen = 0.8
    }
    // 摩擦：有声音、高频占多数、不是响音 / frication: sounding, mostly high-frequency, not a sonorant
    // 弱的清擦音（f、th）常比最响处低 30 dB 以上，所以这里的门限放到 45 dB / weak voiceless fricatives (f, th) often lie more than 30 dB under the peak, hence a 45 dB gate here
    const fric = peak > -70 && db[i]! > peak - 45 && !son && !voiced[i]! && high[i]! > 0.45 ? 1 : 0
    // 咝音：频谱重心高而且强（Jongman 等 2000）/ sibilant: a high spectral centre and strong (Jongman et al. 2000)
    const sib = fric * clamp((centroid[i]! - 3200) / 1200, 0, 1) * clamp((db[i]! - (peak - 28)) / 8, 0, 1)
    // 唇齿音的得分：是摩擦、不是咝音、而且弱 / the labiodental score: frication that is not sibilant and is weak
    const dental = fric * (1 - sib) * clamp((peak - 16 - db[i]!) / 8, 0, 1)
    if (fric) { open = 0.12; cOpen = 0.4 }
    frames.push({
      t: i / MOUTH_FRAME_RATE, open, round, closure: 0, dental,
      tongue: { low: open, front: Math.max(front, sib * 0.6), back, tip: sib },
      voiced: voiced[i]! && sounding(i), level: lv,
      confidence: { open: cOpen, round: son ? 0.35 : 0.1, closure: 0.5, dental: 0.1, tongue: cTongue },
      f1: son ? f1[i]! : 0, f2: son ? f2[i]! : 0, f3: son ? f3[i]! : 0,
    })
  }

  // 闭合：夹在有声音的帧之间、30–220 毫秒的「安静或只有低频」的一段。
  // Closures: stretches of 30–220 ms that are quiet or low-frequency only, between sounding frames.
  const closed = (i: number) => !sounding(i) || murmur(i)
  let i = 0
  while (i < count) {
    if (!closed(i)) { i++; continue }
    let j = i
    while (j < count && closed(j)) j++
    const len = j - i
    const inside = i > 0 && j < count
    if (inside && len >= 3 && len <= 22) {
      // 部位线索一：闭合两侧 F2 的走向（靠近闭合处比 40 毫秒外低 → 像双唇）
      // place cue 1: the direction of F2 on either side (lower next to the closure than 40 ms away → bilabial-like)
      let votes = 0
      let seen = 0
      const near = (a: number, b: number) => {
        const fa = frames[a]?.f2 ?? 0
        const fb = frames[b]?.f2 ?? 0
        if (fa > 0 && fb > 0) { seen++; votes += clamp((fb - fa) / 150, -1, 1) }
      }
      near(i - 1, i - 5)
      near(j, j + 4)
      // 部位线索二：除阻后 20 毫秒的频谱重心（低 → 双唇，高 → 齿龈）
      // place cue 2: the spectral centre of the 20 ms after the release (low → bilabial, high → alveolar)
      const burst = !voiced[j]! || high[j]! > 0.3 ? (centroid[j]! + (centroid[j + 1] ?? centroid[j]!)) / 2 : 0
      if (burst > 0) { seen++; votes += clamp((2200 - burst) / 1200, -1, 1) }
      const labial = seen ? clamp(0.5 + 0.5 * (votes / seen), 0, 1) : 0.5
      const conf = seen >= 2 ? 0.5 : seen === 1 ? 0.35 : 0.2
      for (let k = i; k < j; k++) {
        const f = frames[k]!
        f.closure = labial
        f.confidence.closure = conf
        f.open = Math.min(f.open, 0.08 + 0.15 * (1 - labial))
        f.tongue.tip = Math.max(f.tongue.tip, (1 - labial) * 0.6)
        f.confidence.open = 0.6
      }
    } else {
      // 长的静音：闭口、中性 / long silence: mouth closed, neutral
      for (let k = i; k < j; k++) { const f = frames[k]!; if (!sounding(k)) { f.open = 0; f.round = 0; f.confidence.closure = 0.2 } }
    }
    i = j
  }
  // 张口度做三帧滑动平均，免得逐帧跳动 / a three-frame moving average on the opening, against frame-to-frame flicker
  const o = frames.map((f) => f.open)
  for (let k = 0; k < count; k++) {
    const f = frames[k]!
    f.open = (o[Math.max(0, k - 1)]! + o[k]! + o[Math.min(count - 1, k + 1)]!) / 3
    f.tongue.low = f.open
  }
  return frames
}
