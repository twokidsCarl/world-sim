// 界面是中文的；这里是给外面的 Agent 看的英文名：底座、旋钮、选项、派生量、分析。
// 测试保证每一项都有，漏了会报出是哪一项。
// The UI is in Chinese; these are the English names offered to outside agents:
// substrates, knobs, options, quantities and analyses. A test makes sure nothing is
// missing and names what is.

import type { LevelId } from '../core/quantity'
import type { Tag } from '../core/params'

export const TAG_EN: Record<Tag, string> = {
  class: 'changes the universality class',
  value: 'changes numbers only',
  state: 'state variable',
  numerical: 'numerical method',
  toy: 'toy rule',
}

export const LEVEL_EN: Record<LevelId, string> = {
  micro: 'microscopic',
  kinetic: 'kinetic',
  thermo: 'thermodynamic',
  hydro: 'hydrodynamic',
  structure: 'structure',
  meta: 'meta',
}

export interface SubstrateEnglish {
  label: string
  blurb: string
  step: string
  /** 旋钮 id → [英文名, 各选项的英文名（按 options 的顺序）] / knob id → [name, option names in order] */
  knobs: Record<string, [string, string[]?]>
  quantities: Record<string, string>
  analyses?: Record<string, string>
}

export const ENGLISH: Record<string, SubstrateEnglish> = {
  md: {
    label: 'Molecular dynamics',
    blurb: 'Particles with a pair potential and nothing else; every higher-level quantity is computed from their positions and velocities.',
    step: 'steps',
    knobs: {
      dim: ['Space dimension', ['2D', '3D']],
      kind: ['Form of the potential', ['Mie n–m', 'Morse', 'purely repulsive']],
      n: ['Repulsive exponent n'],
      m: ['Attractive exponent m'],
      a: ['Morse well width a'],
      rc: ['Cutoff radius rc'],
      epsBB: ['B–B attraction strength ε_BB'],
      epsAB: ['A–B attraction strength ε_AB'],
      nonreciprocal: ['Break action–reaction, δ'],
      chain: ['Amphiphiles: beads per molecule', ['unbonded', '2 (head–tail)', '3 (head–tail–tail)', '4']],
      fractionB: ['Fraction of B particles'],
      layoutB: ['Initial layout of B', ['randomly mixed', 'a band in the middle']],
      walls: ['Boundary', ['periodic', 'thermal walls above and below (a channel)']],
      drive: ['Driving force along the channel, g'],
      obstacle: ['Radius of the disc obstacle'],
      gravity: ['Gravity (towards the lower wall)'],
      deltaT: ['How much hotter the lower wall is, ΔT'],
      density: ['Number density ρ'],
      temperature: ['Temperature T'],
      thermostat: ['Thermostat', ['off (isolated system)', 'on (coupled to a bath)']],
      integrator: ['Integrator', ['floating-point Verlet', 'integer coordinates (bit-reversible)']],
      backend: ['Compute backend', ['CPU reference (f64)', 'WebGPU (f32)']],
      nx: ['Particles per row'],
      dt: ['Time step dt'],
    },
    quantities: {
      drift: 'Energy conservation: drift per particle (ε)',
      momentum: 'Momentum conservation: |P| per particle',
      distance: 'Time reversibility: largest displacement from the start (σ)',
      msd: 'Mean squared displacement ⟨Δr²⟩',
      speedDist: 'Speed distribution',
      rdf: 'Radial distribution function g(r)',
      temperature: 'Temperature T',
      pressure: 'Pressure P',
      densityField: 'Density field ρ(x, y) (summed along z in 3D)',
      flowField: 'Streamwise velocity field uₓ(x, y)',
      crossField: 'Cross-stream velocity field u_y(x, y)',
      gkViscosity: 'Green–Kubo: running integral of the viscosity η(τ)',
      vorticity: 'Vorticity field ω = ∂u_y/∂x − ∂uₓ/∂y',
      wakeVelocity: 'Velocity in the lee of the disc (instantaneous, noisy)',
      wakeProbe: 'Cross-stream velocity in a probe region of the wake (instantaneous)',
      meanFlow: 'Mean velocity in the channel',
      convection: 'Convection strength: variation along x of the vertical velocity in the middle layer',
      concentration: 'Concentration profile of B, c(y)',
      flowProfile: 'Velocity profile uₓ(y)',
      viscosity: 'Viscosity η (inferred from the flow rate)',
      temperatureProfile: 'Temperature profile T(y)',
      soundMode: 'Amplitude of the longest density wave, Re ρₖ / N',
      lowK: 'Structure factor at the longest wave (instantaneous, noisy)',
      structureFactor: 'Structure factor S(k)',
      coordination: 'Coordination number (neighbours within 1.35σ)',
      q6Averaged: 'Neighbour-averaged bond-orientational order ⟨q̄₆⟩',
      crystalFraction: 'Fraction of particles in a crystalline environment (q̄₆ > 0.3)',
      psi6Local: 'Local hexatic order ⟨|ψ₆|⟩',
      psi6Global: 'Global hexatic order |⟨ψ₆⟩|',
      demix: 'Degree of demixing',
      freeFraction: 'Fraction of molecules that are alone',
      aggregation: 'Mean aggregation number (weighted by molecule)',
      aggregateSizes: 'Distribution of aggregation numbers',
    },
    analyses: {
      shedding: 'Is the wake periodic: the shedding frequency',
      selfDiffusion: 'Self-diffusion coefficient, from the slope of the mean squared displacement',
      compressibility: 'Long-wave limit: S(k→0) against the compressibility',
      wake: 'Is there backflow behind the disc',
      sound: 'Speed of sound, from the oscillation of the longest density wave',
      sindy: 'Equation discovery: which equation does the concentration obey',
      dmd: 'Dynamic mode decomposition: how fast each mode decays',
    },
  },
  ising: {
    label: 'Ising spins',
    blurb: 'Spins on a lattice flipped at random according to their neighbours; magnetisation, the Binder cumulant and the renormalisation flow are computed from the spins.',
    step: 'sweeps',
    knobs: {
      dim: ['Space dimension', ['2D', '3D']],
      T: ['Temperature T'],
      h: ['External field h'],
      j2: ['Next-nearest-neighbour coupling J₂ / J'],
      L3: ['Lattice side L (3D)', ['32', '64', '128']],
      L: ['Lattice side L', ['64', '128', '256', '512', '1024']],
      backend: ['Compute backend', ['CPU reference', 'WebGPU']],
    },
    quantities: {
      magnetisation: 'Magnetisation |m|',
      energy: 'Energy per spin',
      binder: 'Binder cumulant U₄ = 1 − ⟨m⁴⟩ / 3⟨m²⟩²',
      effectiveInformation: 'Effective information across scales (experimental)',
      rgMagnetisation: 'Renormalisation flow: |m| at each scale',
      rgCorrelation: 'Renormalisation flow: nearest-neighbour correlation at each scale',
    },
  },
  potts: {
    label: 'Potts model',
    blurb: 'Each lattice site takes one of q states and changes at random according to whether its neighbours share its state.',
    step: 'sweeps',
    knobs: {
      q: ['Number of states q'],
      tau: ['Temperature T / Tc(q)'],
      start: ['Initial state', ['random (disordered)', 'all alike (ordered)']],
      L: ['Lattice side L', ['64', '128', '256', '512', '1024']],
      backend: ['Compute backend', ['CPU reference', 'WebGPU']],
    },
    quantities: {
      energy: 'Energy per site',
      order: 'Order parameter m = (q ρ_max − 1) / (q − 1)',
      fractions: 'Share of each state',
      binder: 'Binder cumulant U₄ = 1 − ⟨m⁴⟩ / 3⟨m²⟩²',
      rgOrder: 'Renormalisation flow: order parameter at each scale',
      rgLike: 'Renormalisation flow: share of like neighbours at each scale',
    },
  },
  gravity: {
    label: 'Gravitational N-body',
    blurb: 'Point masses attracting one another by softened Newtonian gravity, summed directly over every pair.',
    step: 'steps',
    knobs: {
      initial: ['Initial state', ['uniform sphere', 'Plummer sphere (in equilibrium)']],
      virial0: ['Initial virial ratio 2K/|U|'],
      n: ['Number of bodies', ['1024', '4096', '8192', '16384']],
      eps: ['Softening length ε'],
      dt: ['Time step dt'],
      backend: ['Compute backend', ['CPU reference (f64)', 'WebGPU (f32)']],
    },
    quantities: {
      drift: 'Energy conservation: relative drift',
      momentum: 'Momentum conservation: total momentum',
      virial: 'Virial ratio of the bound part, 2K / |Σ m x·a|',
      virialAll: '2K / |U| of the whole system',
      boundFraction: 'Fraction of bodies still bound',
      density: 'Radial mass density ρ(r)',
      halfMass: 'Half-mass radius',
    },
  },
  mesh: {
    label: 'Gravitational clustering',
    blurb: 'Cold matter in a periodic box under its own gravity, computed with the particle-mesh method on a static uniform background.',
    step: 'steps',
    knobs: {
      G: ['Gravitational constant G'],
      initial: ['Initial perturbation', ['one plane wave', 'a random field']],
      amplitude: ['Initial amplitude'],
      side: ['Particles per side', ['16 (4096 particles)', '32 (33 thousand)', '64 (260 thousand)']],
      grid: ['Mesh points per side', ['32', '64', '128']],
      dt: ['Time step dt'],
      backend: ['Compute backend', ['CPU reference', 'WebGPU']],
    },
    quantities: {
      momentum: 'Momentum conservation: total momentum',
      drift: 'Energy: relative change ΔE / (K + |W|)',
      mode: 'Amplitude of the fundamental density mode along x',
      sigma: 'Root-mean-square density fluctuation on the mesh, σ',
      peak: 'Peak density / mean density',
    },
  },
}
