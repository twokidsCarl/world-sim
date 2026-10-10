import type { RGB } from '../style/oklab'

/** Everything about how a scene is drawn that is not the scene itself. */
export interface Style {
  background: RGB
  ink: RGB
  /** 1 = Illustrate's line weight on a 1500 px image; scales with output size */
  lineWidth: number
  /** depth outlines: count thresholds, and the depth step (Å) that counts */
  contour: { low: number; high: number; diffMin: number; diffMax: number }
  /** outlines between chains (or between molecules in a landscape) */
  subunit: { low: number; high: number }
  /** outlines between residues far apart in sequence; diff 6000 turns it off */
  residue: { low: number; high: number; diff: number }
  outlineBy: 'chain' | 'molecule'
  shadow: {
    /** light removed per shadowing sample (Illustrate: 0.0023); 0 = off */
    strength: number
    /** larger = tighter shadows (Illustrate: 2.0) */
    cone: number
    /** darkest a shadow can get, as a share of full colour */
    floor: number
    /** reach in Å; 0 = choose from the view size */
    radius: number
  }
  /**
   * Depth fading towards `color`: the share of true colour kept at the front
   * and at the back. With `layers` > 0 each molecule is assigned whole to one
   * of that many flat steps, as in Goodsell's paintings; 0 fades smoothly.
   */
  fog: { color: RGB; front: number; back: number; layers: number }
  /** paper grain, 0 = off */
  grain: number
  radiusScale: number
}

/** Illustrate's sample settings, with the shadow floor measured from his pictures. */
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
}

export function cloneStyle(s: Style): Style {
  return structuredClone(s)
}

/**
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
  // atoms are drawn a little fat so that each molecule reads as one smooth
  // shape, as in the paintings, instead of a field of bumps
  radiusScale: 1.3,
}
