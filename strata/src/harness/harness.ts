// GPU 与 CPU 的交叉校验。对同一输入，把每个 GPU 内核与 f64 参考实现对比运行，
// 并报告两者的偏差。打开 /?harness；结果写入 window.__strataHarness。
// GPU-vs-CPU cross-check. Runs each GPU kernel against the f64 reference on the same
// input and reports the discrepancy. Open /?harness; results land in window.__strataHarness.

import { defaults, type Params } from '../core/params'
import { getGpu } from '../gpu/device'
import { GravityGpuBackend } from '../substrates/gravity/backend'
import { gravityScalars, leapfrog, uniformSphere } from '../substrates/gravity/ref'
import { GRAVITY_KNOBS } from '../substrates/gravity/schema'
import { IsingCpuBackend, IsingGpuBackend } from '../substrates/ising/backend'
import { Ising3dCpuBackend, Ising3dGpuBackend } from '../substrates/ising/backend3d'
import { ISING_KNOBS } from '../substrates/ising/schema'
import { MdGpuBackend } from '../substrates/md/backend-gpu'
import { MeshGpuBackend } from '../substrates/mesh/backend'
import { initMesh, meshScalars, step as meshStep } from '../substrates/mesh/ref'
import { MESH_KNOBS } from '../substrates/mesh/schema'
import { PottsCpuBackend, PottsGpuBackend } from '../substrates/potts/backend'
import { POTTS_KNOBS } from '../substrates/potts/schema'
import { buildTable, speciesField, speciesTables, tablePair } from '../substrates/md/potential'
import { initFcc, initTriangular } from '../substrates/md/ref/init'
import { densityModes, q6Summary, rdf, regionFrame, scalars, speedHistogram } from '../substrates/md/ref/reducers'
import { computeForces, step } from '../substrates/md/ref/step'
import { MD_KNOBS, fccCells, potentialSpec, strengthMatrix } from '../substrates/md/schema'

export interface HarnessRow {
  name: string
  value: number
  /**
   * 通过判定的上限；仅供参考的行为 null。
   * Upper bound for a pass; null for informational rows.
   */
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

  // 一个无序的参考状态，位置和速度都舍入到 f32，使两边从逐位相同的输入出发。
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

  const frame = await gpuBackend.reduce(['scalars', 'speedHist', 'rdf', 'modes'])
  const sc = scalars(ref)
  const g = frame.scalars!
  check('动能相对误差', Math.abs(g.ke - sc.ke) / sc.ke, 1e-5)
  check('势能相对误差', Math.abs(g.pe - sc.pe) / Math.abs(sc.pe), 1e-4)
  check('压强相对误差', Math.abs(g.pressure - sc.pressure) / Math.abs(sc.pressure), 1e-3)
  check('每粒子动量', g.momentum, 1e-5)
  check('局域六角序 ⟨|ψ₆|⟩ 差', Math.abs(g.psi6Local - sc.psi6Local), 1e-4)
  check('全局六角序 |⟨ψ₆⟩| 差', Math.abs(g.psi6Global - sc.psi6Global), 1e-4)
  check('配位数差', Math.abs(g.coordination - sc.coordination), 1e-6)
  check('速率直方图 L1 差', l1(frame.speedHist!.y, speedHistogram(ref, 64, 4 * Math.sqrt(p.temperature)).y), 1e-3)
  const rdfMax = frame.rdf!.x[119]! + frame.rdf!.x[0]!
  check('g(r) 直方图 L1 差', l1(frame.rdf!.y, rdf(ref, 120, rdfMax).y), 1e-3)
  check('邻居表溢出', frame.overflow ? 1 : 0, 0)
  const refModes = densityModes(ref).data
  let modeErr = 0
  for (let k = 0; k < refModes.length; k++) modeErr = Math.max(modeErr, Math.abs(frame.modes!.data[k]! - refModes[k]!))
  check('密度傅里叶模：最大误差 / 粒子数', modeErr / ref.n, 1e-5)

  // 选区统计：GPU 对 CPU，取盒子左下四分之一。
  // Region statistics, GPU against CPU, on the lower-left quarter of the box.
  const quarter: [number, number, number, number] = [0, 0, ref.box[0]! / 2, ref.box[1]! / 2]
  const regionGpu = (await gpuBackend.reduce(['scalars', 'speedHist', 'rdf'], quarter)).region!
  const regionRef = regionFrame(ref, quarter, ['rdf'], 4)
  check('选区：粒子数差', Math.abs(regionGpu.n - regionRef.n), 0)
  check('选区：温度相对误差', Math.abs(regionGpu.temperature / regionRef.temperature - 1), 1e-5)
  check('选区：局域六角序差', Math.abs(regionGpu.psi6Local - regionRef.psi6Local), 1e-5)
  check('选区：配位数差', Math.abs(regionGpu.coordination - regionRef.coordination), 1e-6)
  check('选区：g(r) L1 差', l1(regionGpu.rdf!.y, regionRef.rdf!.y), 1e-3)

