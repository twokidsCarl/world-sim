import type { RGB } from '../style/oklab'

/** 除场景本身之外，关于场景怎么画的一切 / Everything about how a scene is drawn that is not the scene itself. */
export interface Style {
  background: RGB
  ink: RGB
  /**
   * 线取“旁边的填色压暗”的比例：0（缺省）用固定的墨色 `ink`，1 完全用填色的深一号。
   * Goodsell 手绘的线是深紫、深绿这样的同色深线，不是黑线；量他的画，线的彩度在 0.06–0.09。
   * How far a line takes "the fill beside it, darkened": 0 (the default) uses the fixed `ink`,
   * 1 uses a deeper shade of the fill entirely. The lines in Goodsell's paintings are dark violet
   * or dark green, of the fill's own hue, not black; measured, their chroma is 0.06–0.09.
   */
  inkTint?: number
  /** 线压暗到填色的几成（缺省 0.35）/ how dark the line is, as a share of the fill (default 0.35) */
  inkShade?: number
  /**
   * 1 = Illustrate 在 1500 px 图像上的线宽；随输出尺寸缩放
   * 1 = Illustrate's line weight on a 1500 px image; scales with output size
   */
  lineWidth: number
  /** 按深度的描边：计数阈值，以及计入的深度台阶（Å） / depth outlines: count thresholds, and the depth step (Å) that counts */
  contour: { low: number; high: number; diffMin: number; diffMax: number }
  /** 链之间的描边（全景里是分子之间） / outlines between chains (or between molecules in a landscape) */
  subunit: { low: number; high: number }
  /** 序列上相距较远的残基之间的描边；diff 取 6000 即关闭 / outlines between residues far apart in sequence; diff 6000 turns it off */
  residue: { low: number; high: number; diff: number }
  outlineBy: 'chain' | 'molecule'
  shadow: {
    /** 每个遮挡采样减去的光（Illustrate：0.0023）；0 = 关闭 / light removed per shadowing sample (Illustrate: 0.0023); 0 = off */
    strength: number
    /** 越大阴影越收紧（Illustrate：2.0） / larger = tighter shadows (Illustrate: 2.0) */
    cone: number
    /** 阴影最暗能到多少，以本色的比例计 / darkest a shadow can get, as a share of full colour */
    floor: number
    /** 延伸范围（Å）；0 = 按视图大小选取 / reach in Å; 0 = choose from the view size */
    radius: number
  }
  /**
   * 向 `color` 的景深淡出：前端和后端各保留的本色比例。`layers` > 0 时，每个分子整体归入
   * 这么多个平涂色阶之一，如同 Goodsell 的画；0 则平滑淡出。
   * Depth fading towards `color`: the share of true colour kept at the front
   * and at the back. With `layers` > 0 each molecule is assigned whole to one
   * of that many flat steps, as in Goodsell's paintings; 0 fades smoothly.
   *
   * `shade` > 0 时景深不褪向 `color`，而是把本色压暗、加浓，`shade` 是最远处的明暗系数。
   * 量他的流感病毒：前后三层血凝素的明度是 0.76、0.60、0.45，彩度几乎不变。
   * With `shade` > 0 depth does not fade towards `color`: the fill itself is darkened and
   * enriched, `shade` being the factor at the far end. Measured on his influenza virion, three
   * layers of hemagglutinin from front to back have lightness 0.76, 0.60, 0.45 at almost
   * unchanged chroma.
   */
  fog: { color: RGB; front: number; back: number; layers: number; shade?: number }
  /** 纸纹，0 = 关闭 / paper grain, 0 = off */
  grain: number
  radiusScale: number
  /**
   * 球在画面上的最小半径，以笔宽为单位；0 = 不限制。比线还细的东西会被描边吞掉，
   * 所以像 Goodsell 那样把它们略微画粗。
   * Smallest on-screen radius of a sphere, in pen widths; 0 = no limit. Anything thinner than
   * the line is swallowed by its own outline, so, as Goodsell does, it is drawn a little fatter.
   */
  minRadius: number
}

