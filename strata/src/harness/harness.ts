// GPU-vs-CPU cross-check. Runs each GPU kernel against the f64 reference on the same
// input and reports the discrepancy. Open /?harness; results land in window.__strataHarness.

import { defaults, type Params } from '../core/params'
import { getGpu } from '../gpu/device'
import { IsingCpuBackend, IsingGpuBackend } from '../substrates/ising/backend'
import { ISING_KNOBS } from '../substrates/ising/schema'
import { MdGpuBackend } from '../substrates/md/backend-gpu'
import { buildTable, speciesField, speciesTables, tablePair } from '../substrates/md/potential'
import { initTriangular } from '../substrates/md/ref/init'
import { rdf, scalars, speedHistogram } from '../substrates/md/ref/reducers'
import { computeForces, step } from '../substrates/md/ref/step'
import { MD_KNOBS, potentialSpec, strengthMatrix } from '../substrates/md/schema'

export interface HarnessRow {
  name: string
  value: number
  /** Upper bound for a pass; null for informational rows. */
  limit: number | null
  pass: boolean
}

export interface HarnessResult {
  done: boolean
  pass: boolean
  error?: string
  rows: HarnessRow[]
}

function l1(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let diff = 0
  let total = 0
  for (let i = 0; i < a.length; i++) {
    diff += Math.abs(a[i]! - b[i]!)
    total += Math.abs(b[i]!)
  }
  return diff / total
}

