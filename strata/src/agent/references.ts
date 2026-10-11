// 理论参照：模拟结果拿来对照的那些数。数值都由 src/theory 里的函数现算，
// 不在这里另抄一份；每条写明它是严格结果、拟合还是数值结果，出处是什么，
// 以及这个项目自己量到了多少（有记录的才写）。
// Reference values: the numbers the simulations are compared with. Every value is computed
// from the functions in src/theory, not copied here; each record says whether it is exact,
// a fit or a numerical result, where it comes from, and what this project itself measured
// (only where that is on record).

import { BINDER3D_CRITICAL, ISING3D_TC } from '../substrates/ising/ref3d'
import { JEANS_RATE } from '../theory/jeans'
import { LJ2D_RHOC, LJ2D_TC } from '../theory/ljEos'
import { BINDER_CRITICAL, ISING_TC, onsagerEnergy, onsagerMagnetisation } from '../theory/onsager'
import { FREE_FALL_TIME, PLUMMER_HALF_MASS } from '../theory/plummer'
import { pottsCoexistence, pottsCriticalEnergy, pottsLatentHeat, pottsTc } from '../theory/potts'
import { unitSystem } from '../theory/scaling'

export interface Bilingual {
  zh: string
  en: string
}

export interface Reference {
  id: string
  substrate: string
  title: Bilingual
  /** 没有单个数值（只有表）时为 null。 / null where there is a table and no single number. */
  value: number | null
  formula: string
  /** exact 严格；fit 拟合；numerical 数值结果；reference 理想结构的参照值。 / How the value is known. */
  status: 'exact' | 'fit' | 'numerical' | 'reference'
  source: string
  /** 这个项目的测试或实验量到的结果；没有记录就不写。 / What this project measured, where recorded. */
  measured?: Bilingual
  table?: { columns: string[]; rows: number[][] }
}

// 四舍五入到十位有效数字，免得不同机器的末位不同。
// Round to ten significant digits so the last bits cannot differ between machines.
const r = (v: number) => Number(v.toPrecision(10))

