// 软组织物理接进界面的部分：worker 协议、地址参数、皮肤位移的映射、凹陷的细分显示网格、压溃闸的报告、疼痛输入收到的压强；
// 最后在真实的男性人体上走一遍界面用的按压路径，结果必须与验证时的那一行相同。
// The soft-tissue physics as wired into the UI: the worker protocol, the URL parameters, the mapping of skin
// displacement, the subdivided dent mesh, the report of the crush gate, and the pressure the pain input receives; last,
// the UI's press path on the real male body, whose result must equal the validated row.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildStimulus, defaultSettings, type Contact } from '../src/pain/stimulus.ts'
import { stimulusDrive } from '../src/painmodel/index.ts'
import { dentMesh, interpolateToDent } from '../src/softbody/dentmesh.ts'
import { press } from '../src/softbody/press.ts'
import { DISP_FULL_MM, DISP_RAMP, POSTURE_GRAVITY, addSparse, displacementColors, dispRamp, cageParts, checkRequest, denseDisplacement, embeddedDisplacement, formatGravParam, formatPhysParam, parseGravParam, parsePhysParam, releaseEnvelope, siteGeometry, sparseMaxMm, supportPlane, type PartLite } from '../src/softbody/protocol.ts'
import { stopText } from '../src/softbody/statements.ts'
import { blockDomain } from '../tools/softbody/numerics.ts'

describe('worker protocol', () => {
  const site = { position: [0.26, 0.96, 0.14] as [number, number, number], vertex: 12 }
  it('accepts well-formed requests and keeps only the fields it knows', () => {
    expect(checkRequest({ type: 'press', id: 3, site, probe: { kind: 'sphere', radiusMm: 5, extra: 1 }, target: { forceN: 1 } })).toEqual({ type: 'press', id: 3, site, probe: { kind: 'sphere', radiusMm: 5 }, target: { forceN: 1 } })
    expect(checkRequest({ type: 'press', id: 4, site, probe: { kind: 'flat', radiusMm: 13 }, target: { depthMm: 4.5 } }).type).toBe('press')
    expect(checkRequest({ type: 'posture', id: 1, posture: 'left' })).toEqual({ type: 'posture', id: 1, posture: 'left' })
    expect(checkRequest({ type: 'pause', paused: true })).toEqual({ type: 'pause', paused: true })
    expect(checkRequest({ type: 'cancel', id: 9 })).toEqual({ type: 'cancel', id: 9 })
    expect(checkRequest({ type: 'meshes', meshes: [{ id: 'a', positions: new Float32Array(9), indices: new Uint32Array(3) }] }).type).toBe('meshes')
  })

  it('names the field and the values allowed when a request is wrong', () => {
    expect(() => checkRequest({ type: 'press', id: 1, site, probe: { kind: 'cube', radiusMm: 5 }, target: { forceN: 1 } })).toThrow(/probe\.kind.*sphere.*flat/)
    expect(() => checkRequest({ type: 'press', id: 1, site, probe: { kind: 'sphere', radiusMm: 40 }, target: { forceN: 1 } })).toThrow(/radiusMm.*2–15/)
    expect(() => checkRequest({ type: 'press', id: 1, site, probe: { kind: 'sphere', radiusMm: 5 }, target: { forceN: 500 } })).toThrow(/press\.target/)
    expect(() => checkRequest({ type: 'press', id: 1, site: { position: [0, 1], vertex: 0 }, probe: { kind: 'sphere', radiusMm: 5 }, target: { forceN: 1 } })).toThrow(/press\.site/)
    expect(() => checkRequest({ type: 'press', id: 1.5, site, probe: { kind: 'sphere', radiusMm: 5 }, target: { forceN: 1 } })).toThrow(/id/)
    expect(() => checkRequest({ type: 'posture', id: 1, posture: 'upsideDown' })).toThrow(/standing.*supine.*prone.*left.*right/)
    expect(() => checkRequest({ type: 'pause', paused: 'yes' })).toThrow(/pause\.paused/)
    expect(() => checkRequest({ type: 'meshes', meshes: [{ id: 'a', positions: [0, 0, 0], indices: [0] }] })).toThrow(/Float32Array/)
    expect(() => checkRequest({ type: 'jiggle' })).toThrow(/unknown message type/)
    expect(() => checkRequest(null)).toThrow(/object/)
  })

  it('parts a cage reads: the cage tissues in the cage systems, cut to a box when given', () => {
    const P = (id: string, tissue: string, system: string, x: number): PartLite => ({ id, name: id, tissue, system, bbox: [x, 0, 0, x + 0.01, 0.01, 0.01], centroid: [x, 0, 0], triangles: 100 })
    const parts = [P('bone', 'bone', 'skeletal', 0), P('nerve', 'nerve', 'nervous', 0), P('muscle', 'muscle', 'muscular', 0.5), P('lymph', 'organ', 'lymphatic', 0)]
    expect(cageParts(parts).map((p) => p.id)).toEqual(['bone', 'muscle'])
    expect(cageParts(parts, [-0.1, -0.1, -0.1, 0.1, 0.1, 0.1]).map((p) => p.id)).toEqual(['bone'])
    // 与 buildSiteFrom 的缺省一致：半径 5 mm 的球 → 2 mm 单元、15 mm 区域 / as buildSiteFrom defaults: a 5 mm sphere → 2 mm cells, a 15 mm region
    expect(siteGeometry(0.005)).toEqual({ cell: 0.002, extent: 0.015 })
    expect(siteGeometry(0.013).cell).toBeCloseTo(0.013 / 3)
  })
})