  // 短轨迹保持接近：一个时间单位太短，混沌来不及放大 f32 的舍入误差。
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

  // 约 1e5 个粒子时的吞吐量；仅供参考。 / Throughput at about 1e5 particles; informational.
  const big = new MdGpuBackend(gpu, { ...p, nx: 296 }, 1)
  await big.reduce([]) // 设定漂移量的测量基准 / sets the baseline the drift is measured from
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

  // 三维：同样的内核，多一个 z 轴。 / Three dimensions: the same kernels with a z axis.
  const p3: Params = { ...p, dim: 3, nx: 32, density: 0.8, temperature: 1.5 }
  const ref3 = initFcc({ cells: fccCells(p3.nx!), density: 0.8, temperature: 1.5, seed: 1 }, pair)
  step(ref3, pair, p3.dt!, 300)
  for (let k = 0; k < ref3.pos.length; k++) {
    ref3.pos[k] = Math.fround(ref3.pos[k]!)
    ref3.vel[k] = Math.fround(ref3.vel[k]!)
  }
  computeForces(ref3, pair)
  const gpu3 = new MdGpuBackend(gpu, p3, 1)
  gpu3.writeState(ref3.pos, ref3.vel)
  const state3 = await gpu3.readState()
  let fmax3 = 0
  let ferr3 = 0
  for (let i = 0; i < ref3.n; i++) {
    for (let d = 0; d < 3; d++) {
      fmax3 = Math.max(fmax3, Math.abs(ref3.force[3 * i + d]!))
      ferr3 = Math.max(ferr3, Math.abs(ref3.force[3 * i + d]! - state3.force[4 * i + d]!))
    }
  }
  check('三维：受力最大误差 / 最大受力', ferr3 / fmax3, 1e-4)
  const frame3 = await gpu3.reduce(['scalars', 'rdf', 'speedHist', 'q6'])
  const sc3 = scalars(ref3)
  check('三维：动能相对误差', Math.abs(frame3.scalars!.ke - sc3.ke) / sc3.ke, 1e-5)
  check('三维：势能相对误差', Math.abs(frame3.scalars!.pe - sc3.pe) / Math.abs(sc3.pe), 1e-4)
  check('三维：压强相对误差', Math.abs(frame3.scalars!.pressure - sc3.pressure) / Math.abs(sc3.pressure), 1e-3)
  check('三维：配位数差', Math.abs(frame3.scalars!.coordination - sc3.coordination), 1e-6)
  const q3 = q6Summary(ref3)
  check('三维：平均 q₆ 差', Math.abs(frame3.q6!.local - q3.local), 1e-5)
  check('三维：平均 q̄₆ 差', Math.abs(frame3.q6!.averaged - q3.averaged), 1e-5)
  check('三维：晶体比例差', Math.abs(frame3.q6!.crystalFraction - q3.crystalFraction), 1e-3)
  const rdfMax3 = frame3.rdf!.x[119]! + frame3.rdf!.x[0]!
  check('三维：g(r) 直方图 L1 差', l1(frame3.rdf!.y, rdf(ref3, 120, rdfMax3).y), 1e-3)
  check('三维：速率直方图 L1 差', l1(frame3.speedHist!.y, speedHistogram(ref3, 64, 4 * Math.sqrt(1.5)).y), 1e-3)
  check('三维：邻居表溢出', frame3.overflow ? 1 : 0, 0)
  gpu3.step(200)
  step(ref3, pair, p3.dt!, 200)
  check('三维：200 步后温度差', Math.abs((await gpu3.reduce(['scalars'])).scalars!.temperature - scalars(ref3).temperature), 2e-3)
  gpu3.dispose()

  const big3 = new MdGpuBackend(gpu, { ...p3, nx: 128 }, 1)
  await big3.reduce([])
  const t3 = performance.now()
  for (let i = 0; i < 50; i++) {
    big3.step(4)
    await big3.idle()
  }
  check(`三维 ${big3.n} 粒子：每步毫秒`, (performance.now() - t3) / 200, null)
  check(`三维 ${big3.n} 粒子：邻居表溢出`, (await big3.reduce(['scalars'])).overflow ? 1 : 0, 0)
  big3.dispose()

