// 二维正方晶格 Ising 模型的严格结果，最近邻耦合 J = 1、零外场
// （Onsager 1944；Yang 1952）。
// Exact results for the 2D square-lattice Ising model with nearest-neighbour coupling
// J = 1 and zero field (Onsager 1944; Yang 1952).

export const ISING_TC = 2 / Math.log(1 + Math.SQRT2)

/**
 * 每个自旋的自发磁化强度；在 Tc 及以上为零。
 * Spontaneous magnetisation per spin; zero at and above Tc.
 */
export function onsagerMagnetisation(T: number): number {
  if (T >= ISING_TC) return 0
  return Math.pow(1 - Math.pow(Math.sinh(2 / T), -4), 1 / 8)
}

/**
 * 用算术–几何平均计算第一类完全椭圆积分 K(k)。
 * Complete elliptic integral of the first kind K(k), by the arithmetic–geometric mean.
 */
export function ellipticK(k: number): number {
  let a = 1
  let b = Math.sqrt(1 - k * k)
  for (let i = 0; i < 40 && Math.abs(a - b) > 1e-15 * a; i++) {
    const t = 0.5 * (a + b)
    b = Math.sqrt(a * b)
    a = t
  }
  return Math.PI / (2 * a)
}

/** 每个自旋的内能。 / Internal energy per spin. */
export function onsagerEnergy(T: number): number {
  const b = 1 / T
  const kappa = (2 * Math.sinh(2 * b)) / Math.pow(Math.cosh(2 * b), 2)
  const t2 = Math.pow(Math.tanh(2 * b), 2)
  // 在 Tc 处括号中的第二项为零，而 K 对数发散；二者的乘积为 0。
  // At Tc the bracket's second term vanishes while K diverges logarithmically; the product is 0.
  const second = Math.abs(2 * t2 - 1) < 1e-12 ? 0 : (2 / Math.PI) * (2 * t2 - 1) * ellipticK(Math.min(kappa, 1 - 1e-15))
  return (-1 / Math.tanh(2 * b)) * (1 + second)
}

/**
 * 大晶格极限下临界点处的 Binder 累积量，适用于各向同性、最近邻、周期边界的
 * 正方晶格：0.61069…，引自 W. Selke, Eur. Phys. J. B 51, 223 (2006),
 * arXiv:cond-mat/0603411。它对所有晶格尺寸都相同，所以不同尺寸的曲线在此处相交；
 * 但它依赖于边界条件和耦合的各向异性，因此并不是整个二维 Ising 普适类共有的
 * 一个数。
 * Binder cumulant at the critical point in the limit of large lattices, for the isotropic
 * nearest-neighbour square lattice with periodic boundaries: 0.61069…, as quoted by
 * W. Selke, Eur. Phys. J. B 51, 223 (2006), arXiv:cond-mat/0603411. It is the same for
 * every lattice size, which is why curves for different sizes cross there, but it depends
 * on the boundary conditions and on the anisotropy of the couplings, so it is not one
 * number for the whole 2D Ising universality class.
 */
export const BINDER_CRITICAL = 0.61069