/** Illustrate 的示例设置，其中阴影下限量自他的图 / Illustrate's sample settings, with the shadow floor measured from his pictures. */
export const STYLE_MOLECULE: Style = {
  background: [1, 1, 1],
  ink: [0, 0, 0],
  lineWidth: 1,
  contour: { low: 3, high: 10, diffMin: 0, diffMax: 5 },
  subunit: { low: 3, high: 10 },
  residue: { low: 3, high: 8, diff: 6000 },
  outlineBy: 'chain',
  shadow: { strength: 0.0023, cone: 2, floor: 0.72, radius: 0 },
  fog: { color: [1, 1, 1], front: 1, back: 1, layers: 0 },
  grain: 0,
  radiusScale: 1,
  minRadius: 0,
}

export function cloneStyle(s: Style): Style {
  return structuredClone(s)
}

/**
 * 细胞全景：只在分子之间上墨，一切随深度淡入温暖的暗色，带一点纸纹。
 * 各级明度取自采样的画作（docs/style-guide.md）：最深一层的明度在 0.3 附近。
 * Cellular landscapes: ink only between molecules, everything fading to a
 * warm dark with depth, a little paper grain. Levels follow the sampled
 * paintings (docs/style-guide.md): the deepest layer sits near lightness 0.3.
 */
export const STYLE_LANDSCAPE: Style = {
  background: [0.1, 0.09, 0.085],
  ink: [0.05, 0.045, 0.04],
  lineWidth: 1.2,
  contour: { low: 3, high: 10, diffMin: 0, diffMax: 30 },
  subunit: { low: 3, high: 10 },
  residue: { low: 3, high: 8, diff: 6000 },
  outlineBy: 'molecule',
  shadow: { strength: 0.0018, cone: 2, floor: 0.74, radius: 0 },
  fog: { color: [0.11, 0.095, 0.09], front: 1, back: 0.36, layers: 3 },
  grain: 0.2,
  // 原子画得略胖，让每个分子读成一个光滑的形状，像画里那样，而不是一片疙瘩
  // atoms are drawn a little fat so that each molecule reads as one smooth
  // shape, as in the paintings, instead of a field of bumps
  radiusScale: 1.3,
  minRadius: 2,
}

/**
 * 现成的介观模型（整颗病毒、整个细胞）：画法同全景，但背景留白，景深连续淡出。
 * Ready-made mesoscale models (whole virions, whole cells): drawn like a landscape, but on
 * paper, with depth fading smoothly.
 */
export const STYLE_MESOSCALE: Style = {
  ...structuredClone(STYLE_LANDSCAPE),
  // 略暖的纸白 / a slightly warm paper white
  background: [0.992, 0.988, 0.976],
  // 线是旁边填色的深一号，细一些 / lines are a deeper shade of the fill beside them, and thinner
  inkTint: 1,
  inkShade: 0.3,
  lineWidth: 0.85,
  // 平涂：不要原子之间的阴影，明暗只来自景深的三档 / flat washes: no shadows between atoms, tone comes from the three depth steps alone
  shadow: { strength: 0, cone: 2, floor: 1, radius: 0 },
  fog: { color: [0.16, 0.14, 0.13], front: 1, back: 0, layers: 3, shade: 0.5 },
  grain: 0.07,
}

/**
 * 神经元形态：尺寸以微米计，分支很细，所以保证最小宽度；阴影调轻，免得密集的树突丛发黑。
 * Neuron morphologies: sizes are in microns and branches are thin, so a minimum width is kept;
 * shadows are lighter, so that a dense dendritic arbor does not go dark.
 */
export const STYLE_NEURON: Style = {
  ...structuredClone(STYLE_MOLECULE),
  shadow: { strength: 0.0012, cone: 2, floor: 0.8, radius: 0 },
  // 小于这个宽度的分支会整条被描边盖住 / a branch narrower than this would be covered by its own outline from side to side
  minRadius: 2.8,
  lineWidth: 0.8,
}
