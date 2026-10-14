// 软组织求解器第四阶段：皮肤层按面积分到四面体、皮肤的混合式、子步数与刚度比、乳房体模的滑动底面和三维体位重力。
// 不读任何生成的数据。
// Phase 4 of the soft-tissue solver: the skin layer shared out by area, the skin blend, substep count against the
// stiffness ratio, and the breast phantom's sliding base and 3D posture gravity. No generated data is read.

import { describe, expect, it } from 'vitest'
import { decodeSoft, encodeSoft, solverInput } from '../src/softbody/body.ts'
import { boxLattice, locateSlot } from '../src/softbody/lattice.ts'
import { press } from '../src/softbody/press.ts'
import { lame } from '../src/softbody/solver.ts'
import { shareSkinByArea } from '../tools/softbody/cage.ts'
import { block, blockDomain } from '../tools/softbody/numerics.ts'
import { POSTURE_GRAVITY, buildPhantom, phantom } from '../tools/softbody/phantom.ts'

describe('skin layer shared out by area', () => {
  // 一块 40 × 40 × 16 mm 的格子，z = 12 mm 处铺两个大三角形（边长 30 mm，比单元粗 15 倍，像前臂上的皮肤网格）；格子比"身体"大，
  // 与笼子的做法一样（BCC 格子铺不出平的边界面）
  // a 40 × 40 × 16 mm lattice with two large triangles (30 mm edges, 15 cells long, like the skin mesh on the forearm) at
  // z = 12 mm; the lattice is larger than the "body", as the cage is (a BCC lattice cannot form a flat boundary face)
  const cell = 0.002, t = 0.00113, top = 0.012
  const { lattice, mesh } = boxLattice([0.04, 0.04, 0.016], cell)
  const slotTet = new Map<number, number>()
  mesh.slots.forEach((s, i) => slotTet.set(s, i))
  const T = mesh.tets.length / 4, tetVol = cell ** 3 / 12
  // (b − a) × (c − a) 指向 +z（体外）/ (b − a) × (c − a) points +z (outside)
  const skin = { positions: Float32Array.from([0.005, 0.005, top - 1e-7, 0.035, 0.005, top - 1e-7, 0.035, 0.035, top - 1e-7, 0.005, 0.035, top - 1e-7]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) }
  const area = 0.03 * 0.03

  it('keeps the whole skin volume, spreads it over the cells under the triangles and puts it within the skin thickness', () => {
    const vol = new Float64Array(T)
    shareSkinByArea(lattice, slotTet, skin, t, vol)
    let sum = 0, max = 0, holding = 0
    for (let e = 0; e < T; e++) {
      sum += vol[e]!
      max = Math.max(max, vol[e]! / tetVol)
      if (vol[e]! > 0) holding++
      if (vol[e]! > 0) {
        // 有皮肤的四面体都碰到顶面以下一个皮肤厚度之内 / every tetrahedron with skin reaches within one skin thickness of the top
        let zmax = -Infinity, zmin = Infinity
        for (let k = 0; k < 4; k++) (zmax = Math.max(zmax, mesh.nodes[mesh.tets[e * 4 + k]! * 3 + 2]!)), (zmin = Math.min(zmin, mesh.nodes[mesh.tets[e * 4 + k]! * 3 + 2]!))
        expect(zmax).toBeGreaterThan(top - t - 1e-9)
        expect(zmin).toBeLessThan(top)
      }
    }
    expect(sum / (area * t)).toBeCloseTo(1, 6)
    // 采样的误差让个别四面体略超过自身体积；截到 1 之后仍留下 97 % 以上 / sampling error lets a few tetrahedra hold slightly more than their volume; clipped at 1, over 97 % remains
    let kept = 0
    for (let e = 0; e < T; e++) kept += Math.min(vol[e]!, tetVol)
    expect(max).toBeLessThan(1.5)
    expect(kept / (area * t)).toBeGreaterThan(0.97)
    // 30 × 30 mm 的皮肤落在几百个四面体里（单元 2 mm）/ 30 × 30 mm of skin lands in hundreds of tetrahedra (2 mm cells)
    expect(holding).toBeGreaterThan(400)
  })

  it('the phase-3 way (all of a vertex area in the tetrahedron of the vertex) clips at 1 and loses almost all of it at this cell size', () => {
    const vol = new Float64Array(T)
    for (let v = 0; v < 4; v++) {
      const e = slotTet.get(locateSlot(lattice, skin.positions[v * 3]!, skin.positions[v * 3 + 1]!, skin.positions[v * 3 + 2]!))!
      // 两个三角形的面积按顶点平分（每个三角形三分之一）/ the two triangles' area split by vertex (a third of each triangle)
      const share = v === 0 || v === 2 ? (2 * area) / 2 / 3 : area / 2 / 3
      vol[e] = vol[e]! + share * t
    }
    let kept = 0
    for (let e = 0; e < T; e++) kept += Math.min(1, vol[e]! / tetVol) * tetVol
    expect(kept / (area * t)).toBeLessThan(0.01)
  })
})

