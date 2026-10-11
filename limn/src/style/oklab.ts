import { t } from '../i18n'

/** OKLCh <-> sRGB. L 0..1, C about 0..0.3, h in degrees. */
export type RGB = [number, number, number]

function toLinear(l: number, a: number, b: number): RGB {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
}

const gamma = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)
const inGamut = (c: RGB) => c.every((v) => v >= -1e-4 && v <= 1 + 1e-4)

/** Returns sRGB 0..1. Out-of-gamut colours keep L and h and lose chroma. */
export function oklch(L: number, C: number, h: number): RGB {
  const hr = (h * Math.PI) / 180
  let lin = toLinear(L, C * Math.cos(hr), C * Math.sin(hr))
  if (!inGamut(lin)) {
    let lo = 0, hi = C
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(toLinear(L, mid * Math.cos(hr), mid * Math.sin(hr)))) lo = mid
      else hi = mid
    }
    lin = toLinear(L, lo * Math.cos(hr), lo * Math.sin(hr))
  }
  return lin.map((v) => gamma(Math.min(1, Math.max(0, v)))) as RGB
}

export function toOklch(rgb: RGB): { L: number; C: number; h: number } {
  const [r, g, b] = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as RGB
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { L, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 }
}

export function hex(rgb: RGB): string {
  return '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')
}

export function parseHex(s: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim())
  if (!m) throw new Error(t('error.notColor', { value: s }))
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