  // 三维的壁面与选区：y 方向不取最小像；选区是矩形沿 z 贯穿盒子的柱体。
  // Walls and a region in 3D: no minimum image along y; the region is a rectangle extruded through the box along z.
  const pw: Params = { ...p3, walls: 1, drive: 0 }
  const refW = initFcc({ cells: fccCells(pw.nx!), density: 0.8, temperature: 1.5, seed: 1 }, pair)
  refW.walls = true
  refW.wallTemperature = refW.wallTemperatureFar = 1.5
  computeForces(refW, pair)
  step(refW, pair, pw.dt!, 200)
  for (let k = 0; k < refW.pos.length; k++) {
    refW.pos[k] = Math.fround(refW.pos[k]!)
    refW.vel[k] = Math.fround(refW.vel[k]!)
  }
  computeForces(refW, pair)
  const gpuW = new MdGpuBackend(gpu, pw, 1)
  gpuW.writeState(refW.pos, refW.vel)
  const stateW = await gpuW.readState()
  let fmaxW = 0
  let ferrW = 0
  for (let i = 0; i < refW.n; i++) {
    for (let d = 0; d < 3; d++) {
      fmaxW = Math.max(fmaxW, Math.abs(refW.force[3 * i + d]!))
      ferrW = Math.max(ferrW, Math.abs(refW.force[3 * i + d]! - stateW.force[4 * i + d]!))
    }
  }
  check('三维壁面：受力最大误差 / 最大受力', ferrW / fmaxW, 1e-4)
  const column: [number, number, number, number] = [0.2 * refW.box[0]!, 0.1 * refW.box[1]!, 0.7 * refW.box[0]!, 0.6 * refW.box[1]!]
  const regionW = (await gpuW.reduce(['scalars', 'speedHist'], column)).region!
  const regionWRef = regionFrame(refW, column, [], 4)
  check('三维选区：粒子数差', Math.abs(regionW.n - regionWRef.n), 0)
  check('三维选区：密度相对误差', Math.abs(regionW.density / regionWRef.density - 1), 1e-6)
  check('三维选区：温度相对误差', Math.abs(regionW.temperature / regionWRef.temperature - 1), 1e-5)
  check('三维选区：配位数差', Math.abs(regionW.coordination - regionWRef.coordination), 1e-6)
  // 再走八千步（初始晶格熔化会使气体变冷，要等壁面把温度带回来）：粒子都留在两壁之间，
  // 壁面重新发射的速度在 z 方向上也是热的。
  // Run eight thousand more steps (melting the initial lattice cools the gas, and the walls need
  // time to bring it back): every particle stays between the walls, and the velocities the walls
  // re-emit are thermal along z as well.
  for (let i = 0; i < 1000; i++) {
    gpuW.step(8)
    await gpuW.idle()
  }
  const afterW = await gpuW.readState()
  let outside = 0
  let vx2 = 0
  let vz2 = 0
  for (let i = 0; i < gpuW.n; i++) {
    outside += afterW.pos[4 * i + 1]! < 0 || afterW.pos[4 * i + 1]! >= refW.box[1]! ? 1 : 0
    vx2 += afterW.vel[4 * i]! ** 2 / gpuW.n
    vz2 += afterW.vel[4 * i + 2]! ** 2 / gpuW.n
  }
  check('三维壁面：跑出两壁之间的粒子数', outside, 0)
  check('三维壁面：z 方向的 ⟨v²⟩ 与壁面温度的相对差', Math.abs(vz2 / 1.5 - 1), 0.1)
  check('三维壁面：z 与 x 方向 ⟨v²⟩ 的相对差', Math.abs(vz2 / vx2 - 1), 0.1)
  gpuW.dispose()

