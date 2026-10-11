/** 场景坐标的长度单位 / the length unit of a scene's coordinates */
export type Unit = 'Å' | 'nm' | 'µm'

const IN_ANGSTROM: Record<Unit, number> = { Å: 1, nm: 10, µm: 10_000 }

export interface ScaleBar {
  /** 比例尺在画面上的长度（像素）/ length of the bar on screen, in pixels */
  px: number
  /** 标注，如 “5 nm” / its label, e.g. "5 nm" */
  label: string
  /** 比例尺代表的长度，以 Å 计 / the length the bar stands for, in Å */
  angstrom: number
}

/**
 * 一条长度凑整的比例尺：约占画面宽度的五分之一，取 1、2、5 乘以 10 的幂，
 * 并换成读起来顺的单位（不到 1 nm 用 Å，不到 1 µm 用 nm，否则 µm）。
 * 画面是正交投影，所以这条比例尺对整张图都准确。
 *
 * A scale bar of round length: about a fifth of the frame's width, as 1, 2 or 5 times a power of
 * ten, in whichever unit reads well (Å below 1 nm, nm below 1 µm, µm otherwise). The picture is
 * an orthographic projection, so the bar holds everywhere in it.
 *
 * @param perPixel 每个像素代表多少场景单位 / scene units per pixel
 */
export function scaleBar(perPixel: number, widthPx: number, unit: Unit = 'Å', share = 0.2): ScaleBar | null {
  if (!(perPixel > 0) || !(widthPx > 0)) return null
  const target = perPixel * widthPx * share * IN_ANGSTROM[unit]
  const label: Unit = target >= 10_000 ? 'µm' : target >= 10 ? 'nm' : 'Å'
  const want = target / IN_ANGSTROM[label]
  const pow = 10 ** Math.floor(Math.log10(want))
  const lead = want / pow
  const nice = (lead >= 5 ? 5 : lead >= 2 ? 2 : 1) * pow
  const angstrom = nice * IN_ANGSTROM[label]
  // 浮点数的尾巴去掉：0.2 不写成 0.20000000000000001 / trim floating-point tails: 0.2, not 0.20000000000000001
  return { px: angstrom / IN_ANGSTROM[unit] / perPixel, label: `${Number(nice.toPrecision(3))} ${label}`, angstrom }
}