export function references(): Reference[] {
  const out: Reference[] = [
    {
      id: 'ising2d-tc',
      substrate: 'ising',
      title: { zh: '二维 Ising 模型的临界温度', en: 'Critical temperature of the 2D Ising model' },
      value: r(ISING_TC),
      formula: 'Tc = 2 / ln(1 + √2), J = 1, h = 0, square lattice, nearest neighbours',
      status: 'exact',
      source: 'Onsager, Phys. Rev. 65, 117 (1944)',
      measured: {
        zh: '慢测试里不同大小晶格的 Binder 曲线在这个温度相交。',
        en: 'In the slow tests the Binder curves of lattices of different sizes cross at this temperature.',
      },
    },
    {
      id: 'ising2d-magnetisation',
      substrate: 'ising',
      title: { zh: '二维 Ising 模型的自发磁化强度', en: 'Spontaneous magnetisation of the 2D Ising model' },
      value: null,
      formula: 'm(T) = (1 − sinh(2/T)⁻⁴)^(1/8) for T < Tc, 0 otherwise',
      status: 'exact',
      source: 'Yang, Phys. Rev. 85, 808 (1952)',
      table: { columns: ['T', 'm'], rows: [1, 1.5, 1.8, 2, 2.1, 2.2, 2.25, 2.26].map((T) => [T, r(onsagerMagnetisation(T))]) },
    },
    {
      id: 'ising2d-energy',
      substrate: 'ising',
      title: { zh: '二维 Ising 模型每个自旋的能量', en: 'Energy per spin of the 2D Ising model' },
      value: r(onsagerEnergy(ISING_TC)),
      formula: 'u(T) = −coth(2/T) [1 + (2/π)(2 tanh²(2/T) − 1) K(κ)], κ = 2 sinh(2/T) / cosh²(2/T); the value given is u(Tc) = −√2',
      status: 'exact',
      source: 'Onsager, Phys. Rev. 65, 117 (1944)',
      table: { columns: ['T', 'u'], rows: [1, 1.5, 2, 2.2, 2.5, 3, 4].map((T) => [T, r(onsagerEnergy(T))]) },
    },
    {
      id: 'ising2d-beta-over-nu',
      substrate: 'ising',
      title: { zh: '二维 Ising：临界点磁化强度随晶格边长衰减的指数', en: '2D Ising: exponent of the decay of the critical magnetisation with lattice side' },
      value: 0.125,
      formula: '|m|(Tc, L) ∝ L^(−β/ν), β = 1/8, ν = 1',
      status: 'exact',
      source: 'Onsager (1944); Yang (1952)',
    },
    {
      id: 'ising2d-binder',
      substrate: 'ising',
      title: { zh: '二维 Ising：临界点的 Binder 累积量', en: '2D Ising: Binder cumulant at the critical point' },
      value: BINDER_CRITICAL,
      formula: 'U₄ = 1 − ⟨m⁴⟩ / 3⟨m²⟩²; isotropic nearest-neighbour square lattice, periodic boundaries, large-lattice limit',
      status: 'numerical',
      source: 'Selke, Eur. Phys. J. B 51, 223 (2006), arXiv:cond-mat/0603411',
    },
    {
      id: 'ising3d-tc',
      substrate: 'ising',
      title: { zh: '三维 Ising 模型的临界温度', en: 'Critical temperature of the 3D Ising model' },
      value: r(ISING3D_TC),
      formula: 'Tc = 1 / β_c, β_c = 0.221654(2); simple cubic lattice, no exact solution',
      status: 'numerical',
      source: 'numerical literature value; the code records the number but no citation',
      measured: {
        zh: '慢测试里小晶格（8 到 32）的 Binder 曲线交于 4.504。',
        en: 'In the slow tests the Binder curves of small lattices (8 to 32) cross at 4.504.',
      },
    },
    {
      id: 'ising3d-beta-over-nu',
      substrate: 'ising',
      title: { zh: '三维 Ising：临界点磁化强度随晶格边长衰减的指数', en: '3D Ising: exponent of the decay of the critical magnetisation with lattice side' },
      value: 0.518,
      formula: '|m|(Tc, L) ∝ L^(−β/ν)',
      status: 'numerical',
      source: 'numerical literature value; the code records the number but no citation',
      measured: { zh: '慢测试量到 0.510。', en: 'The slow tests measure 0.510.' },
    },
    {
      id: 'ising3d-binder',
      substrate: 'ising',
      title: { zh: '三维 Ising：临界点的 Binder 累积量', en: '3D Ising: Binder cumulant at the critical point' },
      value: BINDER3D_CRITICAL,
      formula: 'U₄ at Tc for a periodic cube, large-lattice limit; quoted as 0.465(3)',
      status: 'numerical',
      source: 'numerical literature value; the code records the number but no citation',
      measured: {
        zh: '小晶格（8 到 32）的交点处是 0.490，比大晶格值高，是有限尺寸修正。',
        en: 'At the crossing of small lattices (8 to 32) it is 0.490, above the large-lattice value: a finite-size correction.',
      },
    },
    {
      id: 'potts-q3-beta-over-nu',
      substrate: 'potts',
      title: { zh: '三态 Potts：临界点序参量随晶格边长衰减的指数', en: 'Three-state Potts: exponent of the decay of the critical order parameter with lattice side' },
      value: r(2 / 15),
      formula: 'm(Tc, L) ∝ L^(−β/ν), β = 1/9, ν = 5/6',
      status: 'exact',
      source: 'standard value, written from memory and not checked against a source; see Wu, Rev. Mod. Phys. 54, 235 (1982)',
      measured: { zh: '慢测试量到的指数与它相差不到 0.015。', en: 'The slow tests measure an exponent within 0.015 of it.' },
    },
    {
      id: 'jeans-rate',
      substrate: 'mesh',
      title: { zh: '冷物质引力不稳定性的线性增长率', en: 'Linear growth rate of the gravitational instability of cold matter' },
      value: r(JEANS_RATE),
      formula: 'γ = √(4πGρ̄) with G = 1 and mean density 1 on a static uniform background; independent of wavelength',
      status: 'exact',
      source: 'Jeans, Phil. Trans. R. Soc. A 199, 1 (1902)',
      measured: {
        zh: '平面波实测 3.527；计入粒子网格法的已知折扣后理论是 3.522。',
        en: 'Measured 3.527 for a plane wave; with the known weakening of the particle-mesh force the prediction is 3.522.',
      },
    },
    {
      id: 'zeldovich-mode',
      substrate: 'mesh',
      title: { zh: '平面波在壳层交叉之前的严格解', en: 'Exact solution for a plane wave before shell crossing' },
      value: null,
      formula: 'x = q + A(t) sin(2πkq) / (2πk), A(t) = A₀ exp(γt); fundamental density mode 2 J₁(A); shells cross at A = 1, t = ln(1/A₀) / γ',
      status: 'exact',
      source: "Zel'dovich, Astron. Astrophys. 5, 84 (1970)",
      measured: {
        zh: '到壳层交叉时刻的九成为止，实测与它相差不超过 1.1%。',
        en: 'Up to nine tenths of the crossing time the measurement stays within 1.1% of it.',
      },
    },
    {
      id: 'plummer-half-mass',
      substrate: 'gravity',
      title: { zh: 'Plummer 球的半质量半径', en: 'Half-mass radius of the Plummer sphere' },
      value: r(PLUMMER_HALF_MASS),
      formula: 'r_h = (2^(2/3) − 1)^(−1/2), total mass 1, scale radius 1, G = 1',
      status: 'exact',
      source: 'Plummer, Mon. Not. R. Astron. Soc. 71, 460 (1911)',
    },
    {
      id: 'free-fall-time',
      substrate: 'gravity',
      title: { zh: '冷均匀球的自由落体时间', en: 'Free-fall time of a cold uniform sphere' },
      value: r(FREE_FALL_TIME),
      formula: 't_ff = π / (2√2), mass 1, radius 1, G = 1',
      status: 'exact',
      source: 'textbook result',
    },
    {
      id: 'virial-equilibrium',
      substrate: 'gravity',
      title: { zh: '自引力系统平衡时的位力比', en: 'Virial ratio of a self-gravitating system in equilibrium' },
      value: 1,
      formula: '2K / |U| = 1',
      status: 'exact',
      source: 'virial theorem (Clausius 1870)',
    },
    {
      id: 'lj2d-critical-point',
      substrate: 'md',
      title: { zh: '二维 Lennard-Jones 流体的临界点', en: 'Critical point of the 2D Lennard-Jones fluid' },
      value: LJ2D_TC,
      formula: `Tc = ${LJ2D_TC}, ρc = ${LJ2D_RHOC} (full 12-6 potential; the critical parameters used by the equation-of-state fit)`,
      status: 'fit',
      source: 'Homes, Mausbach, Thol, Nitzke & Vrabec, J. Mol. Liq. 429, 127529 (2025), https://doi.org/10.14279/depositonce-22253',
    },
    {
      id: 'q6-ideal-structures',
      substrate: 'md',
      title: { zh: '理想结构的 Steinhardt q₆', en: 'Steinhardt q₆ of ideal structures' },
      value: 0.5745,
      formula: 'q₆ = √(4π/13 · Σₘ |q₆ₘ|²); the value given is face-centred cubic',
      status: 'reference',
      source: 'Steinhardt, Nelson & Ronchetti, Phys. Rev. B 28, 784 (1983)',
      measured: {
        zh: '测试里由理想晶格算出：面心立方 0.5745，六方密堆 0.4848，二十面体 0.6633；这三个是代码里断言的值。',
        en: 'Computed from ideal lattices in the tests: face-centred cubic 0.5745, hexagonal close-packed 0.4848, icosahedron 0.6633; these three are the values asserted in the code.',
      },
    },
    {
      id: 'close-packed-coordination',
      substrate: 'md',
      title: { zh: '密堆积晶体的配位数', en: 'Coordination number of close-packed crystals' },
      value: 6,
      formula: '6 for the 2D triangular lattice, 12 for face-centred cubic in 3D',
      status: 'reference',
      source: 'geometry',
    },
    {
      id: 'ideal-gas-sound',
      substrate: 'md',
      title: { zh: '理想气体的声速', en: 'Speed of sound of an ideal gas' },
      value: null,
      formula: 'c = √(γT), γ = (d + 2) / d, unit mass; with interactions the simulation uses the virial equation of state truncated at B₂, valid at low density only',
      status: 'exact',
      source: 'textbook result',
    },
    {
      id: 'maxwell-speed-distribution',
      substrate: 'md',
      title: { zh: 'Maxwell–Boltzmann 速率分布', en: 'Maxwell–Boltzmann speed distribution' },
      value: null,
      formula: '2D: f(v) = (v/T) exp(−v²/2T); 3D: f(v) = √(2/π) v² T^(−3/2) exp(−v²/2T); unit mass',
      status: 'exact',
      source: 'Maxwell (1860); Boltzmann (1872)',
    },
    {
      id: 'poiseuille-profile',
      substrate: 'md',
      title: { zh: '管道流的流速剖面', en: 'Velocity profile of channel flow' },
      value: null,
      formula: 'uₓ(y) = (ρg / 2η) y (H − y) plus a slip velocity at the walls, for a body force g per particle',
      status: 'exact',
      source: 'Navier–Stokes equations, plane Poiseuille flow',
      measured: {
        zh: '二维和三维的流速剖面都与抛物线吻合；粘度是由流量反推的，三维约 1.07，没有独立对照。',
        en: 'The profile matches a parabola in 2D and in 3D; the viscosity is inferred from the flow rate (about 1.07 in 3D) and has no independent check.',
      },
    },
  ]

  for (let q = 2; q <= 8; q++) {
    const { ordered, disordered } = pottsCoexistence(q)
    out.push({
      id: `potts-q${q}`,
      substrate: 'potts',
      title: { zh: `${q} 态 Potts 模型的相变点`, en: `Transition point of the ${q}-state Potts model` },
      value: r(pottsTc(q)),
      formula: 'Tc = 1 / ln(1 + √q); mean energy per site at Tc is −(1 + 1/√q); for q > 4 the latent heat is 2 (1 + 1/√q) tanh(Θ/2) Π tanh²(nΘ), 2 cosh Θ = √q',
      status: 'exact',
      source: 'Baxter, J. Phys. C 6, L445 (1973); Wu, Rev. Mod. Phys. 54, 235 (1982)',
      table: {
        columns: ['q', 'Tc', 'energy_at_Tc', 'latent_heat', 'energy_ordered', 'energy_disordered'],
        rows: [[q, r(pottsTc(q)), r(pottsCriticalEnergy(q)), r(pottsLatentHeat(q)), r(ordered), r(disordered)]],
      },
      ...(q === 8
        ? {
            measured: {
              zh: '在相变点上从有序和无序出发，能量分别停在 −1.598 和 −1.106。',
              en: 'Started ordered and disordered at the transition, the energy stays at −1.598 and −1.106 respectively.',
            },
          }
        : {}),
    })
  }

  const argon = unitSystem()
  out.push({
    id: 'argon-units',
    substrate: 'md',
    title: { zh: '约化单位换成氩的实际单位', en: 'Reduced units converted to real units for argon' },
    value: null,
    formula: 'σ, ε/kB and the mass are those of argon; time unit τ = σ √(m/ε); de Boer parameter h / (σ √(mε))',
    status: 'fit',
    source: 'argon Lennard-Jones parameters σ = 3.405 Å, ε/kB = 119.8 K; CODATA 2018 constants',
    table: {
      columns: ['sigma_m', 'epsilon_J', 'mass_kg', 'tau_s', 'kelvin', 'speed_m_per_s', 'de_boer'],
      rows: [[argon.sigma, argon.epsilon, argon.mass, argon.tau, argon.kelvin, argon.speed, argon.deBoer].map(r)],
    },
  })
  return out
}