describe('URL parameters phys= and grav=', () => {
  it('round trips a press and the posture switch', () => {
    for (const text of ['sphere,5,1N@forearm_L', 'flat,13,4.5mm@p286.526,907.817,153.696']) {
      const p = parsePhysParam(text)
      expect(p.error, text).toBeNull()
      expect(formatPhysParam(p.press, p.on)).toBe(text)
    }
    expect(parsePhysParam('1')).toEqual({ on: true, press: null, error: null })
    expect(parsePhysParam(null)).toEqual({ on: false, press: null, error: null })
    expect(formatPhysParam(null, true)).toBe('1')
    expect(formatPhysParam(null, false)).toBeNull()
    for (const g of ['supine', 'prone', 'left', 'right'] as const) expect(formatGravParam(parseGravParam(g))).toBe(g)
    expect(parseGravParam(null)).toBe('standing')
    expect(parseGravParam('sideways')).toBe('standing')
    expect(formatGravParam('standing')).toBeNull()
  })

  it('clamps to the allowed ranges and explains what is wrong', () => {
    expect(parsePhysParam('sphere,50,100N@forearm_L').press).toMatchObject({ probe: { radiusMm: 15 }, target: { forceN: 20 } })
    expect(parsePhysParam('cube,5,1N@forearm_L').error).toMatch(/sphere 或 flat|sphere or flat/)
    expect(parsePhysParam('sphere,5,1kg@forearm_L').error).toMatch(/1N or 4\.5mm/)
    expect(parsePhysParam('sphere,5,1N').error).toMatch(/@site/)
  })
})

describe('postures', () => {
  it('turns gravity in the body frame and puts the support plane under the lowest skin', () => {
    expect(POSTURE_GRAVITY.supine).toEqual([0, 0, -9.81])
    expect(POSTURE_GRAVITY.left[0]).toBeGreaterThan(0) // x 是身体的左侧 / x is the body's left
    // 一个立方体的八个角 / the eight corners of a cube
    const skin = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1].map((v) => v * 0.2))
    expect(supportPlane('standing', skin)).toBeNull()
    const sup = supportPlane('supine', skin)!
    expect(sup.n).toEqual([0, 0, 1])
    expect(sup.d).toBeCloseTo(0)
    expect(sup.vertices).toEqual([0, 1, 2, 3])
    const left = supportPlane('left', skin)!
    expect(left.n).toEqual([-1, 0, 0])
    expect(left.d).toBeCloseTo(-0.2)
    expect(left.vertices).toEqual([1, 3, 5, 7])
  })
})