  // 管道里的圆盘障碍物：圆盘的排斥力与壁面（y 方向不取最小像）。
  // A disc obstacle in the channel: the disc's repulsion, and walls (no minimum image along y).
  const po: Params = { ...p, walls: 1, obstacle: 5, nx: 60, density: 0.7 }
  const refO = initTriangular(
    { nx: 60, density: 0.7, temperature: 1, seed: 1, aspect: 4, obstacle: { fx: 0.25, fy: 0.5, r: 5 } },
    pair,
  )
  refO.walls = true
  computeForces(refO, pair)
  step(refO, pair, po.dt!, 200)
  for (let k = 0; k < refO.pos.length; k++) {
    refO.pos[k] = Math.fround(refO.pos[k]!)
    refO.vel[k] = Math.fround(refO.vel[k]!)
  }
  computeForces(refO, pair)
  const gpuO = new MdGpuBackend(gpu, po, 1)
  check('圆盘：粒子数差', Math.abs(gpuO.n - refO.n), 0)
  gpuO.writeState(refO.pos, refO.vel)
  const stateO = await gpuO.readState()
  let fmaxO = 0
  let ferrO = 0
  for (let i = 0; i < refO.n; i++) {
    for (let d = 0; d < 2; d++) {
      fmaxO = Math.max(fmaxO, Math.abs(refO.force[2 * i + d]!))
      ferrO = Math.max(ferrO, Math.abs(refO.force[2 * i + d]! - stateO.force[4 * i + d]!))
    }
  }
  check('圆盘与壁面：受力最大误差 / 最大受力', ferrO / fmaxO, 1e-4)
  const frameO = await gpuO.reduce(['scalars', 'field'])
  check('圆盘：势能相对误差', Math.abs(frameO.scalars!.pe - scalars(refO).pe) / Math.abs(scalars(refO).pe), 1e-4)
  check('矩形场网格：粒子总数差', Math.abs(frameO.field!.count.reduce((a, c) => a + c, 0) - refO.n), 0)
  gpuO.dispose()

  // 带非互易矩阵的双组分混合物会用到每一张粒子对参数表。
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

  // Ising：每次翻转判定都是整数运算，所以两边的晶格必须完全一致。
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
  // 有效信息用的转移计数：两边从同一状态各走一次扫描，计数必须完全相同。
  // Transition counts for effective information: both sides take one sweep from the same
  // state, so the counts must be identical.
  const cpuCounts = isingCpu.reduce(['transitions']).transitions!
  const gpuCounts = (await isingGpu.reduce(['transitions'])).transitions!
  let countDiff = 0
  cpuCounts.forEach((counts, k) => counts.forEach((c, i) => (countDiff += Math.abs(c - gpuCounts[k]![i]!))))
  check(`Ising ${cpuCounts.length} 层转移计数差`, countDiff, 0)
  isingGpu.dispose()

  // 三维 Ising：同样要求逐位一致。
  // 3D Ising: bit-for-bit agreement is required here too.
  const ip3: Params = { ...defaults(ISING_KNOBS), dim: 3, L3: 5, T: 4.4, h: 0.03 }
  const ising3Cpu = new Ising3dCpuBackend(ip3, 7)
  const ising3Gpu = new Ising3dGpuBackend(gpu, ip3, 7)
  for (let i = 0; i < 4; i++) {
    ising3Cpu.step(5)
    ising3Gpu.step(5)
    await ising3Gpu.idle()
  }
  const gpuSpins3 = await ising3Gpu.readSpins()
  let mismatched3 = 0
  for (let i = 0; i < gpuSpins3.length; i++) mismatched3 += gpuSpins3[i] === ising3Cpu.state.spins[i] ? 0 : 1
  check('三维 Ising 20 次扫描后不一致的自旋数', mismatched3, 0)
  const cpuLevels3 = ising3Cpu.reduce().levels
  const gpuLevels3 = (await ising3Gpu.reduce()).levels
  let levelDiff3 = 0
  cpuLevels3.forEach((l, k) => (levelDiff3 += Math.abs(l.m - gpuLevels3[k]!.m) + Math.abs(l.nn - gpuLevels3[k]!.nn)))
  check(`三维 Ising ${cpuLevels3.length} 层金字塔统计量差`, levelDiff3, 0)
  ising3Gpu.dispose()

  // Potts：同样要求逐位一致，取状态数最多、提议分支最多的 q = 8 和最少的 q = 2。
  // Potts: bit-for-bit agreement again, at q = 8 (most states and proposal branches) and q = 2 (fewest).
  for (const q of [8, 2]) {
    const pp: Params = { ...defaults(POTTS_KNOBS), q, L: 7, tau: 0.98, start: 0 }
    const pottsCpu = new PottsCpuBackend(pp, 5)
    const pottsGpu = new PottsGpuBackend(gpu, pp, 5)
    for (let i = 0; i < 4; i++) {
      pottsCpu.step(8)
      pottsGpu.step(8)
      await pottsGpu.idle()
    }
    const gpuStates = await pottsGpu.readSpins()
    let mismatchedStates = 0
    for (let i = 0; i < gpuStates.length; i++) mismatchedStates += gpuStates[i] === pottsCpu.state.spins[i] ? 0 : 1
    check(`Potts q=${q} 32 次扫描后不一致的格点数`, mismatchedStates, 0)
    const cpuFrame = pottsCpu.reduce()
    const gpuFrame = await pottsGpu.reduce()
    let pottsDiff = 0
    cpuFrame.levels.forEach((l, k) => (pottsDiff += Math.abs(l.order - gpuFrame.levels[k]!.order) + Math.abs(l.like - gpuFrame.levels[k]!.like)))
    cpuFrame.fractions.forEach((f, k) => (pottsDiff += Math.abs(f - gpuFrame.fractions[k]!)))
    check(`Potts q=${q} ${cpuFrame.levels.length} 层金字塔统计量差`, pottsDiff, 0)
    pottsGpu.dispose()
  }