describe('skin blend in the solver input', () => {
  /** 一个四面体的笼子：fill 和皮肤比例给定 / a one-tetrahedron cage with given fill and skin share */
  function oneTet(fill: number, skinShare: number): ReturnType<typeof decodeSoft> {
    const { lattice, mesh } = boxLattice([0.02, 0.02, 0.02], 0.01)
    const N = mesh.nodes.length / 3, T = mesh.tets.length / 4
    const { json, bin } = encodeSoft({ schema: 1, body: 'male', inputs: {}, lattice, gravity: [0, -9.81, 0], joints: ['root'], materials: [{ id: 'fat', name: { zh: '脂肪', en: 'fat' }, young: 1590, poisson: 0.49, density: 920 }, { id: 'skin', name: { zh: '皮肤', en: 'skin' }, young: 56400, poisson: 0.49, density: 1100 }], skin: { part: 'skin', thickness: 0.00113, material: 1 }, muscles: [], capsules: [], cautions: [] }, {
      nodes: mesh.nodes, tets: mesh.tets, tetSlot: mesh.slots, tetMaterial: new Uint8Array(T), tetFill: new Uint8Array(T).fill(Math.round(fill * 255)), tetSkin: new Uint8Array(T).fill(Math.round(skinShare * 255)), tetMuscle: new Uint16Array(T).fill(0xffff), nodePin: new Int16Array(N).fill(-1), nodeInfluence: new Uint8Array(N * 12), anchors: { tet: new Uint32Array(0), bary: new Float32Array(0) }, embedded: [],
    })
    return decodeSoft(JSON.parse(JSON.stringify(json)), bin)
  }

  it('is a Voigt mean by volume share: (fill − fs)·E_fat + fs·E_skin; phase 3 multiplied the skin by fill once more', () => {
    const soft = oneTet(0.5, 0.2)
    const fill = Math.round(0.5 * 255) / 255, fs = Math.round(0.2 * 255) / 255
    const now = solverInput(soft).mu[0]!, old = solverInput(soft, { skinBlend: 'phase3' }).mu[0]!
    expect(now / lame((fill - fs) * 1590 + fs * 56400, 0.49).mu).toBeCloseTo(1, 4)
    expect(old / lame(fill * ((1 - fs) * 1590 + fs * 56400), 0.49).mu).toBeCloseTo(1, 4)
    // 皮肤的部分在第三阶段少了 fill 倍 / the skin part was short by the factor fill in phase 3
    expect(now / old).toBeGreaterThan(1.8)
    // 质量里也有皮肤 / the mass includes the skin
    expect(solverInput(soft).density[0]! / ((fill - fs) * 920 + fs * 1100)).toBeCloseTo(1, 4)
  })

  it('lets the area-based skin share override the coarser nine-sample fill', () => {
    const soft = oneTet(1 / 9, 0.4)
    const fs = Math.round(0.4 * 255) / 255
    expect(solverInput(soft).mu[0]! / lame(fs * 56400, 0.49).mu).toBeCloseTo(1, 4)
  })
})

describe('substep count and the stiffness ratio', () => {
  // 自重悬臂梁：乘子每个子步从零开始，稳态按 1/(1 + Π) 偏软；99 % 分位的 Π ≤ 0.5 时误差约 2 %
  // self-weight cantilever: multipliers restart every substep and the steady state is too soft by about 1/(1 + Π); about 2 % once the 99th-percentile Π ≤ 0.5
  const tip = (sub: number): { pi: number; d: number } => {
    const h = 0.04, L = 0.24, cell = 0.01
    const b = block([Math.round(L / cell), 4, 4], cell, 20e3, 0.49, 1000, (x) => x < 1e-6, { gravity: [0, -0.5, 0], substeps: sub, damping: 8, volume: 'node' })
    const pi = b.solver.stiffnessRatio(0, 0.99) * (1 / 60 / sub) ** 2
    b.solver.settle(1 / 60, 2e-6, 8000)
    let s = 0, c = 0
    for (let i = 0; i < b.nodes.length / 3; i++) if (Math.abs(b.nodes[i * 3]! - L) < 1e-6) (s += b.solver.x[i * 3 + 1]! - b.nodes[i * 3 + 1]!), c++
    void h
    return { pi, d: -s / c }
  }

  it('predicts the softening: Π > 1 sags over 10 % too much, the count from substepsFor is within 3 %', { timeout: 120_000 }, () => {
    const ref = tip(128).d
    const few = tip(8)
    expect(few.pi).toBeGreaterThan(1)
    expect(few.d / ref).toBeGreaterThan(1.1)
    const b = block([24, 4, 4], 0.01, 20e3, 0.49, 1000, (x) => x < 1e-6, { gravity: [0, -0.5, 0], substeps: 1, volume: 'node' })
    const n = b.solver.substepsFor(1 / 60)
    const ok = tip(n)
    expect(ok.pi).toBeLessThanOrEqual(0.5 + 1e-9)
    expect(Math.abs(ok.d / ref - 1)).toBeLessThan(0.03)
  })
})