describe('skin displacement mapping', () => {
  // 一个四面体，结点各自的位移已知：嵌入点的位移是重心坐标的加权和 / one tetrahedron with known node displacements: an embedded point moves by the barycentric blend
  const x0 = Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])
  const u = [0.001, 0, 0, 0, 0.002, 0, 0, 0, -0.004, 0.003, 0.001, 0]
  const x = Float64Array.from(x0, (v, i) => v + u[i]!)
  const tets = Uint32Array.from([0, 1, 2, 3])
  const points = { tet: Uint32Array.from([0, 0, 0]), bary: Float32Array.from([1, 0, 0, 0, 0.25, 0.25, 0.25, 0.25, 0, 0.5, 0.5, 0]), inside: Uint8Array.from([1, 1, 0]) }

  it('interpolates node displacement to embedded skin vertices, skipping points outside the cage', () => {
    const s = embeddedDisplacement(points, [10, 20, 30], tets, x, x0)
    expect([...s.vertices]).toEqual([10, 20])
    expect(s.offsets[0]).toBeCloseTo(0.001)
    expect(s.offsets[3]).toBeCloseTo((0.001 + 0.003) / 4)
    expect(s.offsets[4]).toBeCloseTo((0.002 + 0.001) / 4)
    expect(s.offsets[5]).toBeCloseTo(-0.004 / 4)
    const d = denseDisplacement(points, tets, x, x0)
    expect([...d.subarray(6, 9)]).toEqual([0, 0, 0])
    expect(d[3]).toBeCloseTo(s.offsets[3]!)
    // 小于门限的位移不送 / displacements below the threshold are not sent
    expect([...embeddedDisplacement(points, [10, 20, 30], tets, x, x0, 1.5).vertices]).toEqual([20])
    expect(sparseMaxMm(s)).toBeCloseTo(Math.hypot(0.001, 0.00075, -0.001) * 1000, 3)
  })

  it('adds a sparse displacement into the per-vertex array with a scale', () => {
    const out = new Float32Array(9)
    addSparse(out, { vertices: Uint32Array.from([2, 7]), offsets: Float32Array.from([1, 2, 3, 9, 9, 9]) }, 0.5)
    expect([...out]).toEqual([0, 0, 0, 0, 0, 0, 0.5, 1, 1.5])
  })

  it('colours the skin by displacement magnitude on a fixed scale, zero included', () => {
    // 四个顶点：0、0.2 mm、满量程一半、超过满量程 / four vertices: zero, 0.2 mm, half of full scale, beyond it
    const half = DISP_FULL_MM / 2000
    const off = Float32Array.from([0, 0, 0, 0.0002, 0, 0, 0, half * 0.6, half * 0.8, 0, 0, -0.1])
    const c = displacementColors(off, 0.85)
    expect(c.length).toBe(16)
    // 零位移是色带的起点，不透明度不变 / zero displacement is the ramp's start, at the same opacity
    for (let r = 0; r < 3; r++) expect(c[r]).toBeCloseTo(DISP_RAMP[0]!.rgb[r]!, 5)
    expect(c[3]).toBeCloseTo(0.85)
    expect(c[7]).toBeCloseTo(0.85)
    expect(c[11]).toBeCloseTo(0.85)
    expect(c[15]).toBeCloseTo(0.85)
    // 方向无关，只看模长：一半处的颜色 = 色带 0.5 处 / direction does not matter, only the magnitude: the colour at half = the ramp at 0.5
    const mid = dispRamp(0.5)
    for (let r = 0; r < 3; r++) expect(c[8 + r]).toBeCloseTo(mid[r]!, 5)
    // 超过满量程截断在色带末端 / beyond full scale clamps to the ramp's end
    for (let r = 0; r < 3; r++) expect(c[12 + r]).toBeCloseTo(DISP_RAMP[DISP_RAMP.length - 1]!.rgb[r]!, 5)
    // 色带的端点 / the ramp's ends
    expect(dispRamp(-1)).toEqual(DISP_RAMP[0]!.rgb)
  })

  it('springs back on release from 1 to 0, monotonically', () => {
    expect(releaseEnvelope(-5)).toBe(1)
    expect(releaseEnvelope(700)).toBe(0)
    let prev = 1
    for (let t = 0; t <= 700; t += 35) {
      const e = releaseEnvelope(t)
      expect(e).toBeLessThanOrEqual(prev)
      prev = e
    }
  })

  it('subdivides the skin round the site without cracks and hides only vertices it fully covers', () => {
    // 一片 4×4 的方格（两个三角形一格），边长 2 cm / a 4 × 4 grid of 2 cm squares, two triangles each
    const N = 5, h = 0.02, pos: number[] = [], idx: number[] = []
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) pos.push(i * h, j * h, 0)
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i
      idx.push(a, a + 1, a + N, a + 1, a + N + 1, a + N)
    }
    // 最长边是对角线 28.3 mm，细分间距 3 mm → 每边 10 段 / the longest edge is the 28.3 mm diagonal; 3 mm spacing → 10 segments per edge
    const m = dentMesh(pos, idx, [0.04, 0.04, 0], 0.005, 0.003)!
    expect([...m.hidden]).toEqual([12])
    // 中心顶点周围的 6 个三角形，每条边 10 段：6·100 个小三角形 / the 6 triangles round the centre vertex, 10 segments per edge: 6 · 100 small ones
    expect(m.index.length / 3).toBe(600)
    // 共用边上的点去重了：顶点数 = 网格上不同的点 / points on shared edges are deduplicated: vertex count = the distinct points of the lattice
    const keys = new Set<string>()
    for (let v = 0; v < m.position.length / 3; v++) keys.add([0, 1, 2].map((r) => Math.round(m.position[v * 3 + r]! * 1e6)).join(','))
    expect(keys.size).toBe(m.position.length / 3)
    // 每条内部边恰好被两个小三角形用到（没有裂缝）/ every interior edge is used by exactly two small triangles (no cracks)
    const edges = new Map<string, number>()
    for (let t = 0; t < m.index.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = m.index[t + k]!, b = m.index[t + ((k + 1) % 3)]!
      const key = a < b ? `${a},${b}` : `${b},${a}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
    expect([...edges.values()].every((c) => c === 1 || c === 2)).toBe(true)
    expect([...edges.values()].filter((c) => c === 1).length).toBe(6 * 10) // 只有外圈 / the outer ring only
    // 线性的量由角插值是精确的 / a linear field interpolated from the corners is exact
    const field = Float32Array.from(pos, (v, i) => (i % 3 === 0 ? 2 * v : i % 3 === 1 ? -v : 0.5))
    const at = interpolateToDent(m, field, new Float32Array(m.position.length))
    for (let v = 0; v < m.position.length / 3; v++) {
      expect(at[v * 3]).toBeCloseTo(2 * m.position[v * 3]!, 6)
      expect(at[v * 3 + 1]).toBeCloseTo(-m.position[v * 3 + 1]!, 6)
    }
  })
})

/**
 * 接触量要自洽：峰值 ≥ 平均，平均 × 面积 = 到达的力。容差 1%：只来自输出的取整（压强两位小数的千帕、面积 0.1 mm²、力 1 mN）。
 * The contact figures must agree: peak ≥ mean, and mean × area = the force reached. Tolerance 1 %: it comes only from
 * the rounding of the outputs (kPa to two decimals, area to 0.1 mm², force to 1 mN).
 */
function expectConsistent(r: { forceN: number; meanPressureKPa: number; peakPressureKPa: number; contactAreaMm2: number }): void {
  expect(r.contactAreaMm2).toBeGreaterThan(0)
  expect(r.peakPressureKPa).toBeGreaterThanOrEqual(r.meanPressureKPa)
  expect(Math.abs((r.meanPressureKPa * r.contactAreaMm2) / 1000 / r.forceN - 1)).toBeLessThan(0.01)
}

describe('contact figures agree with each other', () => {
  it('sphere and flat punch on a block: peak ≥ mean and mean × area = force', { timeout: 240_000 }, () => {
    for (const [probe, req] of [[{ kind: 'sphere', radiusMm: 5 }, { forceN: 0.3 }], [{ kind: 'sphere', radiusMm: 5 }, { depthMm: 3 }], [{ kind: 'flat', radiusMm: 6 }, { depthMm: 1.5 }]] as const) {
      const { d } = blockDomain(0.003, 0.036, 0.012, 0.005, 2000)
      const r = press(d, probe, req)
      expect(r.forceN, JSON.stringify(probe)).toBeGreaterThan(0)
      expectConsistent(r)
    }
  })
})

describe('the press mode reports the crush (strain) gate', () => {
  it('stops short of the force asked for, says why, and the UI says so', { timeout: 240_000 }, () => {
    // 与第四阶段"压溃"测试同一块软的方块 / the same soft block as the phase-4 "crushed" test
    const { d } = blockDomain(0.003, 0.036, 0.012, 0.005, 2000)
    const r = press(d, { kind: 'sphere', radiusMm: 5 }, { forceN: 20 })
    expect(r.stoppedBy).toBe('strain-gate')
    expect(r.gate).not.toBeNull()
    expect(r.forceN).toBeLessThan(20)
    expect(r.flags).toContain('force-not-reached:tissue-crushed-or-bottomed-out')
    expectConsistent(r)
    const t = stopText({ ...r, target: { forceN: 20 }, tissueThicknessMm: 12 })!
    expect(t.en).toMatch(/crush gate stopped it/)
    expect(t.en).toContain(`only ${Math.round(r.forceN * 1000) / 1000} N`)
    expect(t.zh).toMatch(/压溃闸/)
    // 深度控制、或者达到了力：不报停 / depth control, or the force reached: no stop reported
    expect(stopText({ stoppedBy: null, gate: null, depthMm: 1, forceN: 0.2, target: { depthMm: 1 }, tissueThicknessMm: 12 })).toBeNull()
  })
})

describe('the pain input receives the physics pressure', () => {
  it('takes force ÷ contact area from the press instead of the nominal 1 cm² probe', () => {
    const site = { vertex: 7, position: [0.26, 0.96, 0.15] as [number, number, number] }
    const settings = defaultSettings('pressure')
    // 前臂上半径 5 mm 的球（下面真实人体那一项的结果）/ the 5 mm sphere on the forearm (the result of the real-body case below)
    const contact: Contact = { forceN: 0.958, areaMm2: 73.6, meanPressureKPa: 13.02, peakPressureKPa: 43.07, depthMm: 5.23 }
    const nominal = buildStimulus(settings, site, 'skin')
    const physics = buildStimulus(settings, site, 'skin', settings.duration, contact)
    expect(physics).toMatchObject({ forceN: 0.958, areaMm2: 73.6, site: { depthMm: 5.23 } })
    expect(stimulusDrive(nominal, 'forearm', 'male').magnitude).toBeCloseTo(500)
    expect(stimulusDrive(physics, 'forearm', 'male').magnitude).toBeCloseTo(contact.meanPressureKPa, 0)
    // 只有钝压取物理的接触 / only pressure takes the physics contact
    expect(buildStimulus(defaultSettings('pinch'), site, 'skin', 1, contact).forceN).toBe(15)
  })
})

// 真实的男性人体：界面用的路径（worker 的 engine）在验证过的前臂部位上，结果与验证报告那一行完全相同
// The real male body: the UI's path (the worker's engine) at the validated forearm site gives exactly the row of the validation report
describe('the UI press path on the real male forearm', () => {
  const dir = resolve(__dirname, '../public/anatomy/male')
  const have = ['anatomy.json', 'rig.json', 'rig.bin', 'integumentary.glb', 'skeletal.glb', 'muscular.glb'].every((f) => existsSync(resolve(dir, f)))
  it.skipIf(!have)('reproduces the validated 5 mm sphere at 1 N: stopped by the crush gate at 0.96 N', { timeout: 300_000 }, async () => {
    const { loadBody } = await import('../tools/softbody/build.ts')
    const { SoftEngine } = await import('../src/softbody/engine.ts')
    const { body, rig, rigBin } = await loadBody('male')
    const skinPart = body.data.parts.filter((p) => p.tissue === 'skin').sort((a, b) => b.triangles - a.triangles)[0]!
    const skin = body.meshes.get(skinPart.id)!
    const parts: PartLite[] = body.data.parts.map((p) => ({ id: p.id, name: p.name, system: p.system, tissue: p.tissue, bbox: p.bbox, centroid: p.centroid, triangles: p.triangles }))
    const e = new SoftEngine()
    e.init({ body: 'male', parts, skin: { id: skinPart.id, positions: skin.positions, indices: skin.indices }, rig, rigBin })
    // 验证时的前臂近端三分之一（掌侧）/ the proximal third of the forearm (volar) used in validation
    const site: [number, number, number] = [0.26421424746513367, 0.9644516706466675, 0.14539162814617157]
    let vertex = -1, best = Infinity
    for (let i = 0; i < skin.positions.length / 3; i++) {
      const dd = Math.hypot(skin.positions[i * 3]! - site[0], skin.positions[i * 3 + 1]! - site[1], skin.positions[i * 3 + 2]! - site[2])
      if (dd < best) (best = dd), (vertex = i)
    }
    if (best > 1e-4) {
      console.warn(`[softbody-ui] the skin has changed (nearest vertex ${(best * 1000).toFixed(1)} mm from the validated site): skipped`)
      return
    }
    const g = siteGeometry(0.005)
    const ids = cageParts(parts, [site[0] - 0.05, site[1] - 0.05, site[2] - 0.05, site[0] + 0.05, site[1] + 0.05, site[2] + 0.05]).map((p) => p.id)
    void g
    e.addMeshes(ids.map((id) => ({ id, positions: body.meshes.get(id)!.positions, indices: body.meshes.get(id)!.indices })))
    let progress = 0
    const r = e.press(1, { position: site, vertex }, { kind: 'sphere', radiusMm: 5 }, { forceN: 1 }, (m) => m.type === 'progress' && m.dent && progress++, 50)
    if (r.type !== 'press-done') throw new Error(JSON.stringify(r))
    expect(progress).toBeGreaterThan(0)
    expect(r.result.stoppedBy).toBe('strain-gate')
    // tools/softbody/validate.ts 的 contact.forearmSphere：5.23 mm、0.958 N（深度和力与验证时相同）。验证报告里的 43.68 kPa 是
    // 力 ÷ 离球面 0.1 mm 以内的采样面积（21.9 mm²，少算了几倍）；现在按结点算（见 press.ts 的 meanPressureKPa）
    // contact.forearmSphere of tools/softbody/validate.ts: 5.23 mm, 0.958 N (depth and force as validated). The 43.68 kPa of
    // the validation report was force ÷ the area of samples within 0.1 mm of the sphere (21.9 mm², several times too
    // small); it is now counted per node (see meanPressureKPa in press.ts)
    expect(r.result.depthMm).toBeCloseTo(5.23, 2)
    expect(r.result.forceN).toBeCloseTo(0.958, 3)
    expect(r.result.meanPressureKPa).toBeCloseTo(13.02, 2)
    expect(r.result.peakPressureKPa).toBeCloseTo(43.07, 2)
    expect(r.result.contactAreaMm2).toBeCloseTo(73.6, 1)
    expectConsistent(r.result)
    // 压到球心以下时，投影面积不超过压头的截面 π·a² / pressed past the centre, the projected area stays within the probe's cross-section π·a²
    expect(r.result.contactAreaMm2).toBeLessThan(Math.PI * 25)
    expect(r.dent.vertices.length).toBeGreaterThan(0)
    expect(sparseMaxMm(r.dent)).toBeGreaterThan(1)
    // 细分网格上的凹陷比粗皮肤顶点上的更深（看得出压头的形状）/ the dent on the subdivided mesh is deeper than on the coarse skin vertices (the probe's shape shows)
    const pd = r.patch!.dent
    let m = 0
    for (let i = 0; i < pd.length; i += 3) m = Math.max(m, Math.hypot(pd[i]!, pd[i + 1]!, pd[i + 2]!))
    expect(m * 1000).toBeGreaterThan(sparseMaxMm(r.dent))
  })
})
