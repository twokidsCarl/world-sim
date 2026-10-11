// 语谱图：0–8 kHz，线性频率轴，60 dB 动态范围，单一色相由浅到深（越深能量越大）。
// 左侧刻度每 1 kHz 一格，底部刻度每 0.5 秒一格。
// Spectrogram: 0–8 kHz on a linear frequency axis, 60 dB of dynamic range, one hue from light to dark
// (darker = more energy). Ticks every 1 kHz on the left and every 0.5 s along the bottom.

import { Image } from '../skinmaps/render.ts'
import { fft } from './analysis.ts'

const MAX_HZ = 8000
const PLOT_H = 200
const LEFT = 26
const BOTTOM = 14
const TOP = 12
const PX_PER_S = 200
const RANGE_DB = 60
// 单色相色带的两端（浅 → 深）/ the two ends of the single-hue ramp (light → dark)
const LIGHT = [247, 249, 252]
const DARK = [12, 44, 110]
const INK = [70, 70, 70]

export function spectrogram(pcm: Float32Array, sampleRate: number, title: string, widthS?: number): Image {
  const size = 1024
  const duration = pcm.length / sampleRate
  const plotW = Math.max(40, Math.ceil((widthS ?? duration) * PX_PER_S))
  const img = new Image(LEFT + plotW + 6, TOP + PLOT_H + BOTTOM, [255, 255, 255])
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const columns = Math.min(plotW, Math.ceil(duration * PX_PER_S))
  const db = new Float32Array(columns * PLOT_H)
  let max = -Infinity
  for (let c = 0; c < columns; c++) {
    const centre = Math.round(((c + 0.5) / PX_PER_S) * sampleRate)
    re.fill(0); im.fill(0)
    for (let i = 0; i < size; i++) {
      const s = centre - size / 2 + i
      re[i] = (s >= 0 && s < pcm.length ? pcm[s]! : 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size))
    }
    fft(re, im)
    for (let y = 0; y < PLOT_H; y++) {
      const hz = ((y + 0.5) / PLOT_H) * MAX_HZ
      const bin = Math.min(size / 2 - 1, Math.round((hz * size) / sampleRate))
      const v = 10 * Math.log10(re[bin]! ** 2 + im[bin]! ** 2 + 1e-12)
      db[c * PLOT_H + y] = v
      if (v > max) max = v
    }
  }
  img.rect(LEFT, TOP, plotW, PLOT_H, LIGHT)
  for (let c = 0; c < columns; c++) {
    for (let y = 0; y < PLOT_H; y++) {
      const u = Math.min(1, Math.max(0, (db[c * PLOT_H + y]! - (max - RANGE_DB)) / RANGE_DB))
      img.set(LEFT + c, TOP + PLOT_H - 1 - y, LIGHT.map((l, i) => Math.round(l + (DARK[i]! - l) * u)))
    }
  }
  for (let k = 0; k <= MAX_HZ / 1000; k++) {
    const y = TOP + PLOT_H - Math.round((k * 1000 * PLOT_H) / MAX_HZ)
    img.rect(LEFT - 4, Math.min(y, TOP + PLOT_H - 1), 4, 1, INK)
    if (k % 2 === 0) img.text(2, Math.max(0, y - 3), `${k}K`, INK)
  }
  for (let t = 0; t * PX_PER_S <= plotW; t += 0.5) {
    img.rect(LEFT + Math.round(t * PX_PER_S), TOP + PLOT_H, 1, t % 1 === 0 ? 5 : 3, INK)
    if (t % 1 === 0) img.text(LEFT + Math.round(t * PX_PER_S) + 3, TOP + PLOT_H + 5, `${t}S`, INK)
  }
  img.text(LEFT, 2, title, INK)
  return img
}