  // 引力：先用直接求和计算加速度和势，再跑一段短轨迹。
  // Gravity: accelerations and potentials by direct summation, then a short trajectory.
  const gp: Params = { ...defaults(GRAVITY_KNOBS), n: 10, virial0: 0.5, eps: 0.03 }
  const gravRef = uniformSphere(1024, 0.5, 0.03, 1)
  const gravGpu = new GravityGpuBackend(gpu, gp, 1)
  gravGpu.step(1)
  leapfrog(gravRef, 0.03, gp.dt!, 1)
  const gravAcc = await gravGpu.readAccelerations()
  let amax = 0
  let aerr = 0
  for (let i = 0; i < gravRef.n; i++) {
    for (let d = 0; d < 3; d++) {
      amax = Math.max(amax, Math.abs(gravRef.acc[3 * i + d]!))
      aerr = Math.max(aerr, Math.abs(gravRef.acc[3 * i + d]! - gravAcc[4 * i + d]!))
    }
  }
  check('引力：加速度最大误差 / 最大加速度', aerr / amax, 1e-4)
  const gravFrame = await gravGpu.reduce()
  const gravSc = gravityScalars(gravRef)
  check('引力：动能相对误差', Math.abs(gravFrame.ke - gravSc.ke) / gravSc.ke, 1e-4)
  check('引力：势能相对误差', Math.abs(gravFrame.pe - gravSc.pe) / Math.abs(gravSc.pe), 1e-4)
  check('引力：束缚部分位力比差', Math.abs(gravFrame.virialBound - gravSc.virialBound), 1e-3)
  check('引力：束缚比例差', Math.abs(gravFrame.boundFraction - gravSc.boundFraction), 0)
  for (let i = 0; i < 100; i++) {
    gravGpu.step(4)
    await gravGpu.idle()
  }
  check('引力 400 步能量相对漂移', Math.abs((await gravGpu.reduce()).drift), 1e-2)
  gravGpu.dispose()

  // 粒子网格法：初始加速度（一次完整的分配、FFT、差分、插值），再跑一段。
  // Particle mesh: the initial accelerations (one full deposit, FFT, difference and interpolation), then a short run.
  for (const initial of [1, 0]) {
    const mp2: Params = { ...defaults(MESH_KNOBS), initial, side: 5, grid: 5, amplitude: 0.05 }
    const meshRef = initMesh(32, 32, initial, 0.05, 3)
    const meshGpu = new MeshGpuBackend(gpu, mp2, 3)
    const mesh0 = await meshGpu.readState()
    let meshMax = 0
    let meshErr = 0
    for (let i = 0; i < meshRef.n; i++) {
      for (let d = 0; d < 3; d++) {
        meshMax = Math.max(meshMax, Math.abs(meshRef.acc[3 * i + d]!))
        meshErr = Math.max(meshErr, Math.abs(meshRef.acc[3 * i + d]! - mesh0.acc[4 * i + d]!))
      }
    }
    const kind = initial ? '随机场' : '平面波'
    check(`粒子网格（${kind}）：加速度最大误差 / 最大加速度`, meshErr / meshMax, 2e-3)
    for (let i = 0; i < 25; i++) {
      meshGpu.step(4)
      await meshGpu.idle()
    }
    meshStep(meshRef, mp2.dt!, 100)
    const meshFrame = await meshGpu.reduce()
    const meshSc = meshScalars(meshRef)
    check(`粒子网格（${kind}）：100 步后动能相对误差`, Math.abs(meshFrame.ke / meshSc.ke - 1), 5e-3)
    check(`粒子网格（${kind}）：100 步后势能相对误差`, Math.abs(meshFrame.pe / meshSc.pe - 1), 5e-3)
    check(`粒子网格（${kind}）：100 步后 σ 相对误差`, Math.abs(meshFrame.sigma / meshSc.sigma - 1), 5e-3)
    check(`粒子网格（${kind}）：100 步后基频模幅度差`, Math.abs(meshFrame.mode - meshSc.mode), 1e-4)
    check(`粒子网格（${kind}）：总动量`, meshFrame.momentum, 1e-5)
    meshGpu.dispose()
  }

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