describe('breast phantom', () => {
  it('posture gravity is a 3D vector in the body frame and the tilted wall maps it into the mesh frame', () => {
    const m = buildPhantom({ volumeMl: 262, cell: 0.014, base: 'bonded', shear: 357.1, wallTiltDeg: 30 })
    // 俯卧：重力离开胸壁，网格里沿法线（+y）的分量是 cos 30° / prone: gravity leaves the wall, its normal (+y) component in the mesh is cos 30°
    const g = m.toMesh(POSTURE_GRAVITY.prone)
    expect(g[1] / 9.81).toBeCloseTo(Math.cos(Math.PI / 6), 6)
    expect(g[0] / 9.81).toBeCloseTo(-Math.sin(Math.PI / 6), 6)
    // 站立：重力沿胸壁平面向脚 / standing: gravity runs down the wall plane
    expect(m.toMesh(POSTURE_GRAVITY.standing)).toEqual([0, 0, -9.81])
    const v: [number, number, number] = [0.1, -0.2, 0.3]
    const back = m.toBody(m.toMesh(v))
    for (let k = 0; k < 3; k++) expect(back[k]!).toBeCloseTo(v[k]!, 12)
  })

  it('a sliding base lets the breast move more than a bonded one, a fascia layer sits between, and the skin holds it back', { timeout: 120_000 }, () => {
    const base = { volumeMl: 262, cell: 0.014, shear: 357.1, skin: { young: 4000, thickness: 0.002 } }
    const pairs: [import('../tools/softbody/phantom.ts').Posture, import('../tools/softbody/phantom.ts').Posture][] = [['standing', 'supine']]
    const bonded = phantom({ ...base, base: 'bonded' }, pairs).pairs[0]!
    const sliding = phantom({ ...base, base: 'sliding' }, pairs).pairs[0]!
    const fascia = phantom({ ...base, base: 'fascia', fascia: { young: 250e3, thickness: 1e-4 } }, pairs).pairs[0]!
    expect(sliding.nippleMm).toBeGreaterThan(1.5 * bonded.nippleMm)
    expect(fascia.nippleMm).toBeLessThan(sliding.nippleMm)
    expect(fascia.nippleMm).toBeGreaterThan(bonded.nippleMm)
    // 站立到仰卧，乳头主要向后（−z）、向头（+y）移动 / standing to supine moves the nipple mainly posterior (−z) and cranial (+y)
    expect(sliding.nippleVectorMm[2]).toBeLessThan(0)
    expect(sliding.nippleVectorMm[1]).toBeGreaterThan(0)
    const stiffSkin = phantom({ ...base, base: 'sliding', skin: { young: 56400, thickness: 0.00113, stiffening: 17.4 } }, pairs).pairs[0]!
    expect(stiffSkin.nippleMm).toBeLessThan(sliding.nippleMm)
  })
})

describe('press(): the crushed case', () => {
  it('bisects to the deepest depth within the strain limit instead of falling back to the last secant step', { timeout: 120_000 }, () => {
    const { d } = blockDomain(0.003, 0.036, 0.012, 0.005, 2000)
    const r = press(d, { kind: 'sphere', radiusMm: 5 }, { forceN: 20 })
    expect(r.flags).toContain('force-not-reached:tissue-crushed-or-bottomed-out')
    // 报告的状态在应变上限（0.6）之内，并且离它不远：二分了四次 / the reported state is within the strain limit (0.6) and not far below it: four bisections
    expect(r.peakStrain).toBeLessThanOrEqual(0.6)
    expect(r.peakStrain).toBeGreaterThan(0.45)
  })
})
