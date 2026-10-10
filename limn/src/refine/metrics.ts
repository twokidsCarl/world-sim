import { toOklch, type RGB } from '../style/oklab'

/** Numbers a reviewer can lean on, measured from the rendered pixels. */
export interface Metrics {
  /** share of the frame's width and height that the subject spans */
  fillW: number
  fillH: number
  /** subject centre relative to the frame centre, in shares of the frame */
  offsetX: number
  offsetY: number
  /** share of pixels that are outline */
  ink: number
  /** median lightness and chroma (OKLCh) of coloured areas */
  lightness: number
  chroma: number
  /** share of coloured area in each hue family, largest first */
  hues: [string, number][]
}

const FAMILIES: [string, number][] = [['red/pink', 20], ['orange/yellow', 110], ['green', 165], ['cyan/blue', 275], ['purple/magenta', 360]]

export function measure(px: Uint8ClampedArray, w: number, h: number, background: RGB): Metrics {
  const bg = background.map((v) => Math.round(v * 255))
  let x0 = w, x1 = -1, y0 = h, y1 = -1, ink = 0
  const Ls: number[] = [], Cs: number[] = []
  const fam = new Map<string, number>()
  let coloured = 0
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 60000)))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!
      if (Math.abs(r - bg[0]!) + Math.abs(g - bg[1]!) + Math.abs(b - bg[2]!) < 12) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (r + g + b < 150) {
        ink++
        continue
      }
      if (x % step || y % step) continue
      const c = toOklch([r / 255, g / 255, b / 255])
      Ls.push(c.L)
      Cs.push(c.C)
      coloured++
      if (c.C < 0.03) fam.set('grey', (fam.get('grey') ?? 0) + 1)
      else {
        const name = FAMILIES.find(([, end]) => c.h < end)?.[0] ?? 'red/pink'
        fam.set(name, (fam.get(name) ?? 0) + 1)
      }
    }
  }
  const median = (a: number[]) => (a.length ? a.sort((p, q) => p - q)[a.length >> 1]! : 0)
  const empty = x1 < 0
  return {
    fillW: empty ? 0 : (x1 - x0 + 1) / w,
    fillH: empty ? 0 : (y1 - y0 + 1) / h,
    offsetX: empty ? 0 : (x0 + x1 + 1) / 2 / w - 0.5,
    offsetY: empty ? 0 : 0.5 - (y0 + y1 + 1) / 2 / h,
    ink: ink / (w * h),
    lightness: median(Ls),
    chroma: median(Cs),
    hues: [...fam.entries()].map(([k, v]): [string, number] => [k, v / Math.max(1, coloured)]).sort((a, b) => b[1] - a[1]),
  }
}

export function describeMetrics(m: Metrics): string {
  const f = (v: number) => v.toFixed(2)
  return [
    `fill: ${f(m.fillW)} of the width, ${f(m.fillH)} of the height`,
    `subject centre is ${f(Math.abs(m.offsetX))} of the frame ${m.offsetX >= 0 ? 'right' : 'left'} and ${f(Math.abs(m.offsetY))} ${m.offsetY >= 0 ? 'above' : 'below'} the centre`,
    `ink: ${m.ink.toFixed(3)}`,
    `median lightness ${f(m.lightness)}, median chroma ${m.chroma.toFixed(3)} (OKLCh)`,
    `hue families by area: ${m.hues.filter(([, v]) => v >= 0.02).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', ')}`,
  ].join('\n')
}