export async function runHarness(): Promise<HarnessResult> {
  const rows: HarnessRow[] = []
  const check = (name: string, value: number, limit: number | null) =>
    rows.push({ name, value, limit, pass: limit === null || (Number.isFinite(value) && value <= limit) })
  const result: HarnessResult = { done: false, pass: false, rows }
  ;(globalThis as { __strataHarness?: HarnessResult }).__strataHarness = result

  const gpu = await getGpu()
  if (!gpu) {
    result.error = 'WebGPU is not available'
    result.done = true
    return result
  }
  gpu.device.pushErrorScope('validation')

  const p: Params = { ...defaults(MD_KNOBS), nx: 40, density: 0.6, temperature: 1 }
  const pair = tablePair(buildTable(potentialSpec(p)))

  // A disordered reference state, with positions and velocities rounded to f32 so both
  // sides start from bit-identical input.
  const ref = initTriangular({ nx: p.nx, density: p.density, temperature: p.temperature, seed: 1 }, pair)
  step(ref, pair, p.dt, 400)
  for (let k = 0; k < ref.pos.length; k++) {
    ref.pos[k] = Math.fround(ref.pos[k]!)
    ref.vel[k] = Math.fround(ref.vel[k]!)
  }
  computeForces(ref, pair)

  const gpuBackend = new MdGpuBackend(gpu, p, 1)
  gpuBackend.writeState(ref.pos, ref.vel)
  const state = await gpuBackend.readState()

  let fmax = 0
  let ferr = 0
  for (let i = 0; i < ref.n; i++) {
    for (let d = 0; d < 2; d++) {
      fmax = Math.max(fmax, Math.abs(ref.force[2 * i + d]!))
      ferr = Math.max(ferr, Math.abs(ref.force[2 * i + d]! - state.force[4 * i + d]!))
    }
  }
  check('受力：最大误差 / 最大受力', ferr / fmax, 1e-4)

  const frame = await gpuBackend.reduce(['scalars', 'speedHist', 'rdf'])
  const sc = scalars(ref)
  const g = frame.scalars!
  check('动能相对误差', Math.abs(g.ke - sc.ke) / sc.ke, 1e-5)
  check('势能相对误差', Math.abs(g.pe - sc.pe) / Math.abs(sc.pe), 1e-4)
  check('压强相对误差', Math.abs(g.pressure - sc.pressure) / Math.abs(sc.pressure), 1e-3)
  check('每粒子动量', g.momentum, 1e-5)
  check('局域六角序 ⟨|ψ₆|⟩ 差', Math.abs(g.psi6Local - sc.psi6Local), 1e-4)
  check('全局六角序 |⟨ψ₆⟩| 差', Math.abs(g.psi6Global - sc.psi6Global), 1e-4)
  check('速率直方图 L1 差', l1(frame.speedHist!.y, speedHistogram(ref, 64, 4 * Math.sqrt(p.temperature)).y), 1e-3)
  const rdfMax = frame.rdf!.x[119]! + frame.rdf!.x[0]!
  check('g(r) 直方图 L1 差', l1(frame.rdf!.y, rdf(ref, 120, rdfMax).y), 1e-3)
  check('邻居表溢出', frame.overflow ? 1 : 0, 0)

  // Short trajectories stay close: one time unit is too brief for chaos to amplify f32 rounding.
  gpuBackend.step(200)
  step(ref, pair, p.dt, 200)
  const after = (await gpuBackend.reduce(['scalars'])).scalars!
  const refAfter = scalars(ref)
  check('200 步后温度差', Math.abs(after.temperature - refAfter.temperature), 1e-3)
  check('200 步后每粒子势能差', Math.abs(after.pe - refAfter.pe) / ref.n, 1e-3)

  for (let i = 0; i < 25; i++) {
    gpuBackend.step(8)
    await gpuBackend.idle()
  }
  check('GPU 2000 步每粒子能量漂移（ε）', Math.abs((await gpuBackend.reduce([])).drift), 1e-3)
  gpuBackend.dispose()

  // Throughput at about 1e5 particles; informational.
  const big = new MdGpuBackend(gpu, { ...p, nx: 296 }, 1)
  await big.reduce([]) // sets the baseline the drift is measured from
  const steps = 2000
  const t0 = performance.now()
  for (let i = 0; i < steps / 8; i++) {
    big.step(8)
    await big.idle()
  }
  const ms = (performance.now() - t0) / steps
  const bigFrame = await big.reduce(['scalars', 'rdf'])
  check(`${big.n} 粒子：每步毫秒`, ms, null)
  check(`${big.n} 粒子：邻居表溢出`, bigFrame.overflow ? 1 : 0, 0)
  check(`${big.n} 粒子：2000 步每粒子能量漂移（ε）`, Math.abs(bigFrame.drift), 1e-3)
  big.dispose()

  // A two-species mixture with a non-reciprocal matrix exercises every per-pair table.
  const mp: Params = { ...p, fractionB: 0.4, epsAB: 0.5, epsBB: 1.4, nonreciprocal: 0.3 }
  const field = speciesField(speciesTables(potentialSpec(mp), strengthMatrix(mp)))
  const mixRef = initTriangular({ nx: mp.nx!, density: mp.density!, temperature: 1, seed: 2, fractionB: 0.4 }, field)
  step(mixRef, field, mp.dt!, 300)
  for (let k = 0; k < mixRef.pos.length; k++) {
    mixRef.pos[k] = Math.fround(mixRef.pos[k]!)
    mixRef.vel[k] = Math.fround(mixRef.vel[k]!)
  }
  computeForces(mixRef, field)
  const mixGpu = new MdGpuBackend(gpu, mp, 2)
  mixGpu.writeState(mixRef.pos, mixRef.vel, mixRef.species)
  const mixState = await mixGpu.readState()
  let mixMax = 0
  let mixErr = 0
  for (let i = 0; i < mixRef.n; i++) {
    for (let d = 0; d < 2; d++) {
      mixMax = Math.max(mixMax, Math.abs(mixRef.force[2 * i + d]!))
      mixErr = Math.max(mixErr, Math.abs(mixRef.force[2 * i + d]! - mixState.force[4 * i + d]!))
    }
  }
  check('两种粒子、非互易：受力最大误差 / 最大受力', mixErr / mixMax, 1e-4)
  const mixFrame = (await mixGpu.reduce(['scalars'])).scalars!
  check('两种粒子：分相程度差', Math.abs(mixFrame.demix - scalars(mixRef).demix), 1e-6)
  mixGpu.dispose()

  // Ising: every flip decision is integer arithmetic, so the lattices must agree exactly.
  const ip: Params = { ...defaults(ISING_KNOBS), L: 7, T: 2.3, j2: 0.2, h: 0.05 }
  const isingCpu = new IsingCpuBackend(ip, 3)
  const isingGpu = new IsingGpuBackend(gpu, ip, 3)
  for (let i = 0; i < 5; i++) {
    isingCpu.step(8)
    isingGpu.step(8)
    await isingGpu.idle()
  }
  const gpuSpins = await isingGpu.readSpins()
  let mismatched = 0
  for (let i = 0; i < gpuSpins.length; i++) mismatched += gpuSpins[i] === isingCpu.state.spins[i] ? 0 : 1
  check('Ising 40 次扫描后不一致的自旋数', mismatched, 0)
  const cpuLevels = isingCpu.reduce().levels
  const gpuLevels = (await isingGpu.reduce()).levels
  let levelDiff = 0
  cpuLevels.forEach((l, k) => {
    const g = gpuLevels[k]!
    levelDiff += Math.abs(l.m - g.m) + Math.abs(l.nn - g.nn) + Math.abs(l.nnn - g.nnn)
  })
  check(`Ising ${cpuLevels.length} 层金字塔统计量差`, levelDiff, 0)
  isingGpu.dispose()

  const error = await gpu.device.popErrorScope()
  if (error) result.error = error.message
  result.pass = !error && rows.every((r) => r.pass)
  result.done = true
  return result
}

export function renderHarness(root: HTMLElement, r: HarnessResult): void {
  const cell = (text: string) => `<td style="padding:2px 16px 2px 0">${text}</td>`
  root.innerHTML =
    `<div style="padding:16px"><h1 style="font-size:18px">GPU 与 CPU 交叉校验：${r.pass ? '通过' : '未通过'}</h1>` +
    (r.error ? `<p>${r.error}</p>` : '') +
    '<table>' +
    r.rows
      .map(
        (row) =>
          `<tr>${cell(row.name)}${cell(row.value.toExponential(3))}${cell(row.limit === null ? '（仅记录）' : `≤ ${row.limit}`)}${cell(row.pass ? '通过' : '未通过')}</tr>`,
      )
      .join('') +
    '</table></div>'
}
